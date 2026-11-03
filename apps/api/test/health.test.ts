/**
 * `/health` and `/status` against real Postgres and Redis and a model server
 * that speaks Ollama's HTTP (the fake from `@rag/llm`, started by
 * integration.sh with both models listed).
 *
 * The degraded cases boot a second application pointed at a second fake (or
 * at nothing), because a health check is only proven by watching it fail for
 * the reason it names.
 */
import { startFakeOllama, type FakeOllama } from '@rag/llm';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { healthSchema, statusSchema, type Health } from '@rag/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INGEST_HEALTH_TIMEOUT_MS } from '../src/status/status.controller';
import { boot, call, withEnv, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await boot();
});
afterAll(async () => {
  await h.close();
});

/** Boot a second app with OLLAMA_URL pointed elsewhere, run `body`, restore. */
async function withModelServer(url: string, body: (other: Harness) => Promise<void>) {
  const saved = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = url;
  const other = await boot();
  process.env.OLLAMA_URL = saved;
  try {
    await body(other);
  } finally {
    await other.close();
  }
}

describe('GET /health', () => {
  it('checks Postgres, Redis, the model server and both models, for real', async () => {
    const r = await call(h, 'GET', '/health');
    expect(r.status).toBe(200);
    const body = healthSchema.parse(r.body);
    expect(body.service).toBe('api');
    expect(body.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      'postgres:ok',
      'redis:ok',
      'ollama:ok',
      'models:ok',
      'uploads:ok',
    ]);
  });

  it('is 503 naming the model that is not pulled, with the command that fixes it', async () => {
    const chatOnly: FakeOllama = await startFakeOllama({
      models: [process.env.CHAT_MODEL ?? 'qwen3:4b-instruct'],
    });
    try {
      await withModelServer(chatOnly.url, async (other) => {
        const r = await call(other, 'GET', '/health');
        expect(r.status).toBe(503);
        const body = healthSchema.parse(r.body);
        expect(body.status).toBe('degraded');
        const models = body.checks.find((c) => c.name === 'models');
        expect(models?.status).toBe('fail');
        expect(models?.detail).toContain(process.env.EMBED_MODEL ?? 'qwen3-embedding:0.6b');
        expect(models?.detail).toContain('scripts/ollama-setup.sh');
        expect(body.checks.find((c) => c.name === 'ollama')?.status).toBe('ok');
      });
    } finally {
      await chatOnly.close();
    }
  });

  it('is 503 naming a thinking-only chat build, though both models are pulled', async () => {
    const chat = process.env.CHAT_MODEL ?? 'qwen3:4b-instruct';
    const embed = process.env.EMBED_MODEL ?? 'qwen3-embedding:0.6b';
    const thinking: FakeOllama = await startFakeOllama({
      models: [chat, embed],
      thinkingOnly: [chat],
    });
    try {
      await withModelServer(thinking.url, async (other) => {
        const r = await call(other, 'GET', '/health');
        expect(r.status).toBe(503);
        const models = healthSchema.parse(r.body).checks.find((c) => c.name === 'models');
        expect(models).toMatchObject({ status: 'fail' });
        expect(models?.detail).toBe(
          `${chat}: a thinking-only build: it writes its reasoning into every answer (use an instruct build, such as qwen3:4b-instruct)`,
        );
      });
    } finally {
      await thinking.close();
    }
  });

  it('is 503 naming the model server when nothing answers, without leaking its address', async () => {
    const gone = await startFakeOllama({ models: [] });
    const url = gone.url;
    await gone.close();
    await withModelServer(url, async (other) => {
      const r = await call(other, 'GET', '/health');
      expect(r.status).toBe(503);
      const body = healthSchema.parse(r.body);
      expect(body.checks.find((c) => c.name === 'ollama')).toMatchObject({ status: 'fail' });
      expect(r.text).not.toContain(new URL(url).port);
      // Postgres and Redis are still reported as what they are.
      expect(body.checks.find((c) => c.name === 'postgres')?.status).toBe('ok');
    });
  });
});

describe('GET /status', () => {
  it('reports the api, and an ingest worker that is not running as unreachable', async () => {
    // integration.sh points INGEST_URL at a port nothing listens on.
    const r = await call(h, 'GET', '/status');
    expect(r.status).toBe(200);
    const body = statusSchema.parse(r.body);
    expect(body.services.map((s) => s.service)).toEqual(['api', 'ingest']);
    expect(body.services[1]).toMatchObject({ service: 'ingest', status: 'unreachable' });
    expect((body.services[1] as { detail: string }).detail).toContain(process.env.INGEST_URL!);
  });

  it('carries the worker’s own report, a degraded one included', async () => {
    const report: Health = {
      status: 'degraded',
      service: 'ingest',
      version: '0.1.0',
      uptimeSeconds: 3,
      checks: [{ name: 'embed-model', status: 'fail', latencyMs: 1, detail: 'not pulled: x' }],
    };
    const worker = createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify(report));
    });
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
    const { port } = worker.address() as AddressInfo;
    try {
      await withEnv('INGEST_URL', `http://127.0.0.1:${String(port)}`, async (other) => {
        const body = statusSchema.parse((await call(other, 'GET', '/status')).body);
        expect(body.services[1]).toEqual(report);
      });
    } finally {
      worker.close();
    }
  });

  it('reports a worker that hangs as unreachable within its timeout', async () => {
    const hung = createServer(() => undefined);
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const { port } = hung.address() as AddressInfo;
    try {
      await withEnv('INGEST_URL', `http://127.0.0.1:${String(port)}`, async (other) => {
        const started = Date.now();
        const body = statusSchema.parse((await call(other, 'GET', '/status')).body);
        expect(Date.now() - started).toBeLessThan(INGEST_HEALTH_TIMEOUT_MS + 1_000);
        expect(body.services[1]).toMatchObject({ status: 'unreachable' });
        expect((body.services[1] as { detail: string }).detail).toMatch(/within 1500 ms/u);
      });
    } finally {
      hung.closeAllConnections();
      hung.close();
    }
  });
});
