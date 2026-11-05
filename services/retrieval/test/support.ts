/**
 * The integration lane's helpers: real Postgres (rag_it, from
 * scripts/integration.sh), chunks written the way the ingest worker writes
 * them (the chunker's output, one raw INSERT with a halfvec cast), and
 * vectors from the fake's hash embedding, in process, so rankings are
 * deterministic and no model server is needed.
 *
 * Every test makes its own people and deletes them after; the cascade takes
 * their collections, documents and chunks.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { chunkDocument } from '@rag/chunker';
import { createPrismaClient, Prisma, type PrismaClient } from '@rag/db';
import { fakeDigest, hashEmbedding } from '@rag/llm';
import { embeddingSpace, type DocumentStatus } from '@rag/shared';

import { vectorLiteral, type RetrievalDeps } from '../src';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '')
  throw new Error('DATABASE_URL is not set (run scripts/integration.sh)');
export const db: PrismaClient = createPrismaClient({ url });

/** The space these tests embed in: the fake's, under the real model's name. */
export const SPACE = embeddingSpace('qwen3-embedding:0.6b', fakeDigest('qwen3-embedding:0.6b'));

export const deps: RetrievalDeps = {
  prisma: db,
  embed: async (texts) => texts.map((t) => hashEmbedding(t)),
  embeddingSpace: async () => SPACE,
};

const made: string[] = [];

export async function newPerson(label: string): Promise<{ id: string; collectionId: string }> {
  const user = await db.user.create({
    data: {
      email: `retrieval-${label}-${randomUUID()}@test.invalid`,
      name: `Retrieval ${label}`,
      passwordHash: 'not-a-real-hash',
    },
  });
  made.push(user.id);
  const collection = await db.collection.create({ data: { ownerId: user.id, name: 'Shelf' } });
  return { id: user.id, collectionId: collection.id };
}

export async function newCollection(ownerId: string, name: string): Promise<string> {
  return (await db.collection.create({ data: { ownerId, name } })).id;
}

export async function forgetPeople(): Promise<void> {
  await db.user.deleteMany({ where: { id: { in: made.splice(0) } } });
}

const chunkId = () => `c${randomBytes(12).toString('hex')}`;

export interface AddedDocument {
  readonly id: string;
  readonly chunkIds: string[];
}

/**
 * A markdown document with its chunks, as the worker would leave it.
 * `status` and `space` let a test write what the worker would not.
 */
export async function addDocument(
  person: { id: string; collectionId: string },
  title: string,
  text: string,
  options: { status?: DocumentStatus; space?: string; collectionId?: string } = {},
): Promise<AddedDocument> {
  const doc = await db.document.create({
    data: {
      ownerId: person.id,
      collectionId: options.collectionId ?? person.collectionId,
      title,
      filename: `${title}.md`,
      mime: 'text/markdown',
      bytes: new TextEncoder().encode(text).byteLength,
      sha256: randomBytes(32).toString('hex'),
      status: options.status ?? 'READY',
    },
  });
  const chunks = chunkDocument({ format: 'markdown', text }).chunks;
  const ids = chunks.map(() => chunkId());
  for (let at = 0; at < chunks.length; at += 100) {
    const rows = chunks.slice(at, at + 100).map((chunk, offset) => {
      return Prisma.sql`(
        ${ids[at + offset]!}, ${person.id}, ${doc.id}, ${chunk.ord}, ${chunk.text},
        ${chunk.pageStart}::int, ${chunk.pageEnd}::int, ${JSON.stringify(chunk.pageStarts)}::jsonb,
        ${chunk.charStart}, ${chunk.charEnd}, ${[...chunk.headingPath]}::text[], ${chunk.tokens},
        ${vectorLiteral(hashEmbedding(chunk.text))}::halfvec, ${options.space ?? SPACE}
      )`;
    });
    await db.$executeRaw`
      INSERT INTO "chunks" (
        "id", "owner_id", "document_id", "ord", "text",
        "page_start", "page_end", "page_starts",
        "char_start", "char_end", "heading_path", "tokens",
        "embedding", "embedding_model"
      ) VALUES ${Prisma.join(rows)}`;
  }
  return { id: doc.id, chunkIds: ids };
}

export async function closeSupport(): Promise<void> {
  await forgetPeople();
  await db.$disconnect();
}
