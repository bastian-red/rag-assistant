import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as root from './index';
import * as constants from './constants';

describe('@rag/shared/constants', () => {
  it('imports nothing, so a client component that uses it ships no zod', () => {
    const source = readFileSync(join(__dirname, 'constants.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*(import|export)\b[^;]*\bfrom\s/mu);
    expect(source).not.toMatch(/\brequire\(/u);
  });

  it('is the same values the package root exports, not a copy', () => {
    for (const [name, value] of Object.entries(constants)) {
      expect(root[name as keyof typeof root], name).toBe(value);
    }
  });
});
