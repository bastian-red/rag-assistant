/**
 * The database connection, owned by the Nest lifecycle.
 *
 * One client per process, connected at boot and returned on shutdown
 * (`main.ts` enables the hooks). Feature services take this and nothing else;
 * none of them constructs a client of its own, so the pool size is one decision.
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@rag/db';

import { API_CONFIG, type ApiConfig } from '../config/config';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.client = createPrismaClient({ url: config.databaseUrl });
  }

  /** A real round trip: a pool that believes it is connected can still be talking to nobody. */
  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
