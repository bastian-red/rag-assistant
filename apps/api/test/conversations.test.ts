/**
 * `/conversations` through the real graph: owner-filtered, 404 for anyone
 * else, newest activity first, deleted with everything in them.
 */
import { conversationListSchema, conversationSummarySchema } from '@rag/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UNTITLED } from '../src/conversations/conversations.service';
import { boot, call, newUser, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await boot();
});
afterAll(async () => {
  await h.close();
});

describe('POST /conversations', () => {
  it('creates an untitled conversation over the whole library, or one collection of yours', async () => {
    const user = await newUser(h.db, 'conv-create');
    const whole = await call(h, 'POST', '/conversations', { user, body: {} });
    expect(whole.status).toBe(201);
    expect(conversationSummarySchema.parse(whole.body)).toMatchObject({
      title: UNTITLED,
      collectionId: null,
    });

    const shelf = await call<{ id: string }>(h, 'POST', '/collections', {
      user,
      body: { name: 'S' },
    });
    const scoped = await call(h, 'POST', '/conversations', {
      user,
      body: { collectionId: shelf.body.id },
    });
    expect(scoped.status).toBe(201);
    expect(scoped.body).toMatchObject({ collectionId: shelf.body.id });
  });

  it('is 404 for a collection that is not yours, 400 for an unknown field, 401 without a session', async () => {
    const alma = await newUser(h.db, 'conv-alma');
    const bruno = await newUser(h.db, 'conv-bruno');
    const shelf = await call<{ id: string }>(h, 'POST', '/collections', {
      user: bruno,
      body: { name: 'Bruno' },
    });
    expect(
      (
        await call(h, 'POST', '/conversations', {
          user: alma,
          body: { collectionId: shelf.body.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(h, 'POST', '/conversations', { user: alma, body: { title: 'x' } })).status,
    ).toBe(400);
    expect((await call(h, 'POST', '/conversations', { user: null, body: {} })).status).toBe(401);
    expect(await h.db.conversation.count({ where: { ownerId: alma.id } })).toBe(0);
  });
});

describe('GET /conversations', () => {
  it('lists only my conversations, most recently active first', async () => {
    const alma = await newUser(h.db, 'conv-list');
    const bruno = await newUser(h.db, 'conv-list-other');
    const older = await call<{ id: string }>(h, 'POST', '/conversations', { user: alma, body: {} });
    const newer = await call<{ id: string }>(h, 'POST', '/conversations', { user: alma, body: {} });
    await call(h, 'POST', '/conversations', { user: bruno, body: {} });
    // Activity, not creation, orders the list.
    await h.db.conversation.update({
      where: { id: older.body.id },
      data: { updatedAt: new Date(Date.now() + 60_000) },
    });
    const r = await call(h, 'GET', '/conversations', { user: alma });
    expect(r.status).toBe(200);
    expect(conversationListSchema.parse(r.body).conversations.map((c) => c.id)).toEqual([
      older.body.id,
      newer.body.id,
    ]);
  });
});

describe('DELETE /conversations/:id', () => {
  it('removes it with its messages; 404 after, and for anyone else', async () => {
    const alma = await newUser(h.db, 'conv-delete');
    const bruno = await newUser(h.db, 'conv-delete-other');
    const conv = await call<{ id: string }>(h, 'POST', '/conversations', { user: alma, body: {} });
    await h.db.message.create({
      data: {
        ownerId: alma.id,
        conversationId: conv.body.id,
        role: 'USER',
        content: 'Hello?',
        status: 'DONE',
      },
    });
    expect(
      (await call(h, 'DELETE', `/conversations/${conv.body.id}`, { user: bruno })).status,
    ).toBe(404);
    expect((await call(h, 'DELETE', `/conversations/${conv.body.id}`, { user: alma })).status).toBe(
      204,
    );
    expect((await call(h, 'GET', `/conversations/${conv.body.id}`, { user: alma })).status).toBe(
      404,
    );
    expect(await h.db.message.count({ where: { conversationId: conv.body.id } })).toBe(0);
  });
});
