import { describe, expect, it } from 'vitest';

import { decide } from './abstain';
import { candidatesOf, inRank, longDocument } from './fixtures';

const ranked = inRank(candidatesOf(longDocument()).candidates.slice(0, 3)).map((c, i) => ({
  ...c,
  similarity: [0.41, 0.52, 0.3][i]!,
}));

describe('decide', () => {
  it('answers when the best similarity reaches the threshold, from any rank', () => {
    expect(decide(ranked, 3, 'hybrid', 0.52)).toEqual({
      abstain: false,
      reason: null,
      bestSimilarity: 0.52,
    });
  });

  it('abstains below it, saying so and with the number it judged by', () => {
    expect(decide(ranked, 3, 'hybrid', 0.53)).toEqual({
      abstain: true,
      reason: 'below_threshold',
      bestSimilarity: 0.52,
    });
  });

  it('abstains with no candidates, and when nothing could be packed', () => {
    expect(decide([], 0, 'hybrid', 0.4).reason).toBe('no_candidates');
    expect(decide(ranked, 0, 'hybrid', 0.4).reason).toBe('no_candidates');
  });

  it('in text mode, with no similarity, answers on any match', () => {
    const lexical = ranked.map((c) => ({ ...c, similarity: null }));
    expect(decide(lexical, 3, 'text', 0.9)).toEqual({
      abstain: false,
      reason: null,
      bestSimilarity: null,
    });
    expect(decide(lexical, 3, 'hybrid', 0.9).reason).toBe('below_threshold');
  });
});
