/**
 * The worker assembled: Postgres, Redis, the model client, the queue
 * consumer, the start-up reconcile and the health server. `main.ts` runs it;
 * the crash test runs it in a child it can kill.
 */
import { createPrismaClient } from '@rag/db';
import { createOllama } from '@rag/llm';
import { INGEST_QUEUE } from '@rag/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { IngestConfig } from './config';
import { redisPublisher } from './events';
import { healthReporter, startHealthServer } from './health';
import { reconcile } from './reconcile';
import { startWorker } from './worker';

export interface RunningIngest {
  readonly port: number;
  close(): Promise<void>;
}

export async function startIngest(
  config: IngestConfig,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<RunningIngest> {
  const prisma = createPrismaClient({ url: config.databaseUrl });
  // Two connections: BullMQ's consumer blocks on its own (and requires
  // `maxRetriesPerRequest: null`), and a publish must never queue behind it.
  const queueConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  const ollama = createOllama({ baseUrl: config.ollamaUrl });
  const publish = redisPublisher(redis);

  const deps = {
    prisma,
    embed: (texts: readonly string[]) => ollama.embed(config.embedModel, texts),
    embedModel: config.embedModel,
    uploadDir: config.uploadDir,
    publish,
  };
  const worker = startWorker(deps, {
    connection: queueConnection,
    concurrency: config.concurrency,
    lockMs: config.lockMs,
    log,
  });
  const queue = new Queue(INGEST_QUEUE, { connection: queueConnection });
  const queued = await reconcile(prisma, queue);
  if (queued > 0) log(`[ingest] queued ${String(queued)} unfinished document(s) found at start`);

  const server = await startHealthServer(
    healthReporter({
      prisma,
      redis,
      ollama,
      embedModel: config.embedModel,
      uploadDir: config.uploadDir,
      version: config.appVersion,
      workerRunning: () => worker.isRunning(),
    }),
    config.port,
  );
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  log(
    `[ingest] health on :${String(port)}, consuming '${INGEST_QUEUE}' x${String(config.concurrency)}`,
  );

  return {
    port,
    close: async () => {
      // The consumer first, so no job starts on connections about to close.
      await worker.close();
      await queue.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      queueConnection.disconnect();
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}
