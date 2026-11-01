/**
 * Every promise the migrations make, tried against the real database.
 *
 * Each test attempts the forbidden write and asserts it is refused BY NAME, so a
 * refusal for an unrelated reason (a missing row, a typo) cannot pass for the
 * guarantee holding.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { USER_EMAIL_LOWERCASE, USER_EMAIL_UNIQUE, USER_NAME_LENGTH } from '../src/constraints';
import { db, names, newUser, refused, removeCreatedUsers } from './support';

afterAll(async () => {
  await removeCreatedUsers();
  await db.$disconnect();
});

describe('pgvector', () => {
  it('is installed by the init migration, so embeddings have somewhere to go', async () => {
    const rows = await db.$queryRaw<{ extversion: string }[]>`
      SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    expect(rows).toHaveLength(1);
    // HNSW with iterative scans (what filtered retrieval relies on) is 0.8+.
    const [major, minor] = rows[0]!.extversion.split('.').map(Number);
    expect(major! > 0 || minor! >= 8, rows[0]!.extversion).toBe(true);
  });

  it('computes a cosine distance, so the column type is the real one', async () => {
    const rows = await db.$queryRaw<{ d: number }[]>`
      SELECT ('[1,0,0]'::vector <=> '[0,1,0]'::vector)::float8 AS d`;
    expect(rows[0]!.d).toBe(1);
  });
});

describe('users', () => {
  it('refuses a second account with the same email', async () => {
    const email = `dup-${randomUUID()}@rag.test`;
    await newUser(email);
    expect(names(await refused(newUser(email)), USER_EMAIL_UNIQUE)).toBe(true);
  });

  it('refuses an email that is not lowercase, so one address cannot have two spellings', async () => {
    const error = await refused(newUser(`Mixed-${randomUUID()}@rag.test`));
    expect(names(error, USER_EMAIL_LOWERCASE)).toBe(true);
  });

  it.each([
    ['spaces', '   '],
    // btrim() strips only spaces; the step-1 check let this one through.
    ['a tab and a newline', '\t\n'],
  ])('refuses a blank name: %s', async (_, name) => {
    const error = await refused(
      db.user.create({
        data: { email: `blank-${randomUUID()}@rag.test`, name, passwordHash: 'x' },
      }),
    );
    expect(names(error, USER_NAME_LENGTH)).toBe(true);
  });
});
