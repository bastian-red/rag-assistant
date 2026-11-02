import { afterEach, describe, expect, it } from 'vitest';

import { startFakeOllama, type FakeOllama } from './fake/server';
import {
  createOllama,
  missingModels,
  modelProblem,
  modelProblems,
  OllamaUnreachable,
} from './ollama';

const MODELS = { chat: 'qwen3:4b-instruct', embed: 'qwen3-embedding:0.6b' };

let fake: FakeOllama | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('checkModels, against the fake (the same HTTP the real server speaks)', () => {
  it('reports both models present when both are pulled', async () => {
    fake = await startFakeOllama({
      models: ['qwen3:4b-instruct', 'qwen3-embedding:0.6b', 'llama3.2:3b'],
    });
    const status = await createOllama({ baseUrl: fake.url }).checkModels(MODELS);
    expect(status).toEqual({
      chat: { model: 'qwen3:4b-instruct', present: true, problem: null },
      embed: { model: 'qwen3-embedding:0.6b', present: true, problem: null },
    });
    expect(missingModels(status)).toEqual([]);
    expect(modelProblems(status)).toEqual([]);
    expect(fake.requests).toEqual([
      { method: 'GET', path: '/api/tags' },
      { method: 'POST', path: '/api/show' },
      { method: 'POST', path: '/api/show' },
    ]);
  });

  it('names a pulled thinking-only build as a problem, by the configured name', async () => {
    fake = await startFakeOllama({
      models: ['qwen3:4b', 'qwen3-embedding:0.6b'],
      thinkingOnly: ['qwen3:4b'],
    });
    const status = await createOllama({ baseUrl: fake.url }).checkModels({
      ...MODELS,
      chat: 'qwen3:4b',
    });
    expect(missingModels(status)).toEqual([]);
    expect(modelProblems(status)).toEqual([
      'qwen3:4b: a thinking-only build: it writes its reasoning into every answer (use an instruct build, such as qwen3:4b-instruct)',
    ]);
  });

  it('asks /api/show only about models that are pulled', async () => {
    fake = await startFakeOllama({ models: ['qwen3-embedding:0.6b'] });
    await createOllama({ baseUrl: fake.url }).checkModels(MODELS);
    expect(fake.requests.filter((r) => r.path === '/api/show')).toHaveLength(1);
  });

  it('names the missing model by the name the operator configured', async () => {
    fake = await startFakeOllama({ models: ['qwen3:4b-instruct'] });
    const status = await createOllama({ baseUrl: `${fake.url}/` }).checkModels(MODELS);
    expect(missingModels(status)).toEqual(['qwen3-embedding:0.6b']);
  });

  it('does not take a different size of the same family for the configured one', async () => {
    fake = await startFakeOllama({ models: ['qwen3:8b', 'qwen3-embedding:0.6b'] });
    const status = await createOllama({ baseUrl: fake.url }).checkModels(MODELS);
    expect(status.chat.present).toBe(false);
  });

  it('resolves an untagged name to :latest, as Ollama does', async () => {
    fake = await startFakeOllama({ models: ['nomic-embed-text:latest', 'qwen3:4b-instruct'] });
    const status = await createOllama({ baseUrl: fake.url }).checkModels({
      chat: 'qwen3:4b-instruct',
      embed: 'nomic-embed-text',
    });
    expect(status.embed.present).toBe(true);
  });
});

