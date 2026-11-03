/**
 * Every write the worker makes to Postgres.
 *
 * Two rules hold here, and the integration tests hold them:
 *
 * - **Chunks are replaced, never appended.** One transaction locks the
 *   document row, deletes its chunks and inserts the new set, then marks it
 *   READY. A worker killed anywhere before COMMIT leaves the old state; a
 *   second worker running the same document after a lost lock waits on the
 *   row lock and then replaces the first one's set. Either way the document
 *   ends with exactly one gap-free chunk set.
 * - **A deleted document stays deleted.** Every write is conditioned on the
 *   row still existing, so a document removed mid-ingest is never
 *   recreated, and the job ends quietly.
 */
import { randomBytes } from 'node:crypto';

import type { Chunk } from '@rag/chunker';
import { Prisma, type PrismaClient } from '@rag/db';
import {
  acceptedTypeSchema,
  IN_PROGRESS_STATUSES,
  type AcceptedType,
  type DocumentStatus,
} from '@rag/shared';

export interface StoredDocument {
  readonly id: string;
  readonly ownerId: string;
  readonly collectionId: string;
  readonly mime: AcceptedType;
  readonly sha256: string;
}

/** Rows per INSERT: 100 rows x 14 parameters stays far below Postgres's 65535. */
const INSERT_ROWS = 100;
/** A 20 MiB text is about 10,000 chunks; the default 5 s would end that transaction. */
const REPLACE_TIMEOUT_MS = 120_000;

/** A cuid-shaped id (lowercase alphanumerics, 25 characters), as `idSchema` holds. */
export function chunkId(): string {
  return `c${randomBytes(12).toString('hex')}`;
}

/** pgvector's text form. `String(number)` gives the shortest round-trip form, which it parses. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map(String).join(',')}]`;
}

export async function loadDocument(
  prisma: PrismaClient,
  id: string,
  ownerId: string,
): Promise<StoredDocument | null> {
  const row = await prisma.document.findFirst({
    where: { id, ownerId },
    select: { id: true, ownerId: true, collectionId: true, mime: true, sha256: true },
  });
  return row === null ? null : { ...row, mime: acceptedTypeSchema.parse(row.mime) };
}

/** Move a live document to PARSING or EMBEDDING. False when it is gone. */
export async function setStatus(
  prisma: PrismaClient,
  doc: StoredDocument,
  status: Extract<DocumentStatus, 'PARSING' | 'EMBEDDING'>,
): Promise<boolean> {
  const { count } = await prisma.document.updateMany({
    where: { id: doc.id, ownerId: doc.ownerId },
    data: { status, error: null },
  });
  return count === 1;
}

/**
 * The one transaction that makes a document READY. False when the document
 * was deleted while it was being embedded (nothing is written).
 */
export async function replaceChunks(
  prisma: PrismaClient,
  doc: StoredDocument,
  chunks: readonly Chunk[],
  vectors: readonly (readonly number[])[],
  embeddingModel: string,
  pages: number | null,
): Promise<boolean> {
  if (vectors.length !== chunks.length) {
    throw new Error(`${String(vectors.length)} vectors for ${String(chunks.length)} chunks`);
  }
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "documents"
        WHERE "id" = ${doc.id} AND "owner_id" = ${doc.ownerId}
        FOR UPDATE`;
      if (locked.length === 0) return false;
      await tx.$executeRaw`DELETE FROM "chunks" WHERE "document_id" = ${doc.id}`;
      for (let at = 0; at < chunks.length; at += INSERT_ROWS) {
        const rows = chunks.slice(at, at + INSERT_ROWS).map((chunk, offset) => {
          const vector = vectors[at + offset]!;
          return Prisma.sql`(
            ${chunkId()}, ${doc.ownerId}, ${doc.id}, ${chunk.ord}, ${chunk.text},
            ${chunk.pageStart}::int, ${chunk.pageEnd}::int, ${JSON.stringify(chunk.pageStarts)}::jsonb,
            ${chunk.charStart}, ${chunk.charEnd}, ${[...chunk.headingPath]}::text[], ${chunk.tokens},
            ${vectorLiteral(vector)}::halfvec, ${embeddingModel}
          )`;
        });
        await tx.$executeRaw`
          INSERT INTO "chunks" (
            "id", "owner_id", "document_id", "ord", "text",
            "page_start", "page_end", "page_starts",
            "char_start", "char_end", "heading_path", "tokens",
            "embedding", "embedding_model"
          ) VALUES ${Prisma.join(rows)}`;
      }
      await tx.document.update({
        where: { id: doc.id },
        data: { status: 'READY', error: null, pages },
      });
      return true;
    },
    { timeout: REPLACE_TIMEOUT_MS, maxWait: 10_000 },
  );
}

/**
 * FAILED, with the reason, and no chunks: a document that failed is never
 * searched with a stale or partial set. False when it is gone.
 */
export async function markFailed(
  prisma: PrismaClient,
  id: string,
  ownerId: string,
  reason: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.document.updateMany({
      where: { id, ownerId },
      data: { status: 'FAILED', error: reason },
    });
    if (count === 0) return false;
    await tx.chunk.deleteMany({ where: { documentId: id, ownerId } });
    return true;
  });
}

/** Documents that should have a job: not finished, not failed. */
export async function unfinishedDocuments(
  prisma: PrismaClient,
): Promise<{ id: string; ownerId: string; sha256: string }[]> {
  return prisma.document.findMany({
    where: { status: { in: [...IN_PROGRESS_STATUSES] } },
    select: { id: true, ownerId: true, sha256: true },
    orderBy: { createdAt: 'asc' },
  });
}
