/**
 * The API's end of the ingest queue: it adds a job when a document is
 * uploaded and removes it when the document is deleted. The worker
 * (`services/ingest`) is the only consumer.
 *
 * Its own Redis connection: BullMQ requires `maxRetriesPerRequest: null` on
 * the connections it uses, which is the opposite of what the throttler's
 * connection wants (fail fast, `RedisService`).
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ingestJobOptions, INGEST_QUEUE, type IngestJob } from '@rag/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { API_CONFIG, type ApiConfig } from '../config/config';

@Injectable()
export class IngestQueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.connection.on('error', () => undefined); // RedisService logs the outage once
    this.queue = new Queue(INGEST_QUEUE, { connection: this.connection });
  }

  /** Idempotent: a second add for a document whose job exists is ignored (`jobId`). */
  async enqueue(job: IngestJob): Promise<void> {
    await this.queue.add(INGEST_QUEUE, job, ingestJobOptions(job.documentId));
  }

  /**
   * Drop a document's waiting job. A job already running is locked and stays;
   * the worker then finds the row gone and ends quietly.
   */
  async discard(documentId: string): Promise<void> {
    await this.queue.remove(documentId).catch(() => 0);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
