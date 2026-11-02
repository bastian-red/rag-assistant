import { afterEach, describe, expect, it } from 'vitest';

import { hashEmbedding } from './fake/embedding';
import { startFakeOllama, type FakeOllama } from './fake/server';
import { createOllama, LlmError } from './ollama';

const EMBED = 'qwen3-embedding:0.6b';

let fake: FakeOllama | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

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

const replying = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;

describe('embed', () => {
  it('sends batches of the configured size, one at a time, in order', async () => {
    fake = await startFakeOllama({ models: [EMBED] });
    const texts = Array.from({ length: 70 }, (_, i) => `text ${String(i)}`);
    const vectors = await createOllama({ baseUrl: fake.url }).embed(EMBED, texts);
    expect(fake.embeds.map((e) => e.inputs)).toEqual([32, 32, 6]);
    expect(vectors).toEqual(texts.map((t) => hashEmbedding(t)));
  });

  it('refuses a reply with the wrong number of vectors', async () => {
    const ollama = createOllama({ baseUrl: 'http://x', fetch: replying({ embeddings: [[1]] }) });
    const error = await failure(ollama.embed(EMBED, ['a', 'b']));
    expect(error.code).toBe('protocol');
    expect(error.message).toMatch(/1 vectors for 2 inputs/u);
  });

  it('refuses vectors that do not fit the column, naming the likely cause', async () => {
    const ollama = createOllama({
      baseUrl: 'http://x',
      fetch: replying({ embeddings: [new Array<number>(768).fill(0.1)] }),
    });
    const error = await failure(ollama.embed(EMBED, ['a']));
    expect(error.message).toMatch(/768 dimensions, expected 1024 \(EMBED_MODEL changed\?\)/u);
  });

  it('refuses a vector with a value that is not a finite number', async () => {
    // JSON has no NaN; a null in the array is what a broken server sends.
    const ollama = createOllama({
      baseUrl: 'http://x',
      embed: { dimensions: 2 },
      fetch: replying({ embeddings: [[0.5, null]] }),
    });
    expect((await failure(ollama.embed(EMBED, ['a']))).code).toBe('protocol');
  });

  it('passes the server’s own reason for an input over the context length', async () => {
    const ollama = createOllama({
      baseUrl: 'http://x',
      fetch: (async () =>
        Response.json(
          { error: 'the input length exceeds the context length' },
          { status: 400 },
        )) as unknown as typeof fetch,
    });
    const error = await failure(ollama.embed(EMBED, ['a very long passage']));
    expect(error.code).toBe('refused');
    expect(error.message).toBe(
      'POST /api/embed answered 400: the input length exceeds the context length',
    );
  });

  it('asks the server not to truncate', async () => {
    let sent: unknown;
    const ollama = createOllama({
      baseUrl: 'http://x',
      embed: { dimensions: 1 },
      fetch: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return Response.json({ embeddings: [[1]] });
      }) as unknown as typeof fetch,
    });
    await ollama.embed(EMBED, ['a']);
    expect(sent).toEqual({ model: EMBED, input: ['a'], truncate: false });
  });

  it('stops at the timeout, and at the caller’s abort', async () => {
    const never = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const slow = createOllama({ baseUrl: 'http://x', fetch: never, embed: { timeoutMs: 50 } });
    expect((await failure(slow.embed(EMBED, ['a']))).code).toBe('timeout');

    const controller = new AbortController();
    const pending = createOllama({ baseUrl: 'http://x', fetch: never }).embed(EMBED, ['a'], {
      signal: controller.signal,
    });
    controller.abort();
    expect((await failure(pending)).code).toBe('aborted');
  });

  it('refuses something that is not a list of strings', async () => {
    const ollama = createOllama({ baseUrl: 'http://x' });
    const error = await failure(ollama.embed(EMBED, [1 as unknown as string]));
    expect(error.code).toBe('refused');
  });
});
