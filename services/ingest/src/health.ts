/**
 * `GET /health` for the worker: a plain `node:http` server, because a queue
 * consumer has no other routes and a framework would be the larger part of it.
 *
 * Five checks, each a real operation:
 *
 * - **postgres** `SELECT 1`; **redis** `PING` (the queue lives there).
 * - **embed-model** asks the model server for EMBED_MODEL only: this worker
 *   never chats, so a missing chat model is the API's problem, not this one's.
 * - **uploads** writes and removes a probe file in UPLOAD_DIR. Readable is not
 *   enough: the API writes there, and a read-only mount here would mean the two
 *   are not looking at the same volume.
 * - **worker** is the BullMQ consumer running (it stops after a fatal error).
 *
 * 200 when all pass, 503 otherwise, with the same body (`healthSchema`), so
 * `/status` on the API can show which check failed.
 */
import { createServer, type Server } from 'node:http';

import type { Ollama } from '@rag/llm';
import type { PrismaClient } from '@rag/db';
import { healthSchema, type Health, type HealthCheck } from '@rag/shared';
import { describeError, probeUploadDir } from '@rag/shared/server';
import type { Redis } from 'ioredis';

export interface HealthDeps {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly ollama: Pick<Ollama, 'checkModel'>;
  readonly embedModel: string;
  readonly uploadDir: string;
  readonly version: string;
  readonly workerRunning: () => boolean;
}

async function timed(name: string, run: () => Promise<string | null>): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const problem = await run();
    const latencyMs = Date.now() - started;
    return problem === null
      ? { name, status: 'ok', latencyMs, detail: null }
      : { name, status: 'fail', latencyMs, detail: problem };
  } catch (error) {
    return { name, status: 'fail', latencyMs: Date.now() - started, detail: describeError(error) };
  }
}

export function healthReporter(deps: HealthDeps): () => Promise<Health> {
  const startedAt = Date.now();
  return async () => {
    const checks = await Promise.all([
      timed('postgres', async () => {
        await deps.prisma.$queryRaw`SELECT 1`;
        return null;
      }),
      timed('redis', async () => {
        await deps.redis.ping();
        return null;
      }),
      timed('embed-model', async () => {
        const check = await deps.ollama.checkModel('embed', deps.embedModel);
        if (!check.present) return `not pulled: ${check.model} (run scripts/ollama-setup.sh)`;
        return check.problem;
      }),
      timed('uploads', async () => {
        await probeUploadDir(deps.uploadDir);
        return null;
      }),
      timed('worker', async () =>
        deps.workerRunning() ? null : 'the queue consumer is not running',
      ),
    ]);
    return healthSchema.parse({
      status: checks.every((c) => c.status === 'ok') ? 'ok' : 'degraded',
      service: 'ingest',
      version: deps.version,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checks,
    });
  };
}

export async function startHealthServer(
  report: () => Promise<Health>,
  port: number,
  host = '0.0.0.0',
): Promise<Server> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://ingest').pathname;
    if (request.method !== 'GET' || path !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    report().then(
      (health) => {
        response.writeHead(health.status === 'ok' ? 200 : 503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(health));
      },
      (error: unknown) => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: describeError(error) }));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
