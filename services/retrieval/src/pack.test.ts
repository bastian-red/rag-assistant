import { sliceCodePoints } from '@rag/chunker';
import { resolveCitations } from '@rag/citations';
import { formatSource } from '@rag/shared';
import { estimateTokens } from '@rag/chunker';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { candidatesOf, inRank, longDocument } from './fixtures';
import { mergeNeighbours, pack, select } from './pack';

const { text: docText, candidates } = candidatesOf(longDocument());
const [c0, c1, c2, c3, c4] = candidates;
const ROOMY = { k: 6, contextTokens: 100_000 };

describe('select', () => {
  it('takes the top k in fused order, skipping a chunk whose text repeats one already taken', () => {
    const copy = { ...c1!, id: 'doc-b-9', documentId: 'doc-b', text: `${c1!.text}\n` };
    const { selected, duplicates } = select(inRank([c1!, copy, c0!, c2!]), 2);
    expect(selected.map((c) => c.id)).toEqual([c1!.id, c0!.id]);
    expect(duplicates).toBe(1);
  });
});

describe('mergeNeighbours', () => {
  it('merges consecutive chunks whose spans overlap (the fixture holds that they do)', () => {
    expect(c1!.charStart).toBeLessThan(c0!.charEnd);
    expect(mergeNeighbours([c1!, c0!]).map((run) => run.map((c) => c.id))).toEqual([
      [c0!.id, c1!.id],
    ]);
  });

  it('does not merge across a section gap, whose text is in no chunk', () => {
    expect(c4!.charStart).toBeGreaterThan(c3!.charEnd);
    expect(mergeNeighbours([c3!, c4!])).toHaveLength(2);
  });

  it('does not merge chunks that are not consecutive, or of two documents', () => {
    expect(mergeNeighbours([c0!, c2!])).toHaveLength(2);
    const other = { ...c1!, documentId: 'doc-b', id: 'doc-b-1' };
    expect(mergeNeighbours([c0!, other])).toHaveLength(2);
  });

  it('does not merge rows that disagree over their overlap', () => {
    const altered = { ...c1!, text: `X${c1!.text.slice(1)}` };
    expect(mergeNeighbours([c0!, altered])).toHaveLength(2);
  });
});

describe('pack', () => {
  it('gives a merged source the exact document text over the union, and its parts', () => {
    const { sources } = pack(inRank([c1!, c0!]), ROOMY);
    expect(sources).toHaveLength(1);
    const [merged] = sources;
    expect(merged!.text).toBe(sliceCodePoints(docText, c0!.charStart, c1!.charEnd));
    expect(merged!.chunkIds).toEqual([c0!.id, c1!.id]);
    expect(merged!.parts).toEqual([
      { chunkId: c0!.id, at: 0, length: c0!.charEnd - c0!.charStart, page: null },
      {
        chunkId: c1!.id,
        at: c1!.charStart - c0!.charStart,
        length: c1!.charEnd - c1!.charStart,
        page: null,
      },
    ]);
    // Ranks as its best member (c1 was first) and keeps its best score.
    expect(merged!.fused).toBe(1 / 61);
  });

  it('numbers sources 1..n in rank order, a merged run ranking as its best member', () => {
    const { sources } = pack(inRank([c4!, c2!, c0!, c3!]), ROOMY);
    // c2 and c3 merge (ranked 2nd and 4th), c4 stays alone (1st), c0 alone (3rd).
    expect(sources.map((s) => [s.marker, s.chunkIds])).toEqual([
      [1, [c4!.id]],
      [2, [c2!.id, c3!.id]],
      [3, [c0!.id]],
    ]);
  });

  it('counts each source as the block the prompt holds, and skips one that does not fit', () => {
    const blockTokens = (n: number) =>
      estimateTokens(
        formatSource({
          marker: n,
          title: 'Valves',
          page: null,
          text: [c0!, c2!, c4!][n - 1]!.text,
        }),
      );
    const budget = blockTokens(1) + blockTokens(2) - 1;
    const { sources, overBudget } = pack(inRank([c0!, c2!, c4!]), { k: 6, contextTokens: budget });
    // c2 does not fit after c0; c4 (also a full chunk) does not either.
    expect(sources.map((s) => s.chunkIds[0])).toEqual([c0!.id]);
    expect(sources[0]!.tokens).toBe(blockTokens(1));
    expect(overBudget).toBe(2);
  });

  it('lets a later, smaller source fit where a larger one did not', () => {
    const small = c3!; // 215 tokens, against 376 for c2
    const first = estimateTokens(
      formatSource({ marker: 1, title: 'Valves', page: null, text: c0!.text }),
    );
    const smallBlock = estimateTokens(
      formatSource({ marker: 2, title: 'Valves', page: null, text: small.text }),
    );
    const { sources } = pack(inRank([c0!, c2!, { ...small, ord: 99 }]), {
      k: 6,
      contextTokens: first + smallBlock,
    });
    expect(sources.map((s) => s.chunkIds[0])).toEqual([c0!.id, small.id]);
    expect(sources.map((s) => s.marker)).toEqual([1, 2]);
  });

  it('holds its guarantees on any selection: exact text, every chunk once, markers 1..n', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(candidates, { minLength: 1 }),
        fc.integer({ min: 1, max: 8 }),
        (picked, k) => {
          const { sources } = pack(inRank(picked), { k, contextTokens: 100_000 });
          const taken = picked.slice(0, k);
          expect(sources.flatMap((s) => s.chunkIds).sort()).toEqual(taken.map((c) => c.id).sort());
          expect(sources.map((s) => s.marker)).toEqual(sources.map((_, i) => i + 1));
          for (const source of sources) {
            const members = source.chunkIds.map((id) => candidates.find((c) => c.id === id)!);
            const first = members[0]!;
            const last = members[members.length - 1]!;
            expect(source.text).toBe(sliceCodePoints(docText, first.charStart, last.charEnd));
            for (const part of source.parts ?? []) {
              const chunk = candidates.find((c) => c.id === part.chunkId)!;
              expect(sliceCodePoints(source.text, part.at, part.at + part.length)).toBe(chunk.text);
            }
            // A citation of any packed source lands on a chunk it holds, as an exact span.
            for (const citation of resolveCitations(
              `Valve 7 opens [S${String(source.marker)}].`,
              sources,
            )) {
              const chunk = candidates.find((c) => c.id === citation.chunkId)!;
              expect(sliceCodePoints(chunk.text, citation.quoteStart, citation.quoteEnd)).toBe(
                citation.quote,
              );
            }
          }
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 60) },
    );
  });
});
