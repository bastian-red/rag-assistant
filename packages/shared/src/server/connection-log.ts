/**
 * Readable, rate-limited logging for a connection that drops and retries.
 *
 * ioredis emits `error` on every reconnect attempt, about every 2 s. Logged
 * as is, a stopped Redis printed a 30-line stack every 2 s from the API and
 * an empty `"error":""` from the publisher, because Node's happy-eyeballs
 * connect fails with an `AggregateError` whose own `message` is empty: the
 * reasons are in `errors` (one per address tried).
 *
 * `ConnectionLog` turns that into three kinds of line: the first failure,
 * with the reason; a reminder while it stays down (every `remindEveryMs`,
 * with the attempt count); and the recovery, with how long it was down.
 */

/** One line for any thrown value; an AggregateError lists its causes. */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const causes = [...new Set(error.errors.map((inner) => describeError(inner)))];
    return error.message === '' ? causes.join('; ') : `${error.message}: ${causes.join('; ')}`;
  }
  if (error instanceof Error) {
    if (error.message !== '') return error.message;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error.name;
  }
  return String(error);
}

export type ConnectionEvent =
  | { readonly event: 'down'; readonly reason: string }
  | {
      readonly event: 'still_down';
      readonly reason: string;
      readonly attempts: number;
      readonly downForMs: number;
    }
  | { readonly event: 'up'; readonly downForMs: number; readonly attempts: number };

export interface ConnectionLogOptions {
  /** Where a line goes. */
  readonly write: (event: ConnectionEvent) => void;
  /** A reminder at most this often while the connection stays down. */
  readonly remindEveryMs?: number;
  readonly now?: () => number;
}

export class ConnectionLog {
  private downSince: number | null = null;
  private lastLine = 0;
  private attempts = 0;
  private readonly remindEveryMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ConnectionLogOptions) {
    this.remindEveryMs = options.remindEveryMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** The connection failed (an `error` event). */
  failed(error: unknown): void {
    const at = this.now();
    const reason = describeError(error);
    this.attempts += 1;
    if (this.downSince === null) {
      this.downSince = at;
      this.lastLine = at;
      this.options.write({ event: 'down', reason });
      return;
    }
    if (at - this.lastLine >= this.remindEveryMs) {
      this.lastLine = at;
      this.options.write({
        event: 'still_down',
        reason,
        attempts: this.attempts,
        downForMs: at - this.downSince,
      });
    }
  }

  /** The connection is usable again (a `ready` event). Silent if it never went down. */
  recovered(): void {
    if (this.downSince === null) return;
    this.options.write({
      event: 'up',
      downForMs: this.now() - this.downSince,
      attempts: this.attempts,
    });
    this.downSince = null;
    this.attempts = 0;
  }
}
