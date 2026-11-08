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
import { randomUUID } from 'node:crypto';

import { FIRST_COLLECTION_NAME, sessionUserSchema } from '@rag/shared';
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

describe('POST /auth/sign-up', () => {
  const made: string[] = [];
  afterAll(async () => {
    await h.db.user.deleteMany({ where: { email: { in: made } } });
  });
  const fresh = (label: string) => {
    const email = `${label}-${randomUUID().slice(0, 8)}@rag.test`;
    made.push(email);
    return email;
  };

  it('creates the account with one empty collection, and the password then signs in', async () => {
    const email = fresh('newcomer');
    const r = await call(h, 'POST', '/auth/sign-up', {
      body: { email: email.toUpperCase(), name: '  Nadia  ', password: 'a-long-enough-pass' },
    });
    expect(r.status).toBe(201);
    const user = sessionUserSchema.parse(r.body);
    expect(user).toMatchObject({ email, name: 'Nadia' });

    const collections = await call<{
      collections: { name: string; documents: { total: number } }[];
    }>(h, 'GET', '/collections', { user });
    expect(collections.body.collections).toEqual([
      expect.objectContaining({
        name: FIRST_COLLECTION_NAME,
        documents: expect.objectContaining({ total: 0 }),
      }),
    ]);

    const signIn = await call(h, 'POST', '/auth/sign-in', {
      body: { email, password: 'a-long-enough-pass' },
    });
    expect(signIn.status).toBe(200);
    // Stored as a scrypt hash, never the password.
    const row = await h.db.user.findUniqueOrThrow({ where: { email } });
    expect(row.passwordHash).not.toContain('a-long-enough-pass');
  });

  it('refuses a taken address with a 409 and creates nothing', async () => {
    const email = fresh('taken');
    const body = { email, name: 'First', password: 'a-long-enough-pass' };
    expect((await call(h, 'POST', '/auth/sign-up', { body })).status).toBe(201);
    const again = await call(h, 'POST', '/auth/sign-up', { body: { ...body, name: 'Second' } });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'CONFLICT' });
    expect(await h.db.user.count({ where: { email } })).toBe(1);
  });

  it('holds a password to twelve characters, and never echoes it', async () => {
    const r = await call(h, 'POST', '/auth/sign-up', {
      body: { email: fresh('short'), name: 'Short', password: 'elevenchars' },
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'INVALID', fields: ['password'] });
    expect(r.text).not.toContain('elevenchars');
  });

  it('shares the auth budget: the sixth attempt a minute from one address is a 429', async () => {
    const address = randomAddress();
    const attempt = () =>
      call(h, 'POST', '/auth/sign-up', {
        address,
        body: { email: 'not-an-email', name: 'x', password: 'a-long-enough-pass' },
      });
    for (let i = 0; i < AUTH_BUDGET; i += 1) expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);
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
      'DELETE /conversations/:id',
      'DELETE /documents/:id',
      'GET /auth/me',
      'GET /collections',
      'GET /conversations',
      'GET /conversations/:id',
      'GET /documents',
      'GET /documents/:id',
      'GET /documents/:id/chunks/:chunkId',
      'GET /documents/:id/file',
      'GET /documents/events',
      'GET /health',
      'GET /status',
      'POST /auth/sign-in',
      'POST /auth/sign-up',
      'POST /chat/:conversationId/messages',
      'POST /collections',
      'POST /conversations',
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
