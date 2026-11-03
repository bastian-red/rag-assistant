/**
 * `GET /status`: the health of every service, for the web app's /status page.
 *
 * The API's own report, and the ingest worker's, asked over HTTP so a wedged
 * or stopped worker shows as unreachable rather than as nothing. Public, like
 * /health: it reports state, never data.
 */
import { Controller, Get, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { healthSchema, type Status } from '@rag/shared';
import { describeError } from '@rag/shared/server';

import { Public } from '../common/session.guard';
import { API_CONFIG, type ApiConfig } from '../config/config';
import { HealthService } from '../health/health.service';

/** A health check that has not answered in this long is reported as not answering. */
export const INGEST_HEALTH_TIMEOUT_MS = 1_500;

@Controller('status')
export class StatusController {
  constructor(
    private readonly health: HealthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Public()
  @SkipThrottle({ default: true, auth: true, upload: true })
  @Get()
  async status(): Promise<Status> {
    const [api, ingest] = await Promise.all([this.health.report(), this.ingest()]);
    return { checkedAt: new Date().toISOString(), services: [api, ingest] };
  }

  /** The worker's own report (a 503 still carries one), or why there is none. */
  private async ingest(): Promise<Status['services'][number]> {
    try {
      const response = await fetch(`${this.config.ingestUrl}/health`, {
        signal: AbortSignal.timeout(INGEST_HEALTH_TIMEOUT_MS),
      });
      const parsed = healthSchema.safeParse(await response.json().catch(() => null));
      if (parsed.success && parsed.data.service === 'ingest') return parsed.data;
      return {
        service: 'ingest',
        status: 'unreachable',
        detail: `${this.config.ingestUrl}/health answered ${String(response.status)} without an ingest report`,
      };
    } catch (error) {
      return {
        service: 'ingest',
        status: 'unreachable',
        detail:
          error instanceof DOMException && error.name === 'TimeoutError'
            ? `no answer from ${this.config.ingestUrl} within ${String(INGEST_HEALTH_TIMEOUT_MS)} ms`
            : `${this.config.ingestUrl}: ${describeError(error)}`,
      };
    }
  }
}
