import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { hashEmbedding } from './embedding';

const cosine = (a: readonly number[], b: readonly number[]) =>
  a.reduce((sum, value, i) => sum + value * b[i]!, 0);

describe('hashEmbedding', () => {
  it('is a unit vector of the asked dimensions for any text, never zeros', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.integer({ min: 1, max: 64 }), (text, dims) => {
        const vector = hashEmbedding(text, dims);
        expect(vector).toHaveLength(dims);
        expect(Math.hypot(...vector)).toBeCloseTo(1, 9);
      }),
    );
  });

  it('is deterministic, and blind to case and composed/decomposed forms', () => {
    const decomposed = `cafe${String.fromCodePoint(0x0301)} menu`;
    expect(hashEmbedding('Café menu')).toEqual(hashEmbedding('café menu'));
    expect(hashEmbedding(decomposed)).toEqual(hashEmbedding('café menu'));
  });

  it('puts texts that share words nearer than texts that share none', () => {
    const query = hashEmbedding('boiler pressure');
    const near = hashEmbedding('The boiler pressure gauge reads 1.5 bar.');
    const far = hashEmbedding('Tomatoes need watering every morning.');
    expect(cosine(query, near)).toBeGreaterThan(0.3);
    expect(Math.abs(cosine(query, far))).toBeLessThan(0.1);
  });

  it('refuses a dimension count that is not a positive integer', () => {
    expect(() => hashEmbedding('x', 0)).toThrow(RangeError);
    expect(() => hashEmbedding('x', 1.5)).toThrow(RangeError);
  });
});
