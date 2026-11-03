/**
 * Every environment variable the ingest worker reads, parsed once at boot.
 *
 * The same rules as `apps/api/src/config/config.ts`: one typed object, every
 * read spelled `env.NAME` so `scripts/env-contract.mjs` can see it, and every
 * failing name reported in one message.
 *
 * `INGEST_PORT`, not `PORT`: under `pnpm dev` the API, the web app and this
 * worker share one environment, and `PORT` is the web app's.
 */
import { isAbsolute } from 'node:path';

import { modelRefSchema } from '@rag/shared';
import { z } from 'zod';

const whole = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/u, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => value.startsWith('http://') || value.startsWith('https://'),
    'must be an http:// or https:// URL',
  )
  .transform((v) => v.replace(/\/+$/u, ''));

export interface IngestConfig {
  nodeEnv: string;
  appVersion: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  ollamaUrl: string;
  embedModel: string;
  /** Absolute. Files are read from `<uploadDir>/<ownerId>/<sha256>`. */
  uploadDir: string;
  /** Documents processed at once. Each embeds one batch at a time. */
  concurrency: number;
  /**
   * How long a job's lock lives without renewal, and how often a worker looks
   * for jobs whose worker died. A killed worker's document is picked up again
   * after at most about twice this.
   */
  lockMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ENV_NAMES: Record<string, string> = {
  nodeEnv: 'NODE_ENV',
  appVersion: 'APP_VERSION',
  port: 'INGEST_PORT',
  databaseUrl: 'DATABASE_URL',
  redisUrl: 'REDIS_URL',
  ollamaUrl: 'OLLAMA_URL',
  embedModel: 'EMBED_MODEL',
  uploadDir: 'UPLOAD_DIR',
  concurrency: 'INGEST_CONCURRENCY',
  lockMs: 'INGEST_LOCK_MS',
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const schema = z.object({
    nodeEnv: z.string().default('development'),
    appVersion: z.string().default('0.0.0'),
    port: whole(1, 65535).default(4500),
    databaseUrl: z.string().url(),
    redisUrl: z.string().url(),
    ollamaUrl: httpUrl,
    embedModel: modelRefSchema,
    // Absolute, because the API and this worker run from different working
    // directories: a relative path would name two different folders.
    // scripts/load-env.sh makes the documented `.data/uploads` absolute.
    uploadDir: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsolute, 'must be an absolute path (scripts/load-env.sh resolves a relative one)'),
    concurrency: whole(1, 16).default(1),
    lockMs: whole(5_000, 600_000).default(30_000),
  });

  const blank = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v);
  const parsed = schema.safeParse({
    nodeEnv: blank(env.NODE_ENV),
    appVersion: blank(env.APP_VERSION),
    port: blank(env.INGEST_PORT),
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    ollamaUrl: env.OLLAMA_URL,
    embedModel: env.EMBED_MODEL,
    uploadDir: env.UPLOAD_DIR,
    concurrency: blank(env.INGEST_CONCURRENCY),
    lockMs: blank(env.INGEST_LOCK_MS),
  });
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${ENV_NAMES[issue.path.join('.')] ?? issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(
      `Cannot start the ingest worker. Fix these in .env:\n${lines.join('\n')}`,
    );
  }
  return parsed.data;
}
