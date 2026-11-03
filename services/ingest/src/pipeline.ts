/**
 * One document, from stored bytes to READY:
 *
 *   load -> PARSING -> read + verify bytes -> parse -> chunk
 *        -> EMBEDDING (progress per batch) -> replace chunks + READY, one transaction
 *
 * Nothing durable is written until the last step, which is what makes a
 * retry, a duplicate job or a worker killed mid-embed safe: running this twice
 * gives the same chunk set as running it once.
 *
 * Throws `IngestRefusal` when the file is the problem and anything else when
 * the world is (the worker decides about retries; see `worker.ts`).
 */
import { chunkDocument, type ChunkInput } from '@rag/chunker';
import type { PrismaClient } from '@rag/db';
import { INGEST_FAILURES, type IngestEvent, type IngestJob } from '@rag/shared';
import { readStoredFile, sha256Of } from '@rag/shared/server';

import { IngestRefusal } from './errors';
import type { Publish } from './events';
import { parseFile, type Parsed } from './parse';
import { loadDocument, replaceChunks, setStatus, type StoredDocument } from './store';

export interface PipelineDeps {
  readonly prisma: PrismaClient;
  /** Embeds one batch, in order. Bound to EMBED_MODEL by the caller. */
  readonly embed: (texts: readonly string[]) => Promise<number[][]>;
  readonly embedModel: string;
  readonly uploadDir: string;
  readonly publish: Publish;
  /** Passages per embed call, and so per progress event. */
  readonly batchSize?: number;
  readonly now?: () => Date;
}

export type Outcome =
  | { readonly kind: 'ready'; readonly chunks: number; readonly pages: number | null }
  /** Deleted, or replaced by a different upload, before or while it ran. */
  | { readonly kind: 'gone' };

const GONE: Outcome = { kind: 'gone' };

function chunkInput(parsed: Parsed): ChunkInput {
  return parsed.format === 'pdf'
    ? { format: 'pdf', pages: parsed.pages }
    : { format: parsed.format, text: parsed.text };
}

export async function ingestDocument(job: IngestJob, deps: PipelineDeps): Promise<Outcome> {
  const batchSize = deps.batchSize ?? 32;
  const now = deps.now ?? (() => new Date());
  const announce = (
    doc: StoredDocument,
    event: Omit<IngestEvent, 'documentId' | 'collectionId' | 'at'>,
  ) =>
    deps.publish(doc.ownerId, {
      documentId: doc.id,
      collectionId: doc.collectionId,
      at: now().toISOString(),
      ...event,
    });

  const doc = await loadDocument(deps.prisma, job.documentId, job.ownerId);
  // A job for bytes this row no longer holds is stale: never ingest them under it.
  if (doc === null || doc.sha256 !== job.sha256) return GONE;

  if (!(await setStatus(deps.prisma, doc, 'PARSING'))) return GONE;
  await announce(doc, { status: 'PARSING', progress: null, error: null });

  const bytes = await readStoredFile(deps.uploadDir, doc.ownerId, doc.sha256);
  if (bytes === null) throw new IngestRefusal(INGEST_FAILURES.fileMissing);
  if (sha256Of(bytes) !== doc.sha256) throw new IngestRefusal(INGEST_FAILURES.fileChanged);

  const parsed = await parseFile(doc.mime, bytes);
  const chunked = chunkDocument(chunkInput(parsed));
  if (chunked.chunks.length === 0) {
    throw new IngestRefusal(
      parsed.format === 'pdf' ? INGEST_FAILURES.noTextLayer : INGEST_FAILURES.empty,
    );
  }

  const total = chunked.chunks.length;
  if (!(await setStatus(deps.prisma, doc, 'EMBEDDING'))) return GONE;
  await announce(doc, { status: 'EMBEDDING', progress: { done: 0, total }, error: null });

  const vectors: number[][] = [];
  for (let at = 0; at < total; at += batchSize) {
    const texts = chunked.chunks.slice(at, at + batchSize).map((chunk) => chunk.text);
    vectors.push(...(await deps.embed(texts)));
    await announce(doc, {
      status: 'EMBEDDING',
      progress: { done: vectors.length, total },
      error: null,
    });
  }

  const written = await replaceChunks(
    deps.prisma,
    doc,
    chunked.chunks,
    vectors,
    deps.embedModel,
    chunked.pageCount,
  );
  if (!written) return GONE;
  await announce(doc, { status: 'READY', progress: null, error: null });
  return { kind: 'ready', chunks: total, pages: chunked.pageCount };
}
