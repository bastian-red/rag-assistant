/**
 * No browser bundle imports a value from the `@rag/shared` package root.
 *
 * `@rag/shared` ships CommonJS, which the bundler cannot tree-shake: one
 * `import { LIMITS } from '@rag/shared'` in a sibling project's comment form put every zod
 * contract (a 505 KB chunk, 890 ms of blocking time on a throttled phone) on
 * the public post page, and Lighthouse scored it 79 for performance. The
 * constants a form needs live in the zod-free `@rag/shared/constants`;
 * `import type` from the root is fine, because it is erased.
 *
 * The walk starts at every `'use client'` file and follows its relative
 * imports, because a helper a client component imports is in the bundle too.
 * It stops at a `'use server'` module, whose code stays on the server.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/u.test(path) && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** Every import / export-from statement, with whether it is type-only. */
export function importsOf(source: string): { specifier: string; typeOnly: boolean }[] {
  const statements = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/gmsu;
  const sideEffect = /^\s*import\s+['"]([^'"]+)['"]/gmu;
  const found: { specifier: string; typeOnly: boolean }[] = [];
  for (const match of source.matchAll(statements)) {
    const clause = match[3]!;
    // `import { type A, type B }` is type-only too.
    const inlineTypesOnly = /^\{[^}]*\}$/su.test(clause.trim())
      ? clause
          .replace(/[{}]/gu, '')
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
          .every((name) => name.startsWith('type '))
      : false;
    found.push({ specifier: match[4]!, typeOnly: match[2] !== undefined || inlineTypesOnly });
  }
  for (const match of source.matchAll(sideEffect))
    found.push({ specifier: match[1]!, typeOnly: false });
  return found;
}

function resolveLocal(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const isClient = (source: string) => /^\s*['"]use client['"]/u.test(source);
/** A server action module: a client gets a reference to it, never its code. */
const isServer = (source: string) => /^\s*['"]use server['"]/u.test(source);

describe('client bundles and @rag/shared', () => {
  it('reads type-only imports as type-only, and values as values', () => {
    expect(importsOf("import type { A } from '@rag/shared';")).toEqual([
      { specifier: '@rag/shared', typeOnly: true },
    ]);
    expect(importsOf("import { type A, type B } from '@rag/shared';")[0]!.typeOnly).toBe(true);
    expect(importsOf("import { LIMITS, type A } from '@rag/shared';")[0]!.typeOnly).toBe(false);
    expect(importsOf("import {\n  LIMITS,\n} from '@rag/shared';")[0]!.typeOnly).toBe(false);
    expect(importsOf("export { z } from '@rag/shared';")[0]!.typeOnly).toBe(false);
  });

  it('no client component, nor anything it imports, takes a value from the package root', () => {
    const files = ['app', 'components', 'lib'].flatMap((dir) => walk(join(WEB, dir)));
    const entries = files.filter((file) => isClient(readFileSync(file, 'utf8')));
    // At least the sign-in form; an empty list would pass every check below.
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const offenders: string[] = [];
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      if (isServer(source)) continue;
      for (const { specifier, typeOnly } of importsOf(source)) {
        if (specifier === '@rag/shared' && !typeOnly) offenders.push(relative(WEB, file));
        if (specifier.startsWith('.') && !typeOnly) {
          const next = resolveLocal(file, specifier);
          if (next !== null) queue.push(next);
        }
      }
    }
    expect(offenders, 'import these from @rag/shared/constants, or as `import type`').toEqual([]);
  });
});
