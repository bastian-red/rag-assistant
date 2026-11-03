/**
 * The API's own health report, shared by `GET /health` and `GET /status`.
 *
 * Four checks, each a real operation rather than a handle:
 *
 * - **postgres** runs `SELECT 1`. A pool that believes it is connected to a
 *   server which closed the socket answers a liveness check perfectly and fails
 *   on the next query.
 * - **redis** sends `PING`. The throttler's storage is Redis (a dead one fails
 *   every request, not just a counter), and from build step 5 so is the
 *   ingest queue.
 * - **ollama** asks the model server for its model list. Reachable or not.
 * - **models** reads the same list for the configured chat and embedding
 *   models, then asks `/api/show` whether each can do its job. A reachable
 *   server without the models answers every question with an error, and a
 *   thinking-only chat build answers every question with its reasoning, so
 *   "up" is not the same as "ready", and the 503 says which and why.
 * - **uploads** writes and removes a probe file in UPLOAD_DIR, where every
 *   upload is stored for the worker to read.
 */
import { Inject, Injectable } from '@nestjs/common';
import { missingModels, modelProblems, type Ollama } from '@rag/llm';
import type { Health, HealthCheck, ModelStatus } from '@rag/shared';
import { describeError, probeUploadDir } from '@rag/shared/server';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { OLLAMA } from '../infra/infra.module';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(OLLAMA) private readonly ollama: Ollama,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async report(): Promise<Health> {
    const [postgres, redis, model, uploads] = await Promise.all([
      timed('postgres', async () => {
        await this.prisma.ping();
      }),
      timed('redis', async () => {
        await this.redis.client.ping();
      }),
      this.modelChecks(),
      timed('uploads', () => probeUploadDir(this.config.uploadDir)),
    ]);
    const checks = [postgres, redis, ...model, uploads];
    return {
      status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
      service: 'api',
      version: this.config.appVersion,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  /** One call to the model server, reported as two checks: reachable, and ready. */
  private async modelChecks(): Promise<[HealthCheck, HealthCheck]> {
    const started = Date.now();
    let status: ModelStatus;
    try {
      status = await this.ollama.checkModels({
        chat: this.config.chatModel,
        embed: this.config.embedModel,
      });
    } catch (error) {
      const latencyMs = Date.now() - started;
      return [
        { name: 'ollama', status: 'fail', latencyMs, detail: describeError(error) },
        { name: 'models', status: 'fail', latencyMs: 0, detail: 'model server unreachable' },
      ];
    }
    const latencyMs = Date.now() - started;
    const missing = missingModels(status);
    const problems = modelProblems(status);
    const details = [
      ...(missing.length === 0
        ? []
        : [`not pulled: ${missing.join(', ')} (run scripts/ollama-setup.sh)`]),
      ...problems,
    ];
    return [
      { name: 'ollama', status: 'ok', latencyMs, detail: null },
      details.length === 0
        ? { name: 'models', status: 'ok', latencyMs: 0, detail: null }
        : { name: 'models', status: 'fail', latencyMs: 0, detail: details.join('; ') },
    ];
  }
}

async function timed(name: string, run: () => Promise<void>): Promise<HealthCheck> {
  const started = Date.now();
  try {
    await run();
    return { name, status: 'ok', latencyMs: Date.now() - started, detail: null };
  } catch (error) {
    return {
      name,
      status: 'fail',
      latencyMs: Date.now() - started,
      // The message, not the stack. This body is read by whoever is running
      // dev-smoke and by the /status page, and a stack is neither.
      detail: describeError(error),
    };
  }
}
