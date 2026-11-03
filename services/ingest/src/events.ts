/**
 * What the worker announces as a document moves: one message on the owner's
 * Redis channel per change of state, and one per embedded batch. The API's
 * `GET /documents/events` subscribes to the signed-in person's channel only.
 *
 * Fire-and-forget by design: pub/sub has no history, and the page that shows
 * progress also re-reads the list when its stream (re)connects, so a lost
 * message costs a stale bar, never a wrong state.
 */
import { ingestChannel, ingestEventSchema, type IngestEvent } from '@rag/shared';
import type { Redis } from 'ioredis';

export type Publish = (ownerId: string, event: IngestEvent) => Promise<void>;

export function redisPublisher(redis: Redis): Publish {
  return async (ownerId, event) => {
    await redis.publish(ingestChannel(ownerId), JSON.stringify(ingestEventSchema.parse(event)));
  };
}
