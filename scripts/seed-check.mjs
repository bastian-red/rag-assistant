#!/usr/bin/env node
/**
 * The work behind scripts/seed-check.sh (read its header for what it proves).
 *
 * It reads the database through the db package's built Prisma client, so it
 * needs nothing on the machine beyond the repo's own dependencies. Build step
 * 2 extends it with the libraries and the cross-user canary.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DB = join(ROOT, 'packages', 'db');
const { createPrismaClient } = createRequire(import.meta.url)(join(DB, 'dist', 'index.js'));

/**
 * Every seeded row, as text. Password hashes are left out (scrypt salts them,
 * on purpose); ids and names must repeat exactly.
 */
const DIGEST_SQL = `
WITH x AS (
  SELECT 'user ' || id || ' ' || email || ' ' || name AS x FROM users WHERE email LIKE '%@rag.test'
)
SELECT count(*)::int AS n, md5(string_agg(x, '|' ORDER BY x)) AS digest FROM x`;

function seed() {
  execFileSync('pnpm', ['--filter', '@rag/db', 'exec', 'tsx', 'prisma/seed.mts'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
}

const db = createPrismaClient();
const failures = [];
const fail = (message) => failures.push(message);

try {
  console.log('seed-check: first run');
  seed();
  const [first] = await db.$queryRawUnsafe(DIGEST_SQL);
  console.log(`  ${first.n} rows ${first.digest}`);

  console.log('seed-check: second run');
  seed();
  const [second] = await db.$queryRawUnsafe(DIGEST_SQL);
  console.log(`  ${second.n} rows ${second.digest}`);

  if (first.n !== second.n) {
    fail(`the second run changed the row count (${first.n} -> ${second.n}): it is not idempotent.`);
  } else if (first.digest !== second.digest) {
    fail('same row count, different digest: the seed read the clock or a random source.');
  }
  if (first.n < 2) {
    fail(`${first.n} seeded account(s); the isolation tests need two libraries.`);
  }
} finally {
  await db.$disconnect();
}

if (failures.length > 0) {
  console.error('seed-check: FAILED');
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('seed-check: ok (deterministic, idempotent, two accounts)');
