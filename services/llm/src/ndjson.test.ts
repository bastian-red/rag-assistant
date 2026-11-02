import { describe, expect, it } from 'vitest';

import { lines } from './ndjson';

function body(parts: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
      }
      controller.close();
    },
  });
}

async function all(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines(stream)) out.push(line);
  return out;
}

describe('lines', () => {
  it('joins a line split across reads and skips blank lines', async () => {
    expect(await all(body(['{"a":', '1}\n\n{"b"', ':2}\n']))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('keeps a last line that has no newline', async () => {
    expect(await all(body(['{"a":1}\n{"done":true}']))).toEqual(['{"a":1}', '{"done":true}']);
  });

  it('decodes a character split across reads', async () => {
    const bytes = new TextEncoder().encode('{"t":"é🙂"}\n');
    const parts = [bytes.slice(0, 7), bytes.slice(7, 9), bytes.slice(9)];
    expect(await all(body(parts))).toEqual(['{"t":"é🙂"}']);
  });

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const line of lines(stream)) {
      expect(line).toBe('{"a":1}');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
