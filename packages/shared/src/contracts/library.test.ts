import { describe, expect, it } from 'vitest';

import { collectionListSchema, countDocuments, documentCountsSchema } from './library';

describe('countDocuments', () => {
  it('folds the three reading states into one', () => {
    expect(countDocuments({ QUEUED: 2, PARSING: 1, EMBEDDING: 3, READY: 4, FAILED: 1 })).toEqual({
      total: 11,
      ready: 4,
      inProgress: 6,
      failed: 1,
    });
  });

  it('reads an absent status as zero, so an empty collection is all zeros', () => {
    expect(countDocuments({})).toEqual({ total: 0, ready: 0, inProgress: 0, failed: 0 });
  });
});

describe('documentCountsSchema', () => {
  it('refuses a total its parts do not add up to', () => {
    expect(
      documentCountsSchema.safeParse({ total: 3, ready: 1, inProgress: 1, failed: 0 }).success,
    ).toBe(false);
  });

  it('refuses a negative or fractional count', () => {
    expect(
      documentCountsSchema.safeParse({ total: 0, ready: -1, inProgress: 1, failed: 0 }).success,
    ).toBe(false);
    expect(
      documentCountsSchema.safeParse({ total: 1, ready: 0.5, inProgress: 0.5, failed: 0 }).success,
    ).toBe(false);
  });

  it('accepts what countDocuments produces', () => {
    const list = {
      collections: [{ id: 'c1', name: 'Home', documents: countDocuments({ QUEUED: 2 }) }],
    };
    expect(collectionListSchema.parse(list)).toEqual(list);
  });
});
