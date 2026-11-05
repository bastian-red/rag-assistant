/**
 * Every document that should have a job gets one: at start, and once a
 * minute after.
 *
 * Two kinds:
 *
 * - **Unfinished** (QUEUED, PARSING, EMBEDDING) with no job: the API wrote
 *   the row and died before `queue.add`, Redis lost its data, or the seed
 *   wrote it.
 * - **Stale**: READY, but some of its chunks were embedded in another vector
 *   space than the one the model server reports now (`embeddingSpace`): the
 *   model was re-pulled or changed, or the chunks came from the fake model
 *   server, which answers to the real model's name. Retrieval never searches
 *   them (it filters on the space), so until they are embedded again the
 *   document is invisible to questions. Re-ingesting replaces the whole set.
 *
 * Adding is safe to repeat because the job id is the document id: BullMQ
 * ignores an `add` for an id that already exists, so a document whose job is
 * waiting, delayed for a retry or running is not queued twice.
 */
import type { PrismaClient } from '@rag/db';
import { ingestJobOptions, INGEST_QUEUE, type IngestJob } from '@rag/shared';
import type { Queue } from 'bullmq';

import { staleDocuments, unfinishedDocuments } from './store';

export interface Reconciled {
  readonly unfinished: number;
  /** null when the current space could not be read (model server down): not checked. */
  readonly stale: number | null;
}

export async function reconcile(
  prisma: PrismaClient,
  queue: Pick<Queue, 'addBulk'>,
  space: string | null,
): Promise<Reconciled> {
  const unfinished = await unfinishedDocuments(prisma);
  const stale = space === null ? null : await staleDocuments(prisma, space);
  const documents = [...unfinished, ...(stale ?? [])];
  if (documents.length > 0) {
    await queue.addBulk(
      documents.map((doc) => ({
        name: INGEST_QUEUE,
        data: { documentId: doc.id, ownerId: doc.ownerId, sha256: doc.sha256 } satisfies IngestJob,
        opts: ingestJobOptions(doc.id),
      })),
    );
  }
  return { unfinished: unfinished.length, stale: stale === null ? null : stale.length };
}
