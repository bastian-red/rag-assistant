/**
 * What the client does at the edges the real server rarely shows on demand:
 * a model that never starts, one that stalls, one that crashes mid-answer,
 * reasoning in either of its two forms, and replies in the wrong shape.
 * The happy path and the stop are in the contract suite, against both servers.
 */
import type { ChatEvent } from '@rag/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startFakeOllama, type FakeChatScript, type FakeOllama } from './fake/server';
import { createOllama, LlmError, type OllamaOptions } from './ollama';

const CHAT = 'qwen3:4b-instruct';
const ask = [{ role: 'user' as const, content: 'Hello?' }];

let fake: FakeOllama | undefined;

// The first fetch in a worker spends ~180 ms setting up its HTTP client, which
// would let a 100 ms timeout fire before the request ever reached the fake.
beforeAll(async () => {
  const warm = await startFakeOllama({ models: [] });
  await fetch(`${warm.url}/api/version`).then((r) => r.text());
  await warm.close();
});

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function serve(script: Partial<FakeChatScript>) {
  fake = await startFakeOllama({ models: [CHAT, 'qwen3-embedding:0.6b'], script });
  return fake;
}

async function run(options: Partial<OllamaOptions> = {}, model = CHAT) {
  const ollama = createOllama({ baseUrl: fake!.url, ...options });
  const events: ChatEvent[] = [];
  for await (const event of ollama.chat(model, ask)) events.push(event);
  return events;
}

const text = (events: readonly ChatEvent[]) =>
  events.map((e) => (e.type === 'token' ? e.text : '')).join('');
const usage = (events: readonly ChatEvent[]) => {
  const last = events.at(-1);
  if (last?.type !== 'done') throw new Error('no done event');
  return last.usage;
};
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(LlmError);
      return error as LlmError;
    },
  );

describe('what the client asks for', () => {
  it('asks for no reasoning, a stream and the context window, every time', async () => {
    await serve({ answer: 'Hi.' });
    await run({ chat: { contextTokens: 4096 } });
    expect(fake!.chats[0]).toMatchObject({
      model: CHAT,
      think: false,
      options: { num_ctx: 4096 },
      completed: true,
    });
  });

  it('refuses an empty conversation before sending anything', async () => {
    await serve({});
    const ollama = createOllama({ baseUrl: fake!.url });
    const error = await failure(
      (async () => {
        for await (const _ of ollama.chat(CHAT, [])) void _;
      })(),
    );
    expect(error.code).toBe('refused');
    expect(fake!.chats).toHaveLength(0);
  });
});

describe('reasoning never reaches the reader', () => {
  it('drops the thinking field and counts it', async () => {
    fake = await startFakeOllama({
      models: [CHAT],
      script: { answer: 'Hi there.', thinking: 'plan it' },
    });
    // The fake emits the field only when thinking is allowed; force it the way
    // a server that ignores `think: false` would.
    const events: ChatEvent[] = [];
    const ollama = createOllama({
      baseUrl: fake.url,
      fetch: ((url: string, init: RequestInit) =>
        fetch(url, {
          ...init,
          body: String(init.body).replace('"think":false', '"think":true'),
        })) as typeof fetch,
    });
    for await (const event of ollama.chat(CHAT, ask)) events.push(event);
    expect(text(events)).toBe('Hi there.');
    expect(usage(events).thinkingDropped).toBe(7);
  });

  it('strips a <think> block written into the answer, and the blank line after it', async () => {
    await serve({
      answer: 'The gauge reads 1.5 bar [S1].',
      thinking: 'the user wants the pressure',
    });
    const events = await run();
    expect(text(events)).toBe('The gauge reads 1.5 bar [S1].');
    expect(usage(events).thinkingDropped).toBe(27);
  });
});

