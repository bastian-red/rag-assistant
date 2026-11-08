import { describe, expect, it } from 'vitest';

import {
  abstention,
  agreement,
  chooseThreshold,
  corrected,
  correctedPrecision,
  mean,
  overlaps,
  percentile,
  recallAt,
  reciprocalRank,
} from './metrics';

const span = (file: string, start: number, end: number) => ({ file, start, end });

describe('overlaps', () => {
  it('needs the same file and a non-empty intersection', () => {
    expect(overlaps(span('a', 0, 10), span('a', 9, 20))).toBe(true);
    expect(overlaps(span('a', 0, 10), span('a', 10, 20))).toBe(false); // touching only
    expect(overlaps(span('a', 0, 10), span('b', 0, 10))).toBe(false);
    expect(overlaps(span('a', 5, 6), span('a', 0, 100))).toBe(true); // inside
  });
});

describe('recall and reciprocal rank', () => {
  const gold = [span('a', 100, 120), span('b', 0, 10)];
  const ranked = [[span('c', 0, 50)], [span('a', 90, 105)], [span('d', 0, 5)], [span('b', 5, 9)]];

  it('counts the share of gold spans touched within k', () => {
    expect(recallAt(1, ranked, gold)).toBe(0);
    expect(recallAt(2, ranked, gold)).toBe(0.5);
    expect(recallAt(4, ranked, gold)).toBe(1);
  });

  it('counts a merged source by any of its chunks', () => {
    expect(recallAt(1, [[span('x', 0, 1), span('a', 110, 130)]], gold)).toBe(0.5);
  });

  it('ranks the first source touching any gold span', () => {
    expect(reciprocalRank(ranked, gold)).toBe(0.5);
    expect(reciprocalRank([[span('z', 0, 1)]], gold)).toBe(0);
  });

  it('refuses recall over no gold spans', () => {
    expect(() => recallAt(6, ranked, [])).toThrow(/undefined/u);
  });
});

describe('abstention', () => {
  it('scores each side over its own questions', () => {
    const rows = [
      { answerable: false, verdict: 'abstained' as const },
      { answerable: false, verdict: 'abstained' as const },
      { answerable: false, verdict: 'answered' as const },
      { answerable: true, verdict: 'answered' as const },
      { answerable: true, verdict: 'abstained' as const },
      { answerable: true, verdict: 'answered' as const },
      { answerable: true, verdict: 'answered' as const },
    ];
    expect(abstention(rows)).toEqual({
      correctAbstention: 2 / 3,
      falseAbstention: 1 / 4,
      unanswerable: 3,
      answerable: 4,
    });
    expect(abstention([]).correctAbstention).toBeNull();
  });
});

describe('chooseThreshold', () => {
  it('picks a cut in the widest gap that separates the two kinds', () => {
    // Unanswerable at 0.30, 0.35; answerable at 0.50, 0.70. Midpoint 0.425.
    const rows = [
      { answerable: false, best: 0.3 },
      { answerable: false, best: 0.35 },
      { answerable: true, best: 0.5 },
      { answerable: true, best: 0.7 },
    ];
    const { choice, candidates } = chooseThreshold(rows);
    expect(choice.threshold).toBeCloseTo(0.425, 10);
    expect(choice).toMatchObject({ correctAbstention: 1, falseAbstention: 0 });
    expect(candidates).toHaveLength(5);
  });

  it('prefers no false abstention over catching every unanswerable question', () => {
    // One unanswerable question (0.60) sits above an answerable one (0.55).
    const rows = [
      { answerable: false, best: 0.3 },
      { answerable: false, best: 0.6 },
      { answerable: true, best: 0.55 },
      { answerable: true, best: 0.8 },
    ];
    const { choice } = chooseThreshold(rows);
    expect(choice.falseAbstention).toBe(0);
    expect(choice.correctAbstention).toBe(0.5);
    expect(choice.threshold).toBeCloseTo(0.425, 10); // between 0.30 and 0.55
  });
});

describe('judge agreement and correction', () => {
  it('measures TPR and TNR on labelled claims', () => {
    const rows = [
      { label: true, judged: true },
      { label: true, judged: true },
      { label: true, judged: false },
      { label: true, judged: true },
      { label: false, judged: false },
      { label: false, judged: true },
    ];
    expect(agreement(rows)).toEqual({ labels: 6, tpr: 0.75, tnr: 0.5, accuracy: 4 / 6 });
  });

  it('corrects an observed rate by the judge errors (Rogan-Gladen)', () => {
    // p = 0.8, TPR 0.9, TNR 0.8: (0.8 + 0.8 - 1) / (0.9 + 0.8 - 1) = 0.6 / 0.7
    expect(corrected(0.8, { tpr: 0.9, tnr: 0.8 })).toBeCloseTo(0.6 / 0.7, 12);
    expect(corrected(0.99, { tpr: 0.9, tnr: 0.9 })).toBe(1); // clamped
    expect(corrected(0.5, { tpr: 0.5, tnr: 0.5 })).toBeNull(); // a coin
  });
});

describe('correctedPrecision', () => {
  it('corrects only the judged part and keeps gold-span citations as counted', () => {
    // 86 citations, 64 on gold, 15 of the 22 judged pass: observed share 15/22.
    // TPR 0.8, TNR 1: share = (15/22 + 1 - 1) / (0.8 + 1 - 1) = (15/22) / 0.8.
    const share = 15 / 22 / 0.8;
    expect(
      correctedPrecision({ citations: 86, onGold: 64, judgedSupporting: 15 }, { tpr: 0.8, tnr: 1 }),
    ).toBeCloseTo((64 + share * 22) / 86, 12);
    // A perfect judge changes nothing.
    expect(
      correctedPrecision({ citations: 86, onGold: 64, judgedSupporting: 15 }, { tpr: 1, tnr: 1 }),
    ).toBeCloseTo(79 / 86, 12);
  });

  it('is 1 with nothing judged, null with nothing cited or a coin for a judge', () => {
    expect(
      correctedPrecision({ citations: 5, onGold: 5, judgedSupporting: 0 }, { tpr: 0.5, tnr: 0.5 }),
    ).toBe(1);
    expect(
      correctedPrecision({ citations: 0, onGold: 0, judgedSupporting: 0 }, { tpr: 1, tnr: 1 }),
    ).toBeNull();
    expect(
      correctedPrecision({ citations: 4, onGold: 2, judgedSupporting: 1 }, { tpr: 0.5, tnr: 0.5 }),
    ).toBeNull();
  });
});

describe('mean and percentile', () => {
  it('are null on nothing and nearest-rank otherwise', () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
});
