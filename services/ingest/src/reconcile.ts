/**
 * On start, every unfinished document gets its job back.
 *
 * A document can be QUEUED with no job: the API wrote the row and died
 * before `queue.add`, Redis lost its data, or the seed wrote it. Adding is
 * safe to repeat because the job id is the document id: BullMQ ignores an
 * `add` for an id that already exists, so a document whose job is waiting or
 * running is not queued twice.
 */
import type { PrismaClient } from '@rag/db';
import { ingestJobOptions, INGEST_QUEUE, type IngestJob } from '@rag/shared';
import type { Queue } from 'bullmq';

import { unfinishedDocuments } from './store';

export async function reconcile(prisma: PrismaClient, queue: Queue): Promise<number> {
  const documents = await unfinishedDocuments(prisma);
  if (documents.length === 0) return 0;
  await queue.addBulk(
    documents.map((doc) => ({
      name: INGEST_QUEUE,
      data: { documentId: doc.id, ownerId: doc.ownerId, sha256: doc.sha256 } satisfies IngestJob,
      opts: ingestJobOptions(doc.id),
    })),
  );
  return documents.length;
}
