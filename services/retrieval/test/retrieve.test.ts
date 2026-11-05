/**
 * Retrieval against real Postgres with pgvector. Holds SPECS #3 at the
 * retrieval layer (another person's canary is never a candidate, by vector,
 * by text or fused), the scope rules (READY only, one collection, the current
 * vector space), neighbour merging on stored rows, and the abstention.
 *
 * Vectors are the fake's hash embeddings, so "similar" means "shares words"
 * here; the thresholds below are chosen for that, and the real model's
 * threshold is the eval lane's job (build step 8).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sliceCodePoints } from '@rag/chunker';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { QueryVectorError, retrieve, RETRIEVAL_MODES, type Retrieval } from '../src';
import { candidatesOf, longDocument } from '../src/fixtures';
import {
  addDocument,
  closeSupport,
  db,
  deps,
  forgetPeople,
  newCollection,
  newPerson,
  SPACE,
} from './support';

afterEach(forgetPeople);
afterAll(closeSupport);

const corpus = (path: string) =>
  readFileSync(
    join(__dirname, '..', '..', '..', 'packages', 'db', 'prisma', 'corpus', path),
    'utf8',
  );
const CANARY = 'heliotrope-4417';
/**
 * The threshold for hash embeddings, from measured best similarities over
 * the boiler and lease chunks: "sourdough starter hydration recipe" 0.068,
 * "warranty labour parts" 0.159, "boiler warranty" 0.183.
 */
const LOW = 0.12;

const everyText = (r: Retrieval) => [...r.sources, ...r.nearest].map((s) => s.text).join('\n');

describe('isolation (SPECS #3)', () => {
  it('never gives one person another’s chunk, even when asked for its exact words', async () => {
    const alma = await newPerson('alma');
    const bruno = await newPerson('bruno');
    await addDocument(alma, 'Boiler', corpus('alma/home/boiler-service-record.md'));
    await addDocument(alma, 'Lease', corpus('alma/home/lease-summary.md'));
    const cold = await addDocument(
      bruno,
      'Cold room',
      corpus('bruno/lab/cold-room-and-freezers.md'),
    );
    expect(corpus('bruno/lab/cold-room-and-freezers.md')).toContain(CANARY);

    for (const mode of RETRIEVAL_MODES) {
      const asked = await retrieve(
        deps,
        { ownerId: alma.id, query: `What is ${CANARY} for?` },
        {
          mode,
          minSimilarity: -1,
        },
      );
      expect(
        asked.candidates.some((c) => cold.chunkIds.includes(c.chunkId)),
        mode,
      ).toBe(false);
      expect(
        asked.candidates.some((c) => c.documentId === cold.id),
        mode,
      ).toBe(false);
      expect(everyText(asked), mode).not.toContain(CANARY);
    }
    // And the owner does find it: the test would pass on an empty index otherwise.
    const own = await retrieve(
      deps,
      { ownerId: bruno.id, query: `What is ${CANARY} for?` },
      {
        minSimilarity: -1,
      },
    );
    expect(everyText(own)).toContain(CANARY);
  });

  it('gives a person their own k nearest even when another person’s rows are all nearer', async () => {
    const alma = await newPerson('crowded');
    const bruno = await newPerson('crowd');
    const doc = longDocument(1, 20);
    // Bruno holds 30 copies of the passage the query is made of; Alma holds unrelated text.
    for (let i = 0; i < 30; i += 1)
      await addDocument(bruno, `copy ${String(i)}`, `${doc}\nCopy ${String(i)}.`);
    await addDocument(alma, 'Bike', corpus('alma/bike/commuter-bike-maintenance.txt'));
    const almaChunks = await db.chunk.count({ where: { ownerId: alma.id } });
    const r = await retrieve(
      deps,
      { ownerId: alma.id, query: 'valve opens when the pressure passes bar' },
      {
        mode: 'vector',
        minSimilarity: -1,
      },
    );
    expect(r.candidates).toHaveLength(Math.min(almaChunks, 40));
  });
});

