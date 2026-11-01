/**
 * The API's Redis connection.
 *
 * The throttler's storage today; from build step 5 the API also enqueues
 * ingest jobs through BullMQ, which opens its own connections. Nothing here is
 * a source of truth. One connection is enough because this process never
 * subscribes to anything.
 *
 * The throttler's storage is Redis rather than the default in-memory one because
 * a limit that resets when a process restarts, and that counts separately on each
 * replica, is not a limit.
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConnectionLog } from '@rag/shared/server';
import { Redis } from 'ioredis';

import { API_CONFIG, type ApiConfig } from '../config/config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.client = new Redis(config.redisUrl, {
      // Fail rather than queue. The default buffers commands issued before the
      // connection is up and replays them later, which would let `/health` pass
      // against a Redis that is not there.
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    // Attached in the constructor, before anything can connect. ioredis emits
    // `error` on a blip, and an EventEmitter with no `error` listener throws --
    // in Node an uncaught exception that takes the whole API down because Redis
    // hiccuped for 200ms.
    // ioredis retries about every 2 s and emits `error` on each attempt; the
    // log says when it went down, reminds once a minute, and says when it is back.
    const connection = new ConnectionLog({
      write: (line) => {
        if (line.event === 'up')
          console.info(`[api] redis is back after ${String(Math.round(line.downForMs / 1000))} s`);
        else
          console.error(
            line.event === 'down'
              ? `[api] redis unreachable (${line.reason}); retrying, /health reports it`
              : `[api] redis still unreachable after ${String(Math.round(line.downForMs / 1000))} s, ${String(line.attempts)} attempts (${line.reason})`,
          );
      },
    });
    this.client.on('error', (error) => connection.failed(error));
    this.client.on('ready', () => connection.recovered());
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    // `quit`, not `disconnect`: it waits for in-flight replies rather than
    // cutting the socket under one.
    await this.client.quit();
  }
}
