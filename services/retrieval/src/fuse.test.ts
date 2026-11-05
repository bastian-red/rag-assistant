import { describe, expect, it } from 'vitest';

import { candidatesOf, longDocument } from './fixtures';
import { fuse } from './fuse';

const [a, b, c, d] = candidatesOf(longDocument()).candidates;

describe('fuse (reciprocal rank fusion)', () => {
  // vector: a b c   text: c d   (rrfK 60)
  // a = 1/61, b = 1/62, c = 1/63 + 1/61, d = 1/62
  const ranked = fuse(
    [
      { chunk: a!, similarity: 0.9 },
      { chunk: b!, similarity: 0.8 },
      { chunk: c!, similarity: 0.7 },
    ],
    [
      { chunk: c!, lexical: 0.5, similarity: 0.7 },
      { chunk: d!, lexical: 0.4, similarity: 0.2 },
    ],
    60,
  );

  it('adds 1 / (k + rank) over the lists that hold a chunk', () => {
    const score = new Map(ranked.map((r) => [r.id, r.fused]));
    expect(score.get(a!.id)).toBeCloseTo(1 / 61, 12);
    expect(score.get(c!.id)).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(score.get(d!.id)).toBeCloseTo(1 / 62, 12);
  });

  it('puts the chunk both lists found first, and breaks a tie by the vector rank', () => {
    // b and d tie at 1/62 with the same best rank (2): b has a vector rank, d none.
    expect(ranked.map((r) => r.id)).toEqual([c!.id, a!.id, b!.id, d!.id]);
  });

  it('keeps each list’s rank, score and the similarity', () => {
    const both = ranked[0]!;
    expect([both.vectorRank, both.textRank, both.similarity, both.lexical]).toEqual([
      3, 1, 0.7, 0.5,
    ]);
    const textOnly = ranked.find((r) => r.id === d!.id)!;
    expect([textOnly.vectorRank, textOnly.textRank, textOnly.similarity]).toEqual([null, 2, 0.2]);
  });

  it('breaks an exact tie (first in one list each) by the vector list, then by id', () => {
    const one = (x: typeof a, y: typeof a) =>
      fuse([{ chunk: x!, similarity: 0.5 }], [{ chunk: y!, lexical: 1, similarity: 0.5 }], 60).map(
        (r) => r.id,
      );
    expect(one(a, b)).toEqual([a!.id, b!.id]);
    expect(one(b, a)).toEqual([b!.id, a!.id]);
  });

  it('gives [] for two empty lists', () => {
    expect(fuse([], [], 60)).toEqual([]);
  });
});
