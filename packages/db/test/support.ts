/**
 * Plumbing for the database integration lane. Every helper writes rows with
 * random keys, so tests never collide, and each suite deletes what it made.
 */
import { createHash, randomUUID } from 'node:crypto';

import { createPrismaClient, type PrismaClient } from '../src/client';
import { EMBEDDING_DIMENSIONS } from '../src/constraints';
import { violatedConstraint, violatedUniqueIndex } from '../src/errors';

const url = process.env.DATABASE_URL;
// rag_it, or a throwaway rag_proof database a migration red proof made fresh.
const database = url === undefined || url === '' ? '' : new URL(url).pathname.slice(1);
if (!/^(rag_it|rag_proof[a-z_]*)$/u.test(database)) {
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

// --- the library ---------------------------------------------------------------

export async function newCollection(ownerId: string, name = `c-${randomUUID()}`): Promise<string> {
  const row = await db.collection.create({ data: { ownerId, name } });
  return row.id;
}

/** A valid document row; `overrides` is how each CHECK test breaks one field. */
export function documentData(ownerId: string, collectionId: string, overrides: object = {}) {
  return {
    ownerId,
    collectionId,
    title: 'Boiler manual',
    filename: 'boiler-manual.md',
    mime: 'text/markdown',
    bytes: 1_234,
    sha256: createHash('sha256').update(randomUUID()).digest('hex'),
    ...overrides,
  };
}

export async function newDocument(ownerId: string, collectionId: string): Promise<string> {
  const row = await db.document.create({ data: documentData(ownerId, collectionId) });
  return row.id;
}

/** A deterministic unit vector (mulberry32 from `seed`), as pgvector text. */
export function unit(seed: number, dimensions = EMBEDDING_DIMENSIONS): number[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 - 0.5;
  };
  const raw = Array.from({ length: dimensions }, next);
  const norm = Math.hypot(...raw);
  return raw.map((x) => x / norm);
}

/** `base` moved by `distance` towards a random direction, renormalised. */
export function near(base: number[], distance: number, seed: number): number[] {
  const noise = unit(seed, base.length);
  const moved = base.map((x, i) => x + distance * noise[i]!);
  const norm = Math.hypot(...moved);
  return moved.map((x) => x / norm);
}

export const literal = (vector: number[]): string => `[${vector.join(',')}]`;

export interface ChunkRow {
  ownerId: string;
  documentId: string;
  ord?: number;
  text?: string;
  charStart?: number;
  charEnd?: number;
  pageStart?: number | null;
  pageEnd?: number | null;
  /** Raw JSON, so a test can store a malformed value. */
  pageStarts?: unknown;
  tokens?: number;
  headingPath?: string[] | null;
  embedding?: number[];
  embeddingModel?: string;
}

/**
 * Insert one chunk with raw SQL, the only way to write a halfvec. The defaults
 * make a valid row; a test breaks one field to prove its CHECK.
 */
export async function insertChunk(row: ChunkRow): Promise<string> {
  const id = `ch${randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const text = row.text ?? 'The boiler is serviced every autumn.';
  const charStart = row.charStart ?? 0;
  const embedding = literal(row.embedding ?? unit(1));
  const headingPath = row.headingPath === undefined ? [] : row.headingPath;
  await db.$executeRaw`
    INSERT INTO chunks (id, owner_id, document_id, ord, text, page_start, page_end, page_starts,
                        char_start, char_end, heading_path, tokens, embedding, embedding_model)
    VALUES (${id}, ${row.ownerId}, ${row.documentId}, ${row.ord ?? 0}, ${text},
            ${row.pageStart ?? null}::int, ${row.pageEnd ?? null}::int,
            ${JSON.stringify(row.pageStarts ?? [])}::jsonb,
            ${charStart}, ${row.charEnd ?? charStart + text.length}, ${headingPath}::text[],
            ${row.tokens ?? 8}, ${embedding}::halfvec, ${row.embeddingModel ?? 'qwen3-embedding:0.6b'})`;
  return id;
}

export async function newConversation(ownerId: string, collectionId: string | null = null) {
  const row = await db.conversation.create({ data: { ownerId, collectionId, title: 'Boilers' } });
  return row.id;
}

export async function newAnswer(
  ownerId: string,
  conversationId: string,
  status: 'STREAMING' | 'DONE' | 'STOPPED' = 'DONE',
): Promise<string> {
  const row = await db.message.create({
    data: {
      ownerId,
      conversationId,
      role: 'ASSISTANT',
      status,
      content: 'It is.',
      model: 'qwen3:4b',
    },
  });
  return row.id;
}
