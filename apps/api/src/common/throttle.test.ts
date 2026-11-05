import { Controller, Get } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { ApiConfig } from '../config/config';
import { addressHash } from '@rag/shared/server';

import { Budget, budgetOf, throttlers, trackerFor } from './throttle';

@Controller()
class Probe {
  @Budget('auth')
  @Get()
  signIn(): void {}

  @Budget('upload')
  @Get()
  upload(): void {}

  @Budget('chat')
  @Get()
  ask(): void {}

  @Get()
  list(): void {}
}

function contextFor(handler: keyof Probe): ExecutionContext {
  return {
    getHandler: () => Probe.prototype[handler],
    getClass: () => Probe,
  } as unknown as ExecutionContext;
}

const CONFIG = {
  rateLimitGlobal: 240,
  rateLimitAuth: 5,
  rateLimitUpload: 10,
  rateLimitChat: 20,
} as ApiConfig;

describe('throttlers', () => {
  const [general, auth, upload, chat, ...rest] = throttlers(CONFIG);

  it('applies the auth budget to auth routes ONLY', () => {
    // The bug this file exists to prevent: in @nestjs/throttler v6 every named
    // throttler applies to every route unless it skips. Without `skipIf`, the
    // five-per-minute auth budget would limit every question too.
    expect(auth!.skipIf!(contextFor('signIn'))).toBe(false);
    expect(auth!.skipIf!(contextFor('list'))).toBe(true);
    expect(auth!.skipIf!(contextFor('upload'))).toBe(true);
  });

  it('applies the upload budget to the upload route ONLY (SPECS #7)', () => {
    expect(upload!.limit).toBe(10);
    expect(upload!.skipIf!(contextFor('upload'))).toBe(false);
    expect(upload!.skipIf!(contextFor('list'))).toBe(true);
    expect(upload!.skipIf!(contextFor('signIn'))).toBe(true);
  });

  it('applies the chat budget to the question route ONLY', () => {
    expect(chat!.limit).toBe(20);
    expect(chat!.skipIf!(contextFor('ask'))).toBe(false);
    expect(chat!.skipIf!(contextFor('list'))).toBe(true);
    expect(chat!.skipIf!(contextFor('upload'))).toBe(true);
    expect(upload!.skipIf!(contextFor('ask'))).toBe(true);
    expect(auth!.skipIf!(contextFor('ask'))).toBe(true);
  });

  it('registers exactly the budgets it scopes', () => {
    expect(rest).toEqual([]);
  });

  it('applies the general budget everywhere', () => {
    expect(general!.skipIf).toBeUndefined();
    expect(budgetOf(contextFor('list'))).toBeUndefined();
  });

  it('keys a counter by budget and caller, not by route', () => {
    // Per-route keys would let a flood split itself across sign-in and sign-up
    // and get twice the budget.
    const key = auth!.generateKey!(contextFor('signIn'), 'ip:1.2.3.4', 'auth');
    expect(key).toBe('throttle:auth:ip:1.2.3.4');
  });
});

const SECRET = 's'.repeat(32);

describe('trackerFor', () => {
  it('counts signed-in calls per user, because they all arrive from the web server', () => {
    const user = {
      id: 'cuser000000000000000001',
      email: 'a@b.co',
      name: 'A',
    };
    expect(trackerFor({ user, ip: '10.0.0.5' }, SECRET)).toBe('user:cuser000000000000000001');
  });

  it('counts anonymous calls per address, keyed by its hash so Redis never holds the address', () => {
    const tracker = trackerFor({ user: undefined, ip: '203.0.113.9' }, SECRET);
    expect(tracker).toBe(`ip:${addressHash(SECRET, '203.0.113.9')}`);
    expect(tracker).not.toContain('203.0.113.9');
    expect(trackerFor({ user: undefined, ip: '203.0.113.10' }, SECRET)).not.toBe(tracker);
  });
});
