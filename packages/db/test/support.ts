/**
 * Plumbing for the database integration lane. Every helper writes rows with
 * random keys, so tests never collide, and each suite deletes what it made.
 */
import { randomUUID } from 'node:crypto';

import { createPrismaClient, type PrismaClient } from '../src/client';
import { violatedConstraint, violatedUniqueIndex } from '../src/errors';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '' || !url.includes('rag_it')) {
  throw new Error('DATABASE_URL must point at rag_it. Run this through ./scripts/integration.sh.');
}

export const db: PrismaClient = createPrismaClient({ url });

/** Every user `newUser` made in this process, for `removeCreatedUsers()`. */
const created: string[] = [];

export async function newUser(email = `db-${randomUUID()}@rag.test`): Promise<string> {
  const user = await db.user.create({
    data: { email, name: 'Schema Test', passwordHash: 'not-a-real-hash' },
  });
  created.push(user.id);
  return user.id;
}

export async function removeCreatedUsers(): Promise<void> {
  await db.user.deleteMany({ where: { id: { in: created.splice(0) } } });
}

/**
 * Await a write that must be refused, and return what refused it. Fails the
 * test if the write succeeds, so a guarantee that silently stopped holding
 * cannot pass by throwing nothing.
 */
export async function refused(write: Promise<unknown>): Promise<unknown> {
  try {
    await write;
  } catch (error) {
    return error;
  }
  throw new Error('the write was accepted; the database should have refused it');
}

/** Whether `error` names `constraint`, through either Prisma vocabulary. */
export function names(error: unknown, constraint: string): boolean {
  if (violatedConstraint(error, constraint) || violatedUniqueIndex(error, constraint)) return true;
  const meta = (error as { meta?: { field_name?: unknown } }).meta;
  return typeof meta?.field_name === 'string' && meta.field_name.includes(constraint);
}
