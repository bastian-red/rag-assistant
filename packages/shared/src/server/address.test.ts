import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { addressHash } from './address';

describe('addressHash', () => {
  const secret = 's'.repeat(32);

  it('is a keyed HMAC (value computed with node:crypto, not recalled)', () => {
    expect(addressHash(secret, '203.0.113.9')).toBe(
      '43b78790f995a5db2141a7ee9674dc91e77f632a88de67d5af22ccbdc54639c5',
    );
  });

  it('is stable per address, differs per address and per secret, and is not a plain SHA-256', () => {
    expect(addressHash(secret, '203.0.113.9')).toBe(addressHash(secret, '203.0.113.9'));
    expect(addressHash(secret, '203.0.113.10')).not.toBe(addressHash(secret, '203.0.113.9'));
    expect(addressHash('t'.repeat(32), '203.0.113.9')).not.toBe(addressHash(secret, '203.0.113.9'));
    expect(addressHash(secret, '203.0.113.9')).not.toBe(
      createHash('sha256').update('203.0.113.9').digest('hex'),
    );
    expect(addressHash(secret, '::1')).toMatch(/^[0-9a-f]{64}$/u);
  });
});
