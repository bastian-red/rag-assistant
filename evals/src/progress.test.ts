import { describe, expect, it } from 'vitest';

import { progressLine } from './progress';

describe('progressLine', () => {
  const at = new Date('2026-11-06T22:00:00.000Z');

  it('computes percent, rate per minute and ETA from counts and elapsed time', () => {
    // 16 of 64 in 40 s: 0.4/s = 24.0/min, 48 left at 0.4/s = 120 s.
    expect(progressLine('eval answers', 16, 64, 40, at, 'esp-time')).toBe(
      '2026-11-06T22:00:00.000Z eval answers: 25% (16/64), ETA 120 s, 24.0/min, esp-time',
    );
  });

  it('says the ETA is unknown before the first item finishes', () => {
    expect(progressLine('x', 0, 10, 5, at)).toBe(
      '2026-11-06T22:00:00.000Z x: 0% (0/10), ETA unknown, 0.0/min',
    );
  });
});
