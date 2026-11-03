/**
 * The pipeline against real Postgres, Redis and the fake model server.
 * Holds SPECS outcome #4 (one chunk set however often a document runs) and
 * #6 (a scanned PDF ends FAILED with the spec's words), plus the retry rules.
 */
import { chunkDocument } from '@rag/chunker';
import { INGEST_FAILURES } from '@rag/shared';
import { removeStoredFile } from '@rag/shared/server';
import { UnrecoverableError } from 'bullmq';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { ingestDocument } from '../src/pipeline';
import { processor } from '../src/worker';
import { makePdf } from './pdf';
import {
  addDocument,
  chunksOf,
  closeSupport,
  config,
  db,
  deps,
  forgetPeople,
  listen,
  longMarkdown,
  newPerson,
  setFakeEmbed,
} from './support';

afterEach(async () => {
  await setFakeEmbed(null);
  await forgetPeople();
});
afterAll(closeSupport);

const encode = (s: string) => new TextEncoder().encode(s);
/** What BullMQ hands the processor on attempt `n` (1-based) of 5. */
const attempt = (data: unknown, n: number) => ({
  data,
  attemptsMade: n - 1,
  opts: { attempts: 5 },
});

describe('a markdown document', () => {
  it('ends READY with the chunker’s chunks, embedded, announced in order', async () => {
    const person = await newPerson('md');
    const text = longMarkdown(6);
    const job = await addDocument(person, 'valves.md', encode(text));
    const stream = await listen(person.id);

    const outcome = await ingestDocument(job, deps({ batchSize: 2 }));

    const expected = chunkDocument({ format: 'markdown', text }).chunks;
    expect(outcome).toEqual({ kind: 'ready', chunks: expected.length, pages: null });
    const rows = await chunksOf(job.documentId);
    expect(rows.map((r) => r.ord)).toEqual(expected.map((c) => c.ord));
    expect(rows.map((r) => r.text)).toEqual(expected.map((c) => c.text));
    expect(new Set(rows.map((r) => r.embedding_model))).toEqual(new Set([config.embedModel]));
    expect(new Set(rows.map((r) => r.dims))).toEqual(new Set([1024]));
    const doc = await db.document.findUniqueOrThrow({ where: { id: job.documentId } });
    expect({ status: doc.status, error: doc.error, pages: doc.pages }).toEqual({
      status: 'READY',
      error: null,
      pages: null,
    });

    // PARSING, EMBEDDING 0/n, one event per batch of 2, READY.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stream.stop();
    const n = expected.length;
    const batches = Math.ceil(n / 2);
    expect(stream.events.map((e) => [e.status, e.progress?.done ?? null])).toEqual([
      ['PARSING', null],
      ['EMBEDDING', 0],
      ...Array.from({ length: batches }, (_, i) => ['EMBEDDING', Math.min((i + 1) * 2, n)]),
      ['READY', null],
    ]);
    expect(stream.events.every((e) => e.collectionId === person.collectionId)).toBe(true);
  });

  it('run twice gives one chunk set, replaced rather than appended (SPECS #4)', async () => {
    const person = await newPerson('twice');
    const job = await addDocument(person, 'twice.md', encode(longMarkdown(4)));
    await ingestDocument(job, deps());
    const first = await chunksOf(job.documentId);
    await ingestDocument(job, deps());
    const second = await chunksOf(job.documentId);
    expect(second.map((r) => r.ord)).toEqual(first.map((r) => r.ord));
    expect(second.map((r) => r.text)).toEqual(first.map((r) => r.text));
    // Replaced: new rows, none of the old ones left.
    expect(second.some((r) => first.some((f) => f.id === r.id))).toBe(false);
    expect(await db.chunk.count({ where: { documentId: job.documentId } })).toBe(first.length);
  });
});

