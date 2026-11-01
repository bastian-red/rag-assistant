/**
 * `GET /status`: the health of every service, for the web app's /status page.
 *
 * Today that is the api alone; build step 5 adds the ingest worker, asked over
 * HTTP so a wedged process shows as unreachable. Public, like /health: it
 * reports state, never data.
 */
import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Status } from '@rag/shared';

import { Public } from '../common/session.guard';
import { HealthService } from '../health/health.service';

@Controller('status')
export class StatusController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @SkipThrottle({ default: true, auth: true })
  @Get()
  async status(): Promise<Status> {
    return { checkedAt: new Date().toISOString(), services: [await this.health.report()] };
  }
}
