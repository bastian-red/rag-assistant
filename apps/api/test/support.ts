/**
 * Shared plumbing for the API's integration lane.
 *
 * The Nest application is built from the real `AppModule` and listens on an
 * ephemeral port, so every request below travels the whole stack: the session
 * guard, the throttler, the pipes, the filter, Prisma, Postgres, Redis. Nothing
 * is mocked, because what this lane exists to catch -- a guard that is not
 * default-closed, a budget that limits the wrong routes -- is a failure of the
 * wiring rather than of a pure function, and the pure functions already have
 * their own tests.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createPrismaClient, type PrismaClient } from '@rag/db';
import type { SessionUser } from '@rag/shared';
import { hashPassword, mintServiceToken } from '@rag/shared/server';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Redis } from 'ioredis';

import { AppModule } from '../src/app.module';
import { JSON_BODY_LIMIT_BYTES } from '../src/config/boot';

export const AUTH_SECRET = required('AUTH_SECRET', process.env.AUTH_SECRET);
export const DATABASE_URL = required('DATABASE_URL', process.env.DATABASE_URL);
export const REDIS_URL = required('REDIS_URL', process.env.REDIS_URL);

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run this through ./scripts/integration.sh.`);
  }
  return value;
}

export interface Harness {
  readonly app: INestApplication;
  readonly base: string;
  /** Test setup and assertions only, never the code under test. */
  readonly db: PrismaClient;
  readonly redis: Redis;
  close(): Promise<void>;
}

export async function boot(): Promise<Harness> {
  // The same body parser and proxy trust main.ts sets up, so the harness runs
  // the program that ships.
  const app = await NestFactory.create<
    INestApplication & {
      set(key: string, value: unknown): void;
      useBodyParser(type: string, options: { limit: number }): void;
    }
  >(AppModule, { logger: ['error'], bodyParser: false });
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });
  app.set('trust proxy', 1);
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');

  const server = app.getHttpServer() as { address(): AddressInfo | string | null };
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the API did not bind a port');

  const db = createPrismaClient({ url: DATABASE_URL });
  const redis = new Redis(REDIS_URL);
  return {
    app,
    base: `http://127.0.0.1:${String(address.port)}`,
    db,
    redis,
    close: async () => {
      // The users this suite made go with it, so rag_it does not grow from
      // one run to the next. From build step 2 their libraries cascade.
      await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
      await db.$disconnect();
      redis.disconnect();
      await app.close();
    },
  };
}

/** Every user `newUser` made in this process: `close()` removes them. */
const users: string[] = [];

/**
 * A fresh user for a test, with a real password hash so sign-in can be
 * exercised. Signed-in calls are rate-limited per user, so a user per suite
 * keeps this lane at the DOCUMENTED budgets without borrowing another suite's
 * minute.
 */
export async function newUser(
  db: PrismaClient,
  label: string,
  password = 'integration-password-2026',
): Promise<SessionUser & { password: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@rag.test`;
  const row = await db.user.create({
    data: { email, name: label, passwordHash: hashPassword(password) },
    select: { id: true },
  });
  users.push(row.id);
  return { id: row.id, email, name: label, password };
}

export interface Reply<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
  readonly text: string;
}

/** A private address, random per call, so per-address budgets never leak between tests. */
export function randomAddress(): string {
  const octet = () => String(1 + Math.floor(Math.random() * 254));
  return `10.${octet()}.${octet()}.${octet()}`;
}

/**
 * One request.
 *
 * The token is minted per call rather than cached: a cached one works for two
 * minutes and then fails for the rest of the run, and that looks like
 * flakiness. `user: null` sends no `Authorization` header, which is how the
 * default-closed guard and the public routes are exercised. Anonymous calls get
 * a fresh `x-forwarded-for` each unless `address` pins one, so per-address
 * budgets do not leak between tests.
 */
export async function call<T = unknown>(
  harness: Harness,
  method: string,
  path: string,
  options: {
    user?: SessionUser | null;
    body?: unknown;
    secret?: string;
    address?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {
    'x-forwarded-for': options.address ?? randomAddress(),
    ...options.headers,
  };
  if (options.user !== null && options.user !== undefined) {
    headers.authorization = `Bearer ${mintServiceToken(options.user, options.secret ?? AUTH_SECRET)}`;
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${harness.base}${path}`, {
    method,
    headers,
    // A redirect is an answer under test, not something to follow.
    redirect: 'manual',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T, headers: response.headers, text };
}

/**
 * Every route the Express router actually serves, as `METHOD /path`, read
 * from the running app rather than from a list someone keeps. The coverage
 * checks compare their own tables against this, so a route added without a
 * row in them fails the lane.
 */
export function routes(harness: Harness): string[] {
  // Express 5 (Nest 11) exposes the router as `router`; Express 4's private
  // `_router` is gone. Fail by name if it moves again, never as an empty table.
  const express = harness.app.getHttpAdapter().getInstance() as {
    router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
  };
  if (express.router === undefined) throw new Error('routes(): Express exposes no `router`.');
  return express.router.stack
    .flatMap((layer) =>
      layer.route === undefined
        ? []
        : Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`),
    )
    .sort();
}
