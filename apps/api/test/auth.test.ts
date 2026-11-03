/**
 * Sign-in, the default-closed guard and the auth budget, against the real
 * graph.
 *
 * The budget runs at its DOCUMENTED value (RATE_LIMIT_AUTH, 5 a minute). The
 * negative half is the one that matters: `@nestjs/throttler` v6 runs every named
 * throttler on every route unless it is skipped, and a sibling project shipped
 * an auth budget that capped every route. So this proves the sign-in budget
 * does not limit `/health`, `/status`, or a signed-in call from the same address.
 */
import { sessionUserSchema } from '@rag/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { boot, call, newUser, randomAddress, routes, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await boot();
});
afterAll(async () => {
  await h.close();
});

const AUTH_BUDGET = Number(process.env.RATE_LIMIT_AUTH ?? '5');

describe('POST /auth/sign-in', () => {
  it('answers the user, parsed by the contract the web app uses', async () => {
    const person = await newUser(h.db, 'person');
    const r = await call(h, 'POST', '/auth/sign-in', {
      body: { email: person.email, password: person.password },
    });
    expect(r.status).toBe(200);
    expect(sessionUserSchema.parse(r.body)).toEqual({
      id: person.id,
      email: person.email,
      name: person.name,
    });
  });

  it('accepts the email in any case, because the contract lowercases it', async () => {
    const person = await newUser(h.db, 'casing');
    const r = await call(h, 'POST', '/auth/sign-in', {
      body: { email: person.email.toUpperCase(), password: person.password },
    });
    expect(r.status).toBe(200);
  });

  it('gives one answer for a wrong password and for an unknown address', async () => {
    const person = await newUser(h.db, 'wrong');
    const wrong = await call(h, 'POST', '/auth/sign-in', {
      body: { email: person.email, password: 'not-the-password' },
    });
    const unknown = await call(h, 'POST', '/auth/sign-in', {
      body: { email: `nobody-${person.id}@rag.test`, password: 'not-the-password' },
    });
    expect(wrong.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toMatchObject({ code: 'INVALID' });
  });

  it('never puts the submitted password in a validation error', async () => {
    const r = await call(h, 'POST', '/auth/sign-in', {
      body: { email: 'not-an-email', password: 'hunter2-secret-value' },
    });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain('hunter2-secret-value');
    expect(r.body).toMatchObject({ code: 'INVALID', fields: ['email'] });
  });
});

describe('the session guard is default-closed', () => {
  it('refuses a route that is not @Public() without a token', async () => {
    const r = await call(h, 'GET', '/auth/me', { user: null });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a token minted with another secret', async () => {
    const person = await newUser(h.db, 'forger');
    const r = await call(h, 'GET', '/auth/me', {
      user: person,
      secret: 'some-other-secret-at-least-32-chars',
    });
    expect(r.status).toBe(401);
  });

  it('serves exactly the routes this table expects, so a new route is a reviewed decision', () => {
    // Read from the running router. A route added without a row here fails
    // this test, which is the moment to decide whether it is public.
    expect(routes(h)).toEqual([
      'DELETE /collections/:id',
      'DELETE /documents/:id',
      'GET /auth/me',
      'GET /collections',
      'GET /documents',
      'GET /documents/:id',
      'GET /documents/:id/chunks/:chunkId',
      'GET /documents/:id/file',
      'GET /documents/events',
      'GET /health',
      'GET /status',
      'POST /auth/sign-in',
      'POST /collections',
      'POST /documents',
    ]);
  });
});

describe('GET /auth/me', () => {
  it('answers the account as stored now', async () => {
    const person = await newUser(h.db, 'renamed');
    await h.db.user.update({ where: { id: person.id }, data: { name: 'New Name' } });
    // The token still carries the old name, as one minted before the rename would.
    const r = await call(h, 'GET', '/auth/me', { user: person });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: person.id, name: 'New Name' });
  });

  it('is a 401 for a token whose account was deleted', async () => {
    const person = await newUser(h.db, 'deleted');
    await h.db.user.delete({ where: { id: person.id } });
    expect((await call(h, 'GET', '/auth/me', { user: person })).status).toBe(401);
  });
});

describe('the auth budget limits sign-in and nothing else', () => {
  it(`allows ${String(AUTH_BUDGET)} attempts a minute from one address, then 429`, async () => {
    const address = randomAddress();
    const attempt = () =>
      call(h, 'POST', '/auth/sign-in', {
        address,
        body: { email: 'nobody@rag.test', password: 'wrong-password' },
      });
    for (let i = 0; i < AUTH_BUDGET; i += 1) expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);

    // A different address still has its own budget.
    const elsewhere = await call(h, 'POST', '/auth/sign-in', {
      body: { email: 'nobody@rag.test', password: 'wrong-password' },
    });
    expect(elsewhere.status).toBe(400);

    // An ordinary route is NOT capped at the auth number. /health and /status
    // below skip every budget by decorator, so they cannot show this; /auth/me
    // carries no budget decorator at all, which is the route shape a leaked
    // budget hits. Removing the auth `skipIf` turns the sixth call into a 429.
    const reader = await newUser(h.db, 'reader');
    for (let i = 0; i < AUTH_BUDGET + 3; i += 1) {
      expect((await call(h, 'GET', '/auth/me', { user: reader, address })).status).toBe(200);
    }

    // The exhausted address can still reach the public probes.
    for (let i = 0; i < AUTH_BUDGET + 2; i += 1) {
      expect((await call(h, 'GET', '/health', { address })).status).toBe(200);
      expect((await call(h, 'GET', '/status', { address })).status).toBe(200);
    }
  });
});
