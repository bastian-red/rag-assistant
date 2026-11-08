import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as root from './index';
import * as sse from './sse';

describe('@rag/shared/sse', () => {
  it('imports nothing, so a browser bundle that parses frames ships no zod', () => {
    const source = readFileSync(join(__dirname, 'sse.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*(import|export)\b[^;]*\bfrom\s/mu);
    expect(source).not.toMatch(/\brequire\(/u);
  });

  it('is the parser the package root exports, not a copy', () => {
    expect(root.createSseParser).toBe(sse.createSseParser);
  });
});
