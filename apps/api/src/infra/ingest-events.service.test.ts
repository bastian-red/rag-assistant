import { describe, expect, it } from 'vitest';

import type { ApiConfig } from '../config/config';
import { IngestEventsService } from './ingest-events.service';

const OWNER = 'cmvyipu990000jh1klg0198zp';

describe('IngestEventsService', () => {
  // A failed subscribe ends the stream, and the teardown drops the channel, so
  // the next stream for this person (after Redis is back) subscribes afresh.
  it('forgets a channel whose subscribe failed, so the next stream retries', async () => {
    // Nothing listens on port 1: the connect fails without a Redis.
    const service = new IngestEventsService({ redisUrl: 'redis://127.0.0.1:1' } as ApiConfig);
    const failed = await new Promise<unknown>((resolve) => {
      service.stream(OWNER).subscribe({ error: resolve });
    });
    expect(failed).toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.channels).toBe(0);
    service.onModuleDestroy();
  });
});
