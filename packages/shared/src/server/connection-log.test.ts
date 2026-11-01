import { connect } from 'node:net';

import { describe, expect, it } from 'vitest';

import { ConnectionLog, describeError, type ConnectionEvent } from './connection-log';

/** A real happy-eyeballs refusal: what ioredis emits when Redis is stopped. */
function refusal(): Promise<Error> {
  return new Promise((resolve) => {
    // Port 9 (discard) is closed on any machine this runs on.
    const socket = connect({ host: 'localhost', port: 9, autoSelectFamily: true });
    socket.on('error', resolve);
  });
}

describe('describeError', () => {
  it('names every address an AggregateError tried, where its own message is empty', async () => {
    const error = await refusal();
    expect(error.message).toBe('');
    const text = describeError(error);
    expect(text).toMatch(/^connect ECONNREFUSED /u);
    expect(text).toContain('127.0.0.1:9');
  });

  it('keeps an aggregate message, dedupes causes, and falls back to the code', () => {
    const inner = new Error('boom');
    expect(describeError(new AggregateError([inner, new Error('boom')], 'outer'))).toBe(
      'outer: boom',
    );
    expect(describeError(Object.assign(new Error(''), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(describeError('plain')).toBe('plain');
  });
});

describe('ConnectionLog', () => {
  function harness(remindEveryMs = 60_000) {
    let t = 1_000;
    const lines: ConnectionEvent[] = [];
    const log = new ConnectionLog({ write: (e) => lines.push(e), remindEveryMs, now: () => t });
    return { log, lines, advance: (ms: number) => (t += ms) };
  }

  it('logs the first failure, then nothing for the retries inside the reminder window', () => {
    const { log, lines, advance } = harness();
    for (let i = 0; i < 29; i += 1) {
      log.failed(new Error('connect ECONNREFUSED 127.0.0.1:6390'));
      advance(2_000);
    }
    // 29 attempts over 58 s: one line, not 29.
    expect(lines).toEqual([{ event: 'down', reason: 'connect ECONNREFUSED 127.0.0.1:6390' }]);
  });

  it('reminds once a window while down, with the count, then says when it is back', () => {
    const { log, lines, advance } = harness(10_000);
    for (let i = 0; i < 12; i += 1) {
      log.failed(new Error('refused'));
      advance(2_000);
    }
    log.recovered();
    expect(lines).toEqual([
      { event: 'down', reason: 'refused' },
      { event: 'still_down', reason: 'refused', attempts: 6, downForMs: 10_000 },
      { event: 'still_down', reason: 'refused', attempts: 11, downForMs: 20_000 },
      { event: 'up', downForMs: 24_000, attempts: 12 },
    ]);
  });

  it('is silent on a recovery that followed no failure, and starts over after one', () => {
    const { log, lines, advance } = harness();
    log.recovered();
    expect(lines).toEqual([]);
    log.failed(new Error('a'));
    advance(500);
    log.recovered();
    log.failed(new Error('b'));
    expect(lines.map((l) => l.event)).toEqual(['down', 'up', 'down']);
  });
});
