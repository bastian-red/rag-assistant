import { describe, expect, it } from 'vitest';

import { describeCounts } from './library';

const counts = (ready: number, inProgress: number, failed: number) => ({
  total: ready + inProgress + failed,
  ready,
  inProgress,
  failed,
});

describe('describeCounts', () => {
  it('says an empty collection is empty, with no breakdown', () => {
    expect(describeCounts(counts(0, 0, 0))).toEqual({ total: 'No documents yet', detail: null });
  });

  it('uses the singular for one', () => {
    expect(describeCounts(counts(1, 0, 0))).toEqual({
      total: '1 document',
      detail: '1 ready to ask about',
    });
  });

  it('names every non-zero state and leaves the zeros out', () => {
    expect(describeCounts(counts(2, 0, 1))).toEqual({
      total: '3 documents',
      detail: '2 ready to ask about, 1 could not be read',
    });
    expect(describeCounts(counts(0, 3, 0)).detail).toBe('3 still being read');
  });

  it('lists the states in the order a document moves through them', () => {
    expect(describeCounts(counts(1, 1, 1)).detail).toBe(
      '1 ready to ask about, 1 still being read, 1 could not be read',
    );
  });
});
