/**
 * What every feature module needs: the config, Postgres, Redis, the model
 * server client, and the ingest queue and its event stream.
 *
 * `@Global()`, which this codebase otherwise avoids. The justification is narrow
 * and worth stating: these are process-level singletons with a lifecycle, and the
 * alternative is importing this module into every feature module, where a
 * forgotten import is a runtime injection error rather than a compile error. A
 * global module for connections is a different thing from a global module for
 * business logic, and nothing with business logic goes in here.
 */
import { Global, Module } from '@nestjs/common';
import { createOllama, type Ollama } from '@rag/llm';

import { API_CONFIG, loadConfig, type ApiConfig } from '../config/config';
import { IngestEventsService } from './ingest-events.service';
import { IngestQueueService } from './ingest-queue.service';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

/** The injection token for the `@rag/llm` client. */
export const OLLAMA = 'OLLAMA';

@Global()
@Module({
  providers: [
    {
      provide: API_CONFIG,
      // Parsed once here. `main.ts` calls `loadConfig()` too, before the
      // application exists, so a bad environment fails with a plain sentence
      // rather than a Nest bootstrap stack; both calls are pure and agree.
      useFactory: (): ApiConfig => loadConfig(),
    },
    {
      provide: OLLAMA,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): Ollama => createOllama({ baseUrl: config.ollamaUrl }),
    },
    PrismaService,
    RedisService,
    IngestQueueService,
    IngestEventsService,
  ],
  exports: [
    API_CONFIG,
    OLLAMA,
    PrismaService,
    RedisService,
    IngestQueueService,
    IngestEventsService,
  ],
})
export class InfraModule {}
