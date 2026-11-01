import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DOCUMENT_STATUSES } from '@rag/shared';
import { ACCEPTED_TYPES, LIMITS } from '@rag/shared/constants';

import * as constraints from './constraints';

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const statements = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => readFileSync(join(MIGRATIONS, e.name, 'migration.sql'), 'utf8'))
  .join('\n')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const named = Object.entries(constraints)
  .filter(([key, value]) => typeof value === 'string' && /^[A-Z_]+$/u.test(key))
  .filter(([key]) => !key.startsWith('PRISMA_') && !key.startsWith('PG_'));

describe('every exported constraint name exists in a migration', () => {
  it('finds the names at all (an empty list would pass every case below)', () => {
    expect(named.length).toBeGreaterThanOrEqual(1);
  });
  for (const [key, value] of named) {
    it(`${key} -> ${String(value)}`, () => {
      expect(statements).toContain(`"${String(value)}"`);
    });
  }
});

/** The text of one CHECK in the migrations, for the numbers inside it. */
function check(name: string): string {
  const at = statements.indexOf(`"${name}"`);
  expect(at, name).toBeGreaterThan(-1);
  // One CHECK ends at the comma before the next ADD, or at the statement's end.
  const ends = [statements.indexOf(',\n', at), statements.indexOf(';', at)].filter((i) => i > -1);
  return statements.slice(at, Math.min(...ends));
}

describe('the migrations and @rag/shared agree on every limit', () => {
  // A limit the form enforces and the database does not (or the reverse) is a
  // request the UI accepts and the API answers with a 500.
  it('accepts exactly ACCEPTED_TYPES', () => {
    expect([...constraints.DOCUMENT_MIME_TYPES]).toEqual([...ACCEPTED_TYPES]);
    const allowed = [...check(constraints.DOCUMENT_MIME).matchAll(/'([a-z/]+)'/gu)].map(
      (m) => m[1],
    );
    expect(allowed).toEqual([...ACCEPTED_TYPES]);
  });

  it.each([
    [constraints.DOCUMENT_BYTES, `BETWEEN 1 AND ${String(LIMITS.uploadBytes)}`],
    [constraints.COLLECTION_NAME, `BETWEEN 1 AND ${String(LIMITS.collectionName)}`],
    [constraints.DOCUMENT_TITLE, `BETWEEN 1 AND ${String(LIMITS.documentTitle)}`],
    [constraints.CONVERSATION_TITLE, `BETWEEN 1 AND ${String(LIMITS.conversationTitle)}`],
    [constraints.MESSAGE_QUESTION, `BETWEEN 1 AND ${String(LIMITS.question)}`],
  ])('%s says %s', (name, bound) => {
    expect(check(name)).toContain(bound);
  });

  it('declares document_status with the contract’s statuses, in its order', () => {
    const declared = /CREATE TYPE "document_status" AS ENUM \(([^)]+)\)/u.exec(statements)?.[1];
    expect(declared?.split(',').map((s) => s.trim().replaceAll("'", ''))).toEqual([
      ...DOCUMENT_STATUSES,
    ]);
  });

  it('declares the embedding column at EMBEDDING_DIMENSIONS', () => {
    expect(statements).toContain(
      `"embedding" halfvec(${String(constraints.EMBEDDING_DIMENSIONS)}) NOT NULL`,
    );
  });
});

describe('the hand-written objects db-drift filters', () => {
  it('lists only names that are exported constraints', () => {
    const exported = new Set<unknown>(named.map(([, value]) => value));
    for (const name of constraints.HAND_WRITTEN_DIFF_OBJECTS)
      expect(exported.has(name), name).toBe(true);
  });
});