describe('a PDF', () => {
  it('keeps its pages: count on the document, a range on each chunk', async () => {
    const person = await newPerson('pdf');
    const job = await addDocument(
      person,
      'manual.pdf',
      makePdf(['The gauge reads one bar when cold.', null, 'Bleed the radiators in autumn.']),
    );
    expect(await ingestDocument(job, deps())).toMatchObject({ kind: 'ready', pages: 3 });
    const doc = await db.document.findUniqueOrThrow({ where: { id: job.documentId } });
    expect(doc.pages).toBe(3);
    const rows = await chunksOf(job.documentId);
    expect(rows[0]).toMatchObject({ page_start: 1, page_end: 3 });
  });

  it('with no text layer ends FAILED in the spec’s words, without a retry (SPECS #6)', async () => {
    const person = await newPerson('scan');
    const job = await addDocument(person, 'scan.pdf', makePdf([null, null]));
    const run = processor(deps())(attempt(job, 1));
    await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
    const doc = await db.document.findUniqueOrThrow({ where: { id: job.documentId } });
    expect({ status: doc.status, error: doc.error }).toEqual({
      status: 'FAILED',
      error: 'no text layer; OCR not supported',
    });
    expect(await db.chunk.count({ where: { documentId: job.documentId } })).toBe(0);
  });
});

describe('failures', () => {
  it('retries a model server fault and leaves the document in progress', async () => {
    const person = await newPerson('flaky');
    const job = await addDocument(person, 'flaky.md', encode('# Flaky\n\nOne passage.'));
    await setFakeEmbed({ failNext: 1 });
    const run = processor(deps())(attempt(job, 1));
    await expect(run).rejects.not.toBeInstanceOf(UnrecoverableError);
    const doc = await db.document.findUniqueOrThrow({ where: { id: job.documentId } });
    expect(doc.status).toBe('EMBEDDING');
    // The retry succeeds once the fault clears.
    await expect(processor(deps())(attempt(job, 2))).resolves.toMatchObject({ kind: 'ready' });
  });

  it('on the last attempt marks it FAILED with the model server’s reason', async () => {
    const person = await newPerson('down');
    const job = await addDocument(person, 'down.md', encode('# Down\n\nOne passage.'));
    await setFakeEmbed({ failNext: 1 });
    await expect(processor(deps())(attempt(job, 5))).rejects.toThrow();
    const doc = await db.document.findUniqueOrThrow({ where: { id: job.documentId } });
    expect(doc.error).toBe(INGEST_FAILURES.modelUnavailable);
  });

  it('a passage over the model’s context fails at once as too long', async () => {
    const person = await newPerson('long');
    const job = await addDocument(person, 'long.md', encode('# Long\n\nA passage of some length.'));
    await setFakeEmbed({ maxInputChars: 5 });
    await expect(processor(deps())(attempt(job, 1))).rejects.toBeInstanceOf(UnrecoverableError);
    const doc = await db.document.findUniqueOrThrow({ where: { id: job.documentId } });
    expect(doc.error).toBe(INGEST_FAILURES.tooLong);
  });

  it('a stored file that is missing or altered fails with a reason to upload again', async () => {
    const person = await newPerson('missing');
    const gone = await addDocument(person, 'gone.md', encode('# Gone'));
    await removeStoredFile(config.uploadDir, person.id, gone.sha256);
    await expect(processor(deps())(attempt(gone, 1))).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await db.document.findUniqueOrThrow({ where: { id: gone.documentId } })).error).toBe(
      INGEST_FAILURES.fileMissing,
    );
  });

  it('a document deleted mid-embed stays deleted and the job ends quietly', async () => {
    const person = await newPerson('deleted');
    const job = await addDocument(person, 'deleted.md', encode(longMarkdown(3)));
    const base = deps();
    const outcome = await ingestDocument(job, {
      ...base,
      embed: async (texts) => {
        await db.document.delete({ where: { id: job.documentId } });
        return base.embed(texts);
      },
    });
    expect(outcome).toEqual({ kind: 'gone' });
    expect(await db.document.count({ where: { id: job.documentId } })).toBe(0);
    expect(await db.chunk.count({ where: { documentId: job.documentId } })).toBe(0);
  });

  it('a job for bytes the row no longer holds is ignored', async () => {
    const person = await newPerson('stale');
    const job = await addDocument(person, 'stale.md', encode('# Stale'));
    const stale = { ...job, sha256: 'f'.repeat(64) };
    expect(await ingestDocument(stale, deps())).toEqual({ kind: 'gone' });
    expect((await db.document.findUniqueOrThrow({ where: { id: job.documentId } })).status).toBe(
      'QUEUED',
    );
  });
});
