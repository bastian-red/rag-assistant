#!/usr/bin/env node
/**
 * Remove the accounts a previous E2E run made through the sign-up form, and
 * their stored files, before the next run starts.
 *
 * The lane runs against the developer's own database (the seed restores its
 * two accounts there), so without this every run would leave its readers'
 * libraries behind. Only addresses the lane itself makes are touched:
 * `e2e-…@rag.test` (e2e/fixtures.ts `signUp`). Rows cascade from the user;
 * files live in UPLOAD_DIR/<ownerId>/, and the owner id is checked before any
 * path is built from it.
 *
 * Run from packages/db so `@rag/db` resolves: scripts/e2e.sh does that.
 */
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';

// A bare import resolves from THIS file's folder, which has no @rag/db; the
// package is resolved from the working directory (packages/db) instead.
const { createPrismaClient } = createRequire(join(process.cwd(), 'package.json'))('@rag/db');

const uploadDir = process.env.UPLOAD_DIR;
if (uploadDir === undefined || !isAbsolute(uploadDir)) {
  console.error(
    'e2e-cleanup: UPLOAD_DIR must be set and absolute (scripts/load-env.sh does this).',
  );
  process.exit(2);
}

const prisma = createPrismaClient({ url: process.env.DATABASE_URL });
try {
  const readers = await prisma.user.findMany({
    where: { email: { startsWith: 'e2e-', endsWith: '@rag.test' } },
    select: { id: true },
  });
  for (const { id } of readers) {
    if (!/^[a-z0-9]{20,40}$/u.test(id)) throw new Error(`refusing an odd owner id: ${id}`);
    await rm(join(uploadDir, id), { recursive: true, force: true });
  }
  const { count } = await prisma.user.deleteMany({
    where: { id: { in: readers.map((r) => r.id) } },
  });
  console.log(`e2e-cleanup: removed ${String(count)} account(s) from earlier runs.`);
} finally {
  await prisma.$disconnect();
}