describe('scope', () => {
  it('searches READY documents only: one being re-ingested or queued is not a candidate', async () => {
    const p = await newPerson('ready');
    const ready = await addDocument(p, 'Boiler', corpus('alma/home/boiler-service-record.md'));
    const busy = await addDocument(
      p,
      'Boiler copy',
      `${corpus('alma/home/boiler-service-record.md')}\nCopy.`,
      {
        status: 'EMBEDDING',
      },
    );
    const r = await retrieve(
      deps,
      { ownerId: p.id, query: 'boiler warranty' },
      { minSimilarity: LOW },
    );
    expect(new Set(r.candidates.map((c) => c.documentId))).toEqual(new Set([ready.id]));
    expect(r.candidates.some((c) => busy.chunkIds.includes(c.chunkId))).toBe(false);
  });

  it('searches one collection when asked of one, and the whole library otherwise', async () => {
    const p = await newPerson('shelves');
    const bikes = await newCollection(p.id, 'Bikes');
    const home = await addDocument(p, 'Boiler', corpus('alma/home/boiler-service-record.md'));
    const bike = await addDocument(p, 'Bike', corpus('alma/bike/commuter-bike-maintenance.txt'), {
      collectionId: bikes,
    });
    const query = 'how often is it serviced';
    const one = await retrieve(
      deps,
      { ownerId: p.id, query, collectionId: bikes },
      { minSimilarity: -1 },
    );
    expect(new Set(one.candidates.map((c) => c.documentId))).toEqual(new Set([bike.id]));
    const all = await retrieve(deps, { ownerId: p.id, query }, { minSimilarity: -1 });
    expect(new Set(all.candidates.map((c) => c.documentId))).toEqual(new Set([home.id, bike.id]));
  });

  it('searches the current vector space only, and counts the documents it cannot see', async () => {
    const p = await newPerson('space');
    const current = await addDocument(p, 'Boiler', corpus('alma/home/boiler-service-record.md'));
    // What the dev database held on 2026-11-05: chunks under the bare model name.
    const stale = await addDocument(p, 'Lease', corpus('alma/home/lease-summary.md'), {
      space: 'qwen3-embedding:0.6b',
    });
    const r = await retrieve(
      deps,
      { ownerId: p.id, query: 'rent deposit boiler' },
      { minSimilarity: -1 },
    );
    expect(r.space).toBe(SPACE);
    expect(new Set(r.candidates.map((c) => c.documentId))).toEqual(new Set([current.id]));
    expect(r.candidates.some((c) => stale.chunkIds.includes(c.chunkId))).toBe(false);
    expect(r.staleDocuments).toBe(1);
  });
});

describe('the two lists', () => {
  it('matches words by stem and by any of them, not all: an extra word does not empty the text list', async () => {
    const p = await newPerson('text');
    await addDocument(p, 'Boiler', corpus('alma/home/boiler-service-record.md'));
    const r = await retrieve(
      deps,
      { ownerId: p.id, query: 'When were the boilers last servicing, zebra?' },
      { mode: 'text' },
    );
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((c) => c.textRank !== null && c.vectorRank === null)).toBe(true);
    expect(r.abstained).toBe(false);
  });

  it('a query of stop words only matches nothing in text, and says why', async () => {
    const p = await newPerson('stop');
    await addDocument(p, 'Boiler', corpus('alma/home/boiler-service-record.md'));
    const r = await retrieve(deps, { ownerId: p.id, query: 'the and of it' }, { mode: 'text' });
    expect(r.candidates).toEqual([]);
    expect(r.reason).toBe('no_candidates');
  });

  it('fuses both: a chunk found by both lists carries both ranks', async () => {
    const p = await newPerson('hybrid');
    await addDocument(p, 'Boiler', corpus('alma/home/boiler-service-record.md'));
    const r = await retrieve(
      deps,
      { ownerId: p.id, query: 'warranty labour parts' },
      { minSimilarity: LOW },
    );
    expect(r.candidates[0]!.vectorRank).not.toBeNull();
    expect(r.candidates[0]!.textRank).not.toBeNull();
    expect(r.sources[0]!.text).toMatch(/[Ww]arranty/u);
  });
});

