import { describe, expect, it } from 'vitest';

import { dayWords } from './dates';

describe('dayWords', () => {
  // Expectations computed with Node's Intl (en-GB), not recalled: en-GB says "Sept".
  it('says the day in UTC, whatever zone the server runs in', () => {
    expect(dayWords('2026-11-07T23:59:00Z')).toBe('7 Nov 2026');
    expect(dayWords('2026-09-01T00:00:00Z')).toBe('1 Sept 2026');
  });
});