describe('an unreachable or wrong server', () => {
  it('reads a closed port as unreachable, naming the code and not the address', async () => {
    fake = await startFakeOllama({ models: [] });
    const url = fake.url;
    await fake.close();
    fake = undefined;
    const error = await createOllama({ baseUrl: url })
      .listModels()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OllamaUnreachable);
    expect((error as Error).message).toMatch(/ECONNREFUSED/u);
    expect((error as Error).message).not.toContain('127.0.0.1');
  });

  it('reads a 200 that is not Ollama (an HTML page from a proxy) as unreachable, not as "no models"', async () => {
    const htmlPage = (async () =>
      new Response('<html>Bad gateway</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(
      createOllama({ baseUrl: 'http://x', fetch: htmlPage }).listModels(),
    ).rejects.toBeInstanceOf(OllamaUnreachable);
  });

  it('reads JSON in another shape (a different service on the port) as unreachable', async () => {
    // Valid JSON gets past response.json(), so only the schema can catch this.
    const otherService = (async () =>
      Response.json({ status: 'ok', version: '1.2.3' })) as unknown as typeof fetch;
    await expect(
      createOllama({ baseUrl: 'http://x', fetch: otherService }).listModels(),
    ).rejects.toThrow(/not Ollama/u);
  });

  it('reads a non-2xx as unreachable with the status', async () => {
    const down = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    await expect(createOllama({ baseUrl: 'http://x', fetch: down }).listModels()).rejects.toThrow(
      /502/u,
    );
  });

  it('gives up after the timeout instead of hanging a health probe', async () => {
    const never = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(
      createOllama({ baseUrl: 'http://x', fetch: never, timeoutMs: 50 }).listModels(),
    ).rejects.toThrow(/TimeoutError/u);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('the fake’s control route, for specs that cannot reach into its process', () => {
  it('replaces the model list over HTTP, so a spec can make a model disappear', async () => {
    fake = await startFakeOllama({ models: ['qwen3:4b-instruct', 'qwen3-embedding:0.6b'] });
    const response = await fetch(`${fake.url}/__fake/models`, {
      method: 'PUT',
      body: JSON.stringify({ models: ['qwen3:4b-instruct'] }),
    });
    expect(response.status).toBe(200);
    const status = await createOllama({ baseUrl: fake.url }).checkModels(MODELS);
    expect(missingModels(status)).toEqual(['qwen3-embedding:0.6b']);
  });

  it('refuses a body that is not a list of names, and keeps the old list', async () => {
    fake = await startFakeOllama({ models: ['qwen3:4b'] });
    for (const body of ['not json', JSON.stringify({ models: 'qwen3:4b' })]) {
      const response = await fetch(`${fake.url}/__fake/models`, { method: 'PUT', body });
      expect(response.status).toBe(400);
    }
    expect(await createOllama({ baseUrl: fake.url }).listModels()).toEqual(['qwen3:4b']);
  });

  it('answers an unknown route the way Ollama does: a plain-text 404', async () => {
    fake = await startFakeOllama({ models: [] });
    const response = await fetch(`${fake.url}/api/nope`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('404 page not found');
  });
});

describe('modelProblem, from what /api/show reports', () => {
  it('accepts an instruct build, which has no thinking field', () => {
    // qwen3:4b-instruct on Ollama 0.40.12 lists 'thinking' as a capability too.
    expect(modelProblem('chat', { capabilities: ['tools', 'thinking', 'completion'] })).toBeNull();
  });

  it('accepts a build that can turn thinking off', () => {
    expect(
      modelProblem('chat', { capabilities: ['completion'], thinking: { values: [true, false] } }),
    ).toBeNull();
  });

  it('refuses a build that can only think, as plain qwen3:4b reports', () => {
    expect(
      modelProblem('chat', {
        capabilities: ['completion', 'tools', 'thinking'],
        thinking: { values: [true] },
      }),
    ).toMatch(/^a thinking-only build/u);
  });

  it('refuses the wrong kind of model for each role', () => {
    expect(modelProblem('chat', { capabilities: ['embedding'] })).toBe('not a chat model');
    expect(modelProblem('embed', { capabilities: ['completion'] })).toBe('not an embedding model');
    expect(modelProblem('embed', { capabilities: ['tools', 'thinking', 'embedding'] })).toBeNull();
  });
});

describe('the fake’s chat controls and log', () => {
  const ask = { model: 'qwen3:4b-instruct', messages: [{ role: 'user', content: 'Hi?' }] };

  it('takes a script over HTTP, refuses a bad one, and resets', async () => {
    fake = await startFakeOllama({ models: ['qwen3:4b-instruct'] });
    const put = (body: unknown) =>
      fetch(`${fake!.url}/__fake/chat`, { method: 'PUT', body: JSON.stringify(body) });
    expect((await put({ answer: 'Scripted.' })).status).toBe(200);
    expect((await put({ tokenDelayMs: -1 })).status).toBe(400);
    expect((await put({ nonsense: true })).status).toBe(400);
    const once = await fetch(`${fake.url}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ ...ask, stream: false }),
    });
    expect(((await once.json()) as { message: { content: string } }).message.content).toBe(
      'Scripted.',
    );
    await fetch(`${fake.url}/__fake/chat`, { method: 'DELETE' });
    const reset = await fetch(`${fake.url}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ ...ask, stream: false }),
    });
    expect(((await reset.json()) as { message: { content: string } }).message.content).toBe(
      'Not found in your documents.',
    );
  });

  it('serves its log over HTTP, for a spec in another process, and clears it', async () => {
    fake = await startFakeOllama({ models: ['qwen3:4b-instruct'] });
    await fetch(`${fake.url}/api/chat`, { method: 'POST', body: JSON.stringify(ask) }).then((r) =>
      r.text(),
    );
    const log = (await (await fetch(`${fake.url}/__fake/log`)).json()) as {
      chats: { model: string; completed: boolean; aborted: boolean }[];
    };
    expect(log.chats).toEqual([
      expect.objectContaining({ model: 'qwen3:4b-instruct', completed: true, aborted: false }),
    ]);
    await fetch(`${fake.url}/__fake/log`, { method: 'DELETE' });
    expect(fake.chats).toHaveLength(0);
  });

  it('answers errors in Ollama’s words', async () => {
    fake = await startFakeOllama({ models: ['qwen3:4b-instruct', 'qwen3-embedding:0.6b'] });
    const post = async (path: string, body: string) => {
      const response = await fetch(`${fake!.url}${path}`, { method: 'POST', body });
      return [response.status, await response.json()] as const;
    };
    expect(await post('/api/chat', JSON.stringify({ ...ask, model: 'nope:1b' }))).toEqual([
      404,
      { error: "model 'nope:1b' not found" },
    ]);
    expect(
      await post('/api/chat', JSON.stringify({ ...ask, model: 'qwen3-embedding:0.6b' })),
    ).toEqual([400, { error: '"qwen3-embedding:0.6b" does not support chat' }]);
    expect(await post('/api/show', '{}')).toEqual([400, { error: 'model is required' }]);
    expect((await post('/api/embed', 'not json'))[0]).toBe(400);
  });
});
