#!/usr/bin/env node
/**
 * The work behind scripts/seed-check.sh (read its header for what it proves).
 *
 * It reads the database through the db package's built Prisma client, so it
 * needs nothing on the machine beyond the repo's own dependencies.
 *
 * Beyond determinism it checks what the seed claims about its libraries:
 * every person has one, every document's sha256 and size are those of its
 * real corpus file, and the canary sits in exactly one of the second person's
 * documents and in NO row of the first person's, in any table that holds
 * text. That last query covers chunks, answers, citations and traces too:
 * they are empty today, and from build step 5 the same check reads them.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
WITH seeded AS (SELECT id FROM users WHERE email LIKE '%@rag.test'),
x AS (
  SELECT 'user ' || id || ' ' || email || ' ' || name AS x FROM users WHERE id IN (SELECT id FROM seeded)
  UNION ALL
  SELECT 'collection ' || id || ' ' || owner_id || ' ' || name FROM collections
  WHERE owner_id IN (SELECT id FROM seeded)
  UNION ALL
  SELECT concat_ws(' ', 'document', id, owner_id, collection_id, title, filename, mime, bytes, sha256)
  FROM documents WHERE owner_id IN (SELECT id FROM seeded)
)
SELECT count(*)::int AS n, md5(string_agg(x, '|' ORDER BY x)) AS digest FROM x`;

function seed() {
  execFileSync('pnpm', ['--filter', '@rag/db', 'exec', 'tsx', 'prisma/seed.mts'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
}

const SEED_SOURCE = readFileSync(join(DB, 'prisma', 'seed.mts'), 'utf8');
/** A `const NAME = '...';` line out of the seed, so nothing is retyped here. */
function seedConst(name) {
  const value = new RegExp(`^const ${name} = '([^']+)';`, 'mu').exec(SEED_SOURCE)?.[1];
  if (value === undefined) throw new Error(`seed-check: no const ${name} in seed.mts`);
  return value;
}
const CANARY = seedConst('CANARY');
const FIRST_EMAIL = seedConst('FIRST_EMAIL');
const SECOND_EMAIL = seedConst('SECOND_EMAIL');

/** Every corpus file: path (under corpus/), sha256, size, and whether it holds the canary. */
function corpusFiles(dir = join(DB, 'prisma', 'corpus'), prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return corpusFiles(path, `${prefix}${name}/`);
    const bytes = readFileSync(path);
    return [
      {
        file: `${prefix}${name}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        canary: bytes.toString('utf8').includes(CANARY),
      },
    ];
  });
}

/** Every text a person's rows hold, in every table, as (table, owner email, text). */
const TEXT_SQL = `
SELECT t.tbl, u.email, t.txt FROM (
  SELECT 'collections' AS tbl, owner_id, name AS txt FROM collections
  UNION ALL SELECT 'documents', owner_id, concat_ws(' ', title, filename, error) FROM documents
  UNION ALL SELECT 'chunks', owner_id, text || ' ' || array_to_string(heading_path, ' ') FROM chunks
  UNION ALL SELECT 'conversations', owner_id, title FROM conversations
  UNION ALL SELECT 'messages', owner_id, concat_ws(' ', content, error) FROM messages
  UNION ALL SELECT 'citations', owner_id, document_title || ' ' || quote FROM citations
  UNION ALL SELECT 'retrieval_traces', owner_id, query || ' ' || candidates::text FROM retrieval_traces
) t JOIN users u ON u.id = t.owner_id
WHERE u.email IN ($1, $2)`;

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
  const people = await db.$queryRawUnsafe(
    `SELECT u.email,
            (SELECT count(*)::int FROM collections c WHERE c.owner_id = u.id) AS collections,
            (SELECT count(*)::int FROM documents d WHERE d.owner_id = u.id) AS documents
     FROM users u WHERE u.email LIKE '%@rag.test' ORDER BY u.email`,
  );
  if (people.length < 2) {
    fail(`${people.length} seeded account(s); the isolation tests need two libraries.`);
  }
  for (const person of people) {
    if (person.collections === 0 || person.documents === 0) {
      fail(
        `${person.email} has ${person.collections} collections and ${person.documents} documents; every seeded person needs a library.`,
      );
    }
  }

  // Every document is exactly one corpus file's bytes, and every file is seeded.
  const files = corpusFiles();
  const documents = await db.$queryRawUnsafe(
    `SELECT d.sha256, d.bytes, d.title, u.email FROM documents d JOIN users u ON u.id = d.owner_id
     WHERE u.email LIKE '%@rag.test'`,
  );
  for (const file of files) {
    const matches = documents.filter((d) => d.sha256 === file.sha256);
    if (matches.length !== 1) fail(`${file.file} is seeded ${matches.length} times (by sha256).`);
    else if (matches[0].bytes !== file.bytes) {
      fail(`${file.file} is ${file.bytes} bytes; its document says ${matches[0].bytes}.`);
    }
  }
  if (documents.length !== files.length) {
    fail(`${documents.length} seeded documents for ${files.length} corpus files.`);
  }

  // The canary: one file, the second person's, and nowhere of the first person's.
  const canaryFiles = files.filter((f) => f.canary);
  if (canaryFiles.length !== 1) {
    fail(`the canary is in ${canaryFiles.length} corpus files; it must be in exactly one.`);
  } else {
    const owner = documents.find((d) => d.sha256 === canaryFiles[0].sha256)?.email;
    if (owner !== SECOND_EMAIL) fail(`the canary file belongs to ${owner}, not ${SECOND_EMAIL}.`);
  }
  const texts = await db.$queryRawUnsafe(TEXT_SQL, FIRST_EMAIL, SECOND_EMAIL);
  const leaks = texts.filter((t) => t.email === FIRST_EMAIL && t.txt.includes(CANARY));
  for (const leak of leaks) fail(`the canary is in a ${leak.tbl} row of ${FIRST_EMAIL}.`);
  console.log(
    `  ${files.length} corpus files, ${texts.length} text rows read, canary only in ${SECOND_EMAIL}'s library`,
  );
} finally {
  await db.$disconnect();
}

if (failures.length > 0) {
  console.error('seed-check: FAILED');
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  'seed-check: ok (deterministic, idempotent, two libraries, documents match their files, one canary)',
);
