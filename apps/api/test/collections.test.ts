/**
 * `GET /collections` through the real Nest graph.
 *
 * The owner filter first: two people whose collections share a name each see
 * only their own, with their own counts. Then the counts themselves, against
 * documents in every state, parsed by the contract the web app uses.
 */
import { createHash, randomUUID } from 'node:crypto';

import { collectionListSchema, type CollectionList, type DocumentStatus } from '@rag/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { boot, call, newUser, type Harness } from './support';

let h: Harness;
beforeAll(async () => {
  h = await boot();
});
afterAll(async () => {
  await h.close();
});

async function shelf(ownerId: string, name: string, statuses: DocumentStatus[]) {
  const collection = await h.db.collection.create({ data: { ownerId, name } });
  for (const status of statuses) {
    await h.db.document.create({
      data: {
        ownerId,
        collectionId: collection.id,
        title: `${name} ${status}`,
        filename: 'notes.md',
        mime: 'text/markdown',
        bytes: 10,
        sha256: createHash('sha256').update(randomUUID()).digest('hex'),
        status,
        ...(status === 'FAILED' ? { error: 'No text layer; OCR is not supported.' } : {}),
      },
    });
  }
  return collection.id;
}

describe('GET /collections', () => {
  it('is 401 without a session', async () => {
    expect((await call(h, 'GET', '/collections', { user: null })).status).toBe(401);
  });

  it('lists only the asker’s collections, even where two people use the same name', async () => {
    const alma = await newUser(h.db, 'coll-alma');
    const bruno = await newUser(h.db, 'coll-bruno');
    const almaHome = await shelf(alma.id, 'Home', ['READY']);
    await shelf(bruno.id, 'Home', ['READY', 'READY', 'QUEUED']);
    await shelf(bruno.id, 'Lab', ['READY']);

    const reply = await call<CollectionList>(h, 'GET', '/collections', { user: alma });
    expect(reply.status).toBe(200);
    expect(collectionListSchema.parse(reply.body)).toEqual({
      collections: [
        { id: almaHome, name: 'Home', documents: { total: 1, ready: 1, inProgress: 0, failed: 0 } },
      ],
    });
    // And the other way round, so the filter is not "the first user".
    const theirs = await call<CollectionList>(h, 'GET', '/collections', { user: bruno });
    expect(theirs.body.collections.map((c) => c.name)).toEqual(['Home', 'Lab']);
  });

  it('counts each collection’s documents by state, in names order, an empty one as zeros', async () => {
    const person = await newUser(h.db, 'coll-counts');
    await shelf(person.id, 'Taxes', ['QUEUED', 'PARSING', 'EMBEDDING', 'READY', 'READY', 'FAILED']);
    await shelf(person.id, 'Archive', []);

    const reply = await call<CollectionList>(h, 'GET', '/collections', { user: person });
    expect(collectionListSchema.parse(reply.body).collections).toEqual([
      {
        id: expect.any(String),
        name: 'Archive',
        documents: { total: 0, ready: 0, inProgress: 0, failed: 0 },
      },
      {
        id: expect.any(String),
        name: 'Taxes',
        documents: { total: 6, ready: 2, inProgress: 3, failed: 1 },
      },
    ]);
  });

  it('is an empty list for someone with no collections, not an error', async () => {
    const person = await newUser(h.db, 'coll-none');
    const reply = await call<CollectionList>(h, 'GET', '/collections', { user: person });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ collections: [] });
  });
});