describe('packing on stored rows', () => {
  it('merges two selected neighbours into one source of the exact document text, with its parts', async () => {
    const p = await newPerson('merge');
    const text = longDocument(1, 45);
    const doc = await addDocument(p, 'Valves', text);
    const { text: normalised, candidates } = candidatesOf(text);
    // Words only chunks 0 and 1 share: the overlap's sentences.
    const r = await retrieve(
      deps,
      { ownerId: p.id, query: 'valve 33 opens when the pressure passes 33 bar' },
      { k: 2, minSimilarity: LOW },
    );
    const merged = r.sources.find((s) => s.chunkIds.length > 1);
    expect(merged, JSON.stringify(r.candidates.slice(0, 3))).toBeDefined();
    const [a, b] = merged!.chunkIds.map((id) => doc.chunkIds.indexOf(id));
    expect(b).toBe(a! + 1);
    expect(merged!.text).toBe(
      sliceCodePoints(normalised, candidates[a!]!.charStart, candidates[b!]!.charEnd),
    );
    // The trace gives both chunks the merged source's marker.
    const markers = r.candidates
      .filter((c) => merged!.chunkIds.includes(c.chunkId))
      .map((c) => c.marker);
    expect(markers).toEqual([merged!.marker, merged!.marker]);
  });
});

describe('abstaining', () => {
  it('says "below threshold" with the number, packs nothing for the prompt, and shows the nearest', async () => {
    const p = await newPerson('abstain');
    await addDocument(p, 'Boiler', corpus('alma/home/boiler-service-record.md'));
    await addDocument(p, 'Lease', corpus('alma/home/lease-summary.md'));
    const r = await retrieve(
      deps,
      { ownerId: p.id, query: 'sourdough starter hydration recipe' },
      {
        minSimilarity: LOW,
      },
    );
    expect(r.abstained).toBe(true);
    expect(r.reason).toBe('below_threshold');
    expect(r.bestSimilarity).not.toBeNull();
    expect(r.bestSimilarity!).toBeLessThan(LOW);
    expect(r.sources).toEqual([]);
    expect(r.nearest.length).toBeGreaterThan(0);
    expect(r.nearest.length).toBeLessThanOrEqual(3);
    expect(r.candidates.every((c) => c.marker === null)).toBe(true);
  });

  it('says "no candidates" for an empty library, with nothing to show', async () => {
    const p = await newPerson('empty');
    const r = await retrieve(deps, { ownerId: p.id, query: 'anything at all' });
    expect([r.abstained, r.reason, r.nearest.length]).toEqual([true, 'no_candidates', 0]);
  });
});

describe('inputs', () => {
  it('refuses a blank question and an id that is not one', async () => {
    const p = await newPerson('inputs');
    await expect(retrieve(deps, { ownerId: p.id, query: '   ' })).rejects.toThrow();
    await expect(retrieve(deps, { ownerId: "x' OR 1=1 --", query: 'boiler' })).rejects.toThrow();
  });

  it('refuses a query vector of the wrong width instead of searching with it', async () => {
    const p = await newPerson('width');
    await expect(
      retrieve({ ...deps, embed: async () => [[0.1, 0.2]] }, { ownerId: p.id, query: 'boiler' }),
    ).rejects.toBeInstanceOf(QueryVectorError);
  });

  it('embeds the query with the model’s instruction ("auto"), and without when told', async () => {
    const p = await newPerson('instruction');
    const seen: string[] = [];
    const spy = {
      ...deps,
      embed: async (texts: readonly string[]) => (seen.push(...texts), deps.embed(texts)),
    };
    await retrieve(spy, { ownerId: p.id, query: 'boiler' });
    await retrieve(spy, { ownerId: p.id, query: 'boiler' }, { queryInstruction: null });
    expect(seen[0]).toMatch(/^Instruct: .*\nQuery: boiler$/u);
    expect(seen[1]).toBe('boiler');
  });
});
