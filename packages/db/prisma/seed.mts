/**
 * The demo accounts: two people, each with a private library.
 *
 * Two, not one, on purpose: the isolation promise ("one user's documents are
 * invisible to every other user") needs a second library to be tested against.
 * Build step 2 adds their collections, documents and the cross-user canary.
 *
 * Properties (`scripts/seed-check.sh` proves the first two):
 *
 * 1. **Deterministic.** Ids are derived from the email, so two runs write
 *    identical rows (password hashes aside: scrypt salts them on purpose).
 * 2. **Idempotent, touching only its own rows.** People are upserted by email.
 *    An account created any other way is never touched.
 *
 * The client comes from this package's own source, not from `@rag/db`: a
 * package importing itself resolves to its `dist/`, which a clean checkout has
 * not built (turbo's `^build` covers dependencies, never the package itself).
 *
 * `scripts/dev-smoke.sh` and the E2E suite `sed` the `const NAME = '...'`
 * lines below. One line each, single quotes, no template literals. These are
 * local accounts for a local database, published on purpose so the README's
 * sign-in and `scripts/dev-smoke.sh` work on a fresh clone.
 */
import { createHash } from 'node:crypto';

import { hashPassword } from '@rag/shared/server';

import { createPrismaClient, type PrismaClient } from '../src/client.ts';

const FIRST_EMAIL = 'alma@rag.test';
const FIRST_PASSWORD = 'alma-password-2026';
const FIRST_NAME = 'Alma Rosales';
const SECOND_EMAIL = 'bruno@rag.test';
const SECOND_PASSWORD = 'bruno-password-2026';
const SECOND_NAME = 'Bruno Okafor';

const PEOPLE = [
  { email: FIRST_EMAIL, password: FIRST_PASSWORD, name: FIRST_NAME },
  { email: SECOND_EMAIL, password: SECOND_PASSWORD, name: SECOND_NAME },
] as const;

/** A cuid-shaped id (lowercase, 25 characters) derived from a stable key. */
function seedId(kind: string, key: string): string {
  return `c${createHash('sha256').update(`${kind}:${key}`).digest('hex').slice(0, 24)}`;
}

async function seedPeople(prisma: PrismaClient): Promise<number> {
  for (const person of PEOPLE) {
    const data = { name: person.name, passwordHash: hashPassword(person.password) };
    await prisma.user.upsert({
      where: { email: person.email },
      create: { id: seedId('user', person.email), email: person.email, ...data },
      update: data,
    });
  }
  return PEOPLE.length;
}

const prisma = createPrismaClient();
try {
  const people = await seedPeople(prisma);
  console.info(`seed: ${String(people)} people, each with an empty private library`);
} finally {
  await prisma.$disconnect();
}
