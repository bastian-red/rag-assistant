/**
 * The BullMQ side: which errors are retried, which end the job, and what a
 * document is left with when its job ends badly.
 *
 * - An `IngestRefusal` (the file is the problem) marks the document FAILED at
 *   once and ends the job with `UnrecoverableError`, so BullMQ does not retry.
 * - Anything else is rethrown for BullMQ's backoff (INGEST_JOB_OPTIONS: five
 *   attempts, 5 s doubling). The LAST attempt marks the document FAILED first,
 *   with the reason that fits (the model server, or "kept failing").
 * - A worker killed mid-job leaves its lock to expire; another worker's
 *   stalled check moves the job back to waiting and it runs again from the
 *   start. A job that stalls more than `maxStalledCount` times is failed by
 *   BullMQ itself, and the `failed` listener marks the document.
 */
import type { PrismaClient } from '@rag/db';
import { INGEST_QUEUE, ingestJobSchema, type IngestJob } from '@rag/shared';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { finalReason, refusalOf, type IngestFailure } from './errors';
import type { Publish } from './events';
import { ingestDocument, type Outcome, type PipelineDeps } from './pipeline';
import { markFailed } from './store';

export interface WorkerOptions {
  readonly connection: Redis;
  readonly concurrency: number;
  readonly lockMs: number;
  readonly log?: (line: string) => void;
}

const STALLED = /stalled more than allowable limit/iu;

/** Mark a document FAILED and say so on its owner's channel. */
export async function failDocument(
  prisma: PrismaClient,
  publish: Publish,
  job: IngestJob,
  reason: IngestFailure,
  now: () => Date = () => new Date(),
): Promise<void> {
  const doc = await prisma.document.findFirst({
    where: { id: job.documentId, ownerId: job.ownerId },
    select: { collectionId: true },
  });
  if (doc === null || !(await markFailed(prisma, job.documentId, job.ownerId, reason))) return;
  await publish(job.ownerId, {
    documentId: job.documentId,
    collectionId: doc.collectionId,
    status: 'FAILED',
    progress: null,
    error: reason,
    at: now().toISOString(),
  });
}

/** The processor, apart from BullMQ, so a test can drive it with a plain object. */
export function processor(deps: PipelineDeps) {
  return async (job: Pick<Job, 'data' | 'attemptsMade' | 'opts'>): Promise<Outcome> => {
    const parsed = ingestJobSchema.safeParse(job.data);
    // A malformed job is a bug in whoever added it; retrying cannot fix it.
    if (!parsed.success) throw new UnrecoverableError('not an ingest job');
    const data = parsed.data;
    try {
      return await ingestDocument(data, deps);
    } catch (error) {
      const refusal = refusalOf(error);
      const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (refusal !== null || last) {
        await failDocument(deps.prisma, deps.publish, data, finalReason(error), deps.now);
      }
      if (refusal !== null) throw new UnrecoverableError(refusal.reason);
      throw error;
    }
  };
}

export function startWorker(deps: PipelineDeps, options: WorkerOptions): Worker {
  const log = options.log ?? ((line: string) => console.warn(line));
  const worker = new Worker(INGEST_QUEUE, processor(deps), {
    connection: options.connection,
    concurrency: options.concurrency,
    lockDuration: options.lockMs,
    stalledInterval: options.lockMs,
    // A worker killed twice on the same document is a pattern, not bad luck
    // (a file that crashes the process): the third stall fails the job.
    maxStalledCount: 2,
  });
  worker.on('completed', (job, outcome: Outcome) => {
    log(
      `[ingest] ${job.id ?? '?'} ${outcome.kind === 'ready' ? `READY ${String(outcome.chunks)} chunks` : 'gone'}`,
    );
  });
  worker.on('failed', (job, error) => {
    log(
      `[ingest] ${job?.id ?? '?'} attempt ${String(job?.attemptsMade ?? 0)} failed: ${error.message}`,
    );
    // BullMQ failed it without running the processor: the stall limit.
    if (job !== undefined && STALLED.test(error.message)) {
      const data = ingestJobSchema.safeParse(job.data);
      if (data.success) {
        failDocument(deps.prisma, deps.publish, data.data, finalReason(error), deps.now).catch(
          (cause: unknown) =>
            log(`[ingest] could not mark ${data.data.documentId} FAILED: ${String(cause)}`),
        );
      }
    }
  });
  worker.on('error', (error) => log(`[ingest] worker error: ${error.message}`));
  return worker;
}
