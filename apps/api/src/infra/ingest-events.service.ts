/**
 * The ingest worker's announcements, fanned out to the open event streams.
 *
 * One subscriber connection for the whole process, not one per browser tab:
 * a channel is subscribed when its first stream opens and unsubscribed when
 * its last one closes. Channels are per owner (`ingestChannel`), so a stream
 * only ever receives its own person's events; the routing below is a second
 * filter, never the only one.
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ingestChannel, ingestEventSchema, type IngestEvent } from '@rag/shared';
import { Redis } from 'ioredis';
import { Observable } from 'rxjs';

import { API_CONFIG, type ApiConfig } from '../config/config';

type Listener = (event: IngestEvent) => void;

@Injectable()
export class IngestEventsService implements OnModuleDestroy {
  private readonly subscriber: Redis;
  private readonly listeners = new Map<string, { set: Set<Listener>; ready: Promise<void> }>();

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.subscriber = new Redis(config.redisUrl, { lazyConnect: true });
    this.subscriber.on('error', () => undefined); // RedisService logs the outage once
    this.subscriber.on('message', (channel: string, message: string) => {
      const parsed = ingestEventSchema.safeParse(safeJson(message));
      if (!parsed.success) return;
      for (const listener of this.listeners.get(channel)?.set ?? []) listener(parsed.data);
    });
  }

  /**
   * Every event for one person's documents, from now until unsubscribed.
   * The first item is `'subscribed'`, once Redis has confirmed the channel:
   * from that moment no event for this person can be missed, so a client
   * that re-reads the list on it has a gap-free view.
   */
  stream(ownerId: string): Observable<IngestEvent | 'subscribed'> {
    const channel = ingestChannel(ownerId);
    return new Observable<IngestEvent | 'subscribed'>((subscriber) => {
      const listener: Listener = (event) => subscriber.next(event);
      let entry = this.listeners.get(channel);
      if (entry === undefined) {
        entry = { set: new Set(), ready: this.subscribe(channel) };
        this.listeners.set(channel, entry);
      }
      entry.set.add(listener);
      entry.ready.then(
        () => subscriber.next('subscribed'),
        (error: unknown) => subscriber.error(error),
      );
      return () => {
        const current = this.listeners.get(channel);
        current?.set.delete(listener);
        if (current?.set.size === 0) {
          this.listeners.delete(channel);
          void current.ready
            .then(() => this.subscriber.unsubscribe(channel))
            .catch(() => undefined);
        }
      };
    });
  }

  /** How many channels are subscribed: the leak check in the tests reads it. */
  get channels(): number {
    return this.listeners.size;
  }

  private connecting: Promise<void> | null = null;

  private async subscribe(channel: string): Promise<void> {
    if (this.subscriber.status === 'wait') this.connecting ??= this.subscriber.connect();
    if (this.connecting !== null) await this.connecting;
    await this.subscriber.subscribe(channel);
  }

  onModuleDestroy(): void {
    this.subscriber.disconnect();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
