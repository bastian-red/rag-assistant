#!/usr/bin/env node
/**
 * Prove the live database matches the Prisma schema.
 *
 * `prisma migrate status` reads the migration LEDGER and never compares a
 * column, so an applied migration edited afterwards is invisible to it. This
 * runs `prisma migrate diff` from the live database to the datamodel instead.
 *
 * What the diff cannot see is the hand-written half, which Prisma proposes to
 * drop (composite foreign keys, and from step 3 the HNSW and full-text indexes
 * Prisma cannot describe). Those statements are expected and filtered; every other difference is real drift. The list is
 * HAND_WRITTEN_DIFF_OBJECTS in packages/db/src/constraints.ts, read from the
 * built package (db-drift.sh and integration.sh build it first), so the names
 * live in one place and constraints.test.ts proves each is in a migration.
 *
 *   node scripts/db-drift.mjs     (DATABASE_URL)
 *
 * It first checks the ledger the other way round: every applied migration's
 * checksum against its file. `prisma migrate deploy` skips an applied
 * migration even when its file was edited afterwards, so a database migrated
 * before an edit keeps the old SQL, and every lane run against it tests the
 * old SQL (two fixed CHECKs "failed" in rag_it this way, 2026-11-01).
 *
 * 0 = matches. 1 = drift or an edited migration, with what to do. 2 = could not run.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbPackage = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'db');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('db-drift: DATABASE_URL is not set.');
  process.exit(2);
}

const migrations = join(dbPackage, 'prisma', 'migrations');
const { PrismaClient } = createRequire(import.meta.url)(join(dbPackage, 'generated', 'client'));
const ledger = new PrismaClient({ datasources: { db: { url } } });
let applied;
try {
  applied = await ledger.$queryRawUnsafe(
    'SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL',
  );
} catch (error) {
  console.error(`db-drift: could not read the migration ledger: ${error.message}`);
  process.exit(2);
} finally {
  await ledger.$disconnect();
}
const edited = applied.filter(({ migration_name: name, checksum }) => {
  const file = join(migrations, name, 'migration.sql');
  const exists = readdirSync(migrations).includes(name);
  return !exists || createHash('sha256').update(readFileSync(file)).digest('hex') !== checksum;
});
if (edited.length > 0) {
  const database = new URL(url).pathname.slice(1);
  console.error(
    `db-drift: ${database} applied ${edited.map((m) => m.migration_name).join(', ')} from a file that has since changed or gone.\n` +
      'migrate deploy will never re-apply it, so this database holds SQL the repo no longer has.\n' +
      `Recreate the database (for rag_it: drop it; ./scripts/integration.sh creates and migrates it again).`,
  );
  process.exit(1);
}

let diff;
try {
  diff = execFileSync(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'diff',
      '--from-url',
      url,
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    {
      cwd: dbPackage,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
} catch (error) {
  console.error('db-drift: prisma migrate diff failed to run.');
  console.error(`${error.stdout ?? ''}${error.stderr ?? ''}`);
  process.exit(2);
}

const { HAND_WRITTEN_DIFF_OBJECTS } = createRequire(import.meta.url)(
  join(dbPackage, 'dist', 'constraints.js'),
);
// Empty is legitimate (step 1 has no hand-written objects yet); missing is not:
// a renamed export would otherwise filter nothing and pass silently.
if (!Array.isArray(HAND_WRITTEN_DIFF_OBJECTS)) {
  console.error('db-drift: could not read HAND_WRITTEN_DIFF_OBJECTS from packages/db/dist.');
  process.exit(2);
}
/** A diff block naming a hand-written object, quoted exactly as Prisma prints it. */
const isHandWritten = (block) =>
  HAND_WRITTEN_DIFF_OBJECTS.some((name) => block.includes(`"${name}"`));
const real = diff
  .split(/\n(?=-- )/u)
  .filter((block) => !isHandWritten(block))
  .join('\n')
  .trim();
if (real !== '' && !/this is an empty migration/iu.test(real)) {
  console.error(
    'db-drift: the database does NOT match packages/db/prisma/schema.prisma. Prisma would need:\n',
  );
  console.error(real);
  process.exit(1);
}
console.log('db-drift: the database matches packages/db/prisma/schema.prisma.');