describe('the two clocks', () => {
  it('gives up when the first token never comes', async () => {
    await serve({ answer: 'Hi.', firstTokenDelayMs: 2000 });
    const started = Date.now();
    const error = await failure(run({ chat: { firstTokenTimeoutMs: 100 } }));
    expect(error.code).toBe('timeout');
    expect(error.message).toMatch(/no first token within 100 ms/u);
    expect(Date.now() - started).toBeLessThan(1500);
    await expect.poll(() => fake!.chats[0]?.aborted).toBe(true);
  });

  it('gives up when the answer stalls, and closes the request', async () => {
    await serve({ answer: 'One two three four five six.', stallAfter: 2 });
    const error = await failure(run({ chat: { idleTimeoutMs: 100 } }));
    expect(error.code).toBe('timeout');
    expect(error.message).toMatch(/no next token within 100 ms/u);
    await expect.poll(() => fake!.chats[0]?.aborted).toBe(true);
  });

  it('does not count a slow consumer as a silent model', async () => {
    await serve({ answer: 'One two three.' });
    const ollama = createOllama({ baseUrl: fake!.url, chat: { idleTimeoutMs: 50 } });
    const tokens: string[] = [];
    for await (const event of ollama.chat(CHAT, ask)) {
      if (event.type === 'token') tokens.push(event.text);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    expect(tokens.join('')).toBe('One two three.');
  });

  it('reports the first visible token and the total, measured by the client', async () => {
    await serve({ answer: 'Hi there.', firstTokenDelayMs: 60 });
    const u = usage(await run());
    expect(u.firstTokenMs).toBeGreaterThanOrEqual(55);
    expect(u.totalMs).toBeGreaterThanOrEqual(u.firstTokenMs ?? 0);
    expect(u.outputTokens).toBe(3); // 'Hi', ' th', 'ere.'
    expect(u.stopReason).toBe('stop');
  });
});

describe('a stop is a stop', () => {
  it('lets no further token through after an abort, even ones already read', async () => {
    // Three tokens and the end in ONE network read, as a fast server sends them.
    const line = (content: string) => JSON.stringify({ message: { content }, done: false });
    const body = `${[line('One'), line(' two'), line(' three')].join('\n')}\n{"done":true}\n`;
    const ollama = createOllama({
      baseUrl: 'http://x',
      fetch: (async () => new Response(body)) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const seen: string[] = [];
    const error = await failure(
      (async () => {
        for await (const event of ollama.chat(CHAT, ask, { signal: controller.signal })) {
          if (event.type === 'token') seen.push(event.text);
          controller.abort();
        }
      })(),
    );
    expect(error.code).toBe('aborted');
    expect(seen).toEqual(['One']);
  });
});

describe('a server that breaks', () => {
  it('reads an error line mid-answer as a failure, after the text already sent', async () => {
    await serve({ answer: 'One two three four.', failAfter: 2 });
    const ollama = createOllama({ baseUrl: fake!.url });
    const seen: string[] = [];
    const error = await failure(
      (async () => {
        for await (const event of ollama.chat(CHAT, ask)) {
          if (event.type === 'token') seen.push(event.text);
        }
      })(),
    );
    expect(error.code).toBe('failed');
    expect(error.message).toMatch(/the model runner stopped/u);
    expect(seen.join('')).toBe('One two');
  });

  const lying = (body: string, status = 200) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it.each([
    [
      'a line that is not JSON',
      '{"message":{"content":"Hi"},"done":false}\nnot json\n',
      /not JSON/u,
    ],
    ['a line in another shape', '{"message":{"content":"Hi"},"done":"no"}\n', /shape/u],
    [
      'a stream that ends before done',
      '{"message":{"content":"Hi"},"done":false}\n',
      /ended before/u,
    ],
  ])('reads %s as a protocol error', async (_name, body, message) => {
    const ollama = createOllama({ baseUrl: 'http://x', fetch: lying(body) });
    const error = await failure(
      (async () => {
        for await (const _ of ollama.chat(CHAT, ask)) void _;
      })(),
    );
    expect(error.code).toBe('protocol');
    expect(error.message).toMatch(message);
  });

  it('reads a 5xx as a failure and a plain-text 404 as not Ollama', async () => {
    const drain = async (fetchImpl: typeof fetch) => {
      for await (const _ of createOllama({ baseUrl: 'http://x', fetch: fetchImpl }).chat(CHAT, ask))
        void _;
    };
    expect((await failure(drain(lying('{"error":"out of memory"}', 500)))).code).toBe('failed');
    expect((await failure(drain(lying('404 page not found', 404)))).code).toBe('unreachable');
  });

  it('reads a closed port as unreachable, without the address', async () => {
    await serve({});
    const url = fake!.url;
    await fake!.close();
    fake = undefined;
    const error = await failure(
      (async () => {
        for await (const _ of createOllama({ baseUrl: url }).chat(CHAT, ask)) void _;
      })(),
    );
    expect(error.code).toBe('unreachable');
    expect(error.message).toMatch(/ECONNREFUSED/u);
    expect(error.message).not.toContain('127.0.0.1');
  });
});
