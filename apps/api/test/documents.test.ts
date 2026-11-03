/**
 * Uploads and documents through the real graph. Holds SPECS outcome #7
 * (magic bytes, the size cap, a per-person upload budget that limits nothing
 * else) and the API half of #4 (the same bytes twice are one document).
 *
 * No worker runs in this lane: a document stays QUEUED, and the job it got is
 * read straight off the BullMQ queue.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  INGEST_QUEUE,
  LIMITS,
  ingestChannel,
  uploadResultSchema,
  documentListSchema,
  chunkViewSchema,
  type IngestEvent,
} from '@rag/shared';
import { sha256Of } from '@rag/shared/server';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IngestEventsService } from '../src/infra/ingest-events.service';
import { AUTH_SECRET, REDIS_URL, boot, call, newUser, upload, type Harness } from './support';
import { mintServiceToken } from '@rag/shared/server';

const UPLOAD_DIR = process.env.UPLOAD_DIR!;
const UPLOAD_BUDGET = Number(process.env.RATE_LIMIT_UPLOAD ?? '10');

let h: Harness;
let queueConnection: Redis;
let queue: Queue;
beforeAll(async () => {
  h = await boot();
  queueConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(INGEST_QUEUE, { connection: queueConnection });
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  queueConnection.disconnect();
  await h.close();
});

const encode = (s: string) => new TextEncoder().encode(s);
let serial = 0;
/** Bytes no other test uploads, so no test sees another's duplicate. */
const unique = (label: string) =>
  encode(`# ${label}\n\nPassage ${String((serial += 1))} ${String(Date.now())}.`);

async function person(label: string) {
  const user = await newUser(h.db, label);
  const shelf = await call<{ id: string }>(h, 'POST', '/collections', {
    user,
    body: { name: 'Shelf' },
  });
  expect(shelf.status).toBe(201);
  return { user, collectionId: shelf.body.id };
}

const stored = (ownerId: string, sha: string) =>
  access(join(UPLOAD_DIR, ownerId, sha)).then(
    () => true,
    () => false,
  );

describe('POST /documents', () => {
  it('is 401 without a session', async () => {
    expect((await call(h, 'POST', '/documents', { user: null })).status).toBe(401);
  });

  it('stores the file by hash, writes a QUEUED row, queues one job, answers 202', async () => {
    const { user, collectionId } = await person('up');
    const bytes = encode('# Boiler manual\n\nThe gauge reads one bar.');
    const r = await upload(h, user, { collectionId, filename: 'boiler.md', bytes });
    expect(r.status).toBe(202);
    const { document, duplicate } = uploadResultSchema.parse(r.body);
    expect(duplicate).toBe(false);
    expect(document).toMatchObject({
      collectionId,
      title: 'Boiler manual',
      filename: 'boiler.md',
      mime: 'text/markdown',
      bytes: bytes.byteLength,
      status: 'QUEUED',
      error: null,
      chunks: 0,
    });
    const sha = sha256Of(bytes);
    expect(await stored(user.id, sha)).toBe(true);
    const job = await queue.getJob(document.id);
    expect(job?.data).toEqual({ documentId: document.id, ownerId: user.id, sha256: sha });
    expect(job?.opts.attempts).toBe(5);
  });

  it('answers the same bytes again with the existing document, 200, one row (SPECS #4)', async () => {
    const { user, collectionId } = await person('dup');
    const bytes = unique('dup');
    const first = uploadResultSchema.parse(
      (await upload(h, user, { collectionId, filename: 'a.md', bytes })).body,
    );
    const again = await upload(h, user, { collectionId, filename: 'renamed.md', bytes });
    expect(again.status).toBe(200);
    const second = uploadResultSchema.parse(again.body);
    expect(second.duplicate).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(second.document.filename).toBe('a.md');
    expect(await h.db.document.count({ where: { ownerId: user.id } })).toBe(1);

    // Another person's identical bytes are their own document.
    const other = await person('dup-other');
    const theirs = await upload(h, other.user, {
      collectionId: other.collectionId,
      filename: 'a.md',
      bytes,
    });
    expect(theirs.status).toBe(202);
  });

  it('gives a FAILED document another go when its bytes are uploaded again', async () => {
    const { user, collectionId } = await person('retry');
    const bytes = unique('retry');
    const first = uploadResultSchema.parse(
      (await upload(h, user, { collectionId, filename: 'r.md', bytes })).body,
    );
    await queue.remove(first.document.id);
    await h.db.document.update({
      where: { id: first.document.id },
      data: {
        status: 'FAILED',
        error: 'the uploaded file is missing from storage; upload it again',
      },
    });
    const again = uploadResultSchema.parse(
      (await upload(h, user, { collectionId, filename: 'r.md', bytes })).body,
    );
    expect(again).toMatchObject({
      duplicate: true,
      document: { id: first.document.id, status: 'QUEUED', error: null },
    });
    expect(await queue.getJob(first.document.id)).toBeDefined();
  });

  it('refuses a .pdf that is not a PDF by its bytes, 415, storing nothing (SPECS #7)', async () => {
    const { user, collectionId } = await person('sniff');
    const bytes = encode('<html><body>not a pdf</body></html>');
    const r = await upload(h, user, { collectionId, filename: 'report.pdf', bytes });
    expect(r.status).toBe(415);
    expect(r.body).toEqual({
      code: 'UNSUPPORTED',
      message: 'Not accepted: the file is not a PDF.',
    });
    expect(await h.db.document.count({ where: { ownerId: user.id } })).toBe(0);
    expect(await stored(user.id, sha256Of(bytes))).toBe(false);
  });

  it('refuses a file over the size cap, 413, before it reaches the service (SPECS #7)', async () => {
    const { user, collectionId } = await person('big');
    const bytes = new Uint8Array(LIMITS.uploadBytes + 1).fill(0x61);
    const r = await upload(h, user, { collectionId, filename: 'big.txt', bytes });
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ code: 'TOO_LARGE' });
    expect(await h.db.document.count({ where: { ownerId: user.id } })).toBe(0);
    // Exactly at the cap is accepted.
    const atCap = await upload(h, user, {
      collectionId,
      filename: 'cap.txt',
      bytes: new Uint8Array(LIMITS.uploadBytes).fill(0x62),
    });
    expect(atCap.status).toBe(202);
  });

  it('is 404 for a collection that is not yours, and 400 with no collection', async () => {
    const owner = await person('shelf-owner');
    const stranger = await person('stranger');
    const bytes = unique('stranger');
    const r = await upload(h, stranger.user, {
      collectionId: owner.collectionId,
      filename: 'x.md',
      bytes,
    });
    expect(r.status).toBe(404);
    expect(await stored(stranger.user.id, sha256Of(bytes))).toBe(false);
    const none = await upload(h, stranger.user, { filename: 'x.md', bytes });
    expect(none.status).toBe(400);
  });
});

describe('the upload budget (SPECS #7)', () => {
  it(`allows ${String(UPLOAD_BUDGET)} uploads a minute per person, then 429, and limits nothing else`, async () => {
    const { user, collectionId } = await person('budget');
    for (let i = 0; i < UPLOAD_BUDGET; i += 1) {
      const r = await upload(h, user, {
        collectionId,
        filename: `n${String(i)}.md`,
        bytes: unique('budget'),
      });
      expect(r.status).toBe(202);
    }
    const over = await upload(h, user, {
      collectionId,
      filename: 'over.md',
      bytes: unique('budget'),
    });
    expect(over.status).toBe(429);
    expect(await h.db.document.count({ where: { ownerId: user.id } })).toBe(UPLOAD_BUDGET);

    // The same person, past the upload budget, still reads their library,
    // lists documents and creates a collection; /health answers. Removing the
    // upload `skipIf` makes each of these the 429 above.
    expect((await call(h, 'GET', '/collections', { user })).status).toBe(200);
    expect((await call(h, 'GET', `/documents?collectionId=${collectionId}`, { user })).status).toBe(
      200,
    );
    expect((await call(h, 'POST', '/collections', { user, body: { name: 'Second' } })).status).toBe(
      201,
    );
    expect((await call(h, 'GET', '/health')).status).not.toBe(429);

    // Another person has their own budget.
    const other = await person('budget-other');
    expect(
      (
        await upload(h, other.user, {
          collectionId: other.collectionId,
          filename: 'o.md',
          bytes: unique('o'),
        })
      ).status,
    ).toBe(202);
  });
});

describe('reading documents', () => {
  it('lists a collection’s documents, newest first, and 404s on a collection that is not yours', async () => {
    const { user, collectionId } = await person('list');
    const a = uploadResultSchema.parse(
      (await upload(h, user, { collectionId, filename: 'a.md', bytes: unique('a') })).body,
    );
    const b = uploadResultSchema.parse(
      (await upload(h, user, { collectionId, filename: 'b.md', bytes: unique('b') })).body,
    );
    const r = await call(h, 'GET', `/documents?collectionId=${collectionId}`, { user });
    expect(r.status).toBe(200);
    expect(documentListSchema.parse(r.body).documents.map((d) => d.id)).toEqual([
      b.document.id,
      a.document.id,
    ]);

    const stranger = await newUser(h.db, 'list-stranger');
    expect(
      (await call(h, 'GET', `/documents?collectionId=${collectionId}`, { user: stranger })).status,
    ).toBe(404);
    expect(
      documentListSchema.parse((await call(h, 'GET', '/documents', { user: stranger })).body)
        .documents,
    ).toEqual([]);
  });

  it('answers one document, its bytes and its passages only to its owner', async () => {
    const { user, collectionId } = await person('read');
    const bytes = encode('# Notes\n\nCafé opening hours.');
    const { document } = uploadResultSchema.parse(
      (await upload(h, user, { collectionId, filename: 'notes.md', bytes })).body,
    );
    const stranger = await newUser(h.db, 'read-stranger');

    expect((await call(h, 'GET', `/documents/${document.id}`, { user })).body).toMatchObject({
      id: document.id,
    });
    expect((await call(h, 'GET', `/documents/${document.id}`, { user: stranger })).status).toBe(
      404,
    );

    const file = await fetch(`${h.base}/documents/${document.id}/file`, {
      headers: { authorization: `Bearer ${mintServiceToken(user, AUTH_SECRET)}` },
    });
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(file.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('content-security-policy')).toContain('sandbox');
    expect(
      (await call(h, 'GET', `/documents/${document.id}/file`, { user: stranger })).status,
    ).toBe(404);

    // A passage, written as the worker writes one.
    const chunkId = 'c' + 'a1'.repeat(12);
    const vector = `[${new Array<string>(1024).fill('0.03125').join(',')}]`;
    await h.db.$executeRaw`
      INSERT INTO "chunks" ("id", "owner_id", "document_id", "ord", "text", "char_start", "char_end",
                            "heading_path", "tokens", "embedding", "embedding_model")
      VALUES (${chunkId}, ${user.id}, ${document.id}, 0, ${'Café opening hours.'}, 9, 28,
              ${['Notes']}::text[], 5, ${vector}::halfvec, 'qwen3-embedding:0.6b')`;
    const chunk = await call(h, 'GET', `/documents/${document.id}/chunks/${chunkId}`, { user });
    expect(chunkViewSchema.parse(chunk.body)).toEqual({
      id: chunkId,
      documentId: document.id,
      ord: 0,
      text: 'Café opening hours.',
      charStart: 9,
      charEnd: 28,
      pageStart: null,
      pageEnd: null,
      pageStarts: [],
      headingPath: ['Notes'],
    });
    expect(
      (await call(h, 'GET', `/documents/${document.id}/chunks/${chunkId}`, { user: stranger }))
        .status,
    ).toBe(404);
    expect((await call(h, 'GET', `/documents/${document.id}`, { user })).body).toMatchObject({
      chunks: 1,
    });
  });
});

describe('deleting', () => {
  it('removes a document, its file and its waiting job; 404 for anyone else', async () => {
    const { user, collectionId } = await person('del');
    const bytes = unique('del');
    const { document } = uploadResultSchema.parse(
      (await upload(h, user, { collectionId, filename: 'd.md', bytes })).body,
    );
    const stranger = await newUser(h.db, 'del-stranger');
    expect((await call(h, 'DELETE', `/documents/${document.id}`, { user: stranger })).status).toBe(
      404,
    );

    expect((await call(h, 'DELETE', `/documents/${document.id}`, { user })).status).toBe(204);
    expect(await h.db.document.count({ where: { id: document.id } })).toBe(0);
    expect(await stored(user.id, sha256Of(bytes))).toBe(false);
    expect(await queue.getJob(document.id)).toBeUndefined();
    expect((await call(h, 'GET', `/documents/${document.id}`, { user })).status).toBe(404);
  });

  it('removes a collection with its documents and their files; 409 on a name taken; 404 for anyone else', async () => {
    const { user, collectionId } = await person('del-shelf');
    expect(
      (await call(h, 'POST', '/collections', { user, body: { name: 'Shelf' } })).body,
    ).toMatchObject({
      code: 'CONFLICT',
    });
    expect((await call(h, 'POST', '/collections', { user, body: { name: '  ' } })).status).toBe(
      400,
    );
    const bytes = unique('shelf');
    await upload(h, user, { collectionId, filename: 's.md', bytes });
    const stranger = await newUser(h.db, 'shelf-stranger');
    expect(
      (await call(h, 'DELETE', `/collections/${collectionId}`, { user: stranger })).status,
    ).toBe(404);

    expect((await call(h, 'DELETE', `/collections/${collectionId}`, { user })).status).toBe(204);
    expect(await h.db.document.count({ where: { ownerId: user.id } })).toBe(0);
    expect(await stored(user.id, sha256Of(bytes))).toBe(false);
  });
});

describe('GET /documents/events', () => {
  /** One open stream, read frame by frame. */
  async function openStream(user: { id: string; email: string; name: string }) {
    const controller = new AbortController();
    const response = await fetch(`${h.base}/documents/events`, {
      headers: { authorization: `Bearer ${mintServiceToken(user, AUTH_SECRET)}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
      async next(): Promise<{ event: string; data: string }> {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            return {
              event: /^event: (.*)$/mu.exec(frame)?.[1] ?? 'message',
              data: /^data: (.*)$/mu.exec(frame)?.[1] ?? '',
            };
          }
          const { value, done } = await reader.read();
          if (done) throw new Error('the stream ended');
          buffer += decoder.decode(value, { stream: true });
        }
      },
      close: () => controller.abort(),
    };
  }

  const event = (ownerId: string): IngestEvent => ({
    documentId: ownerId,
    collectionId: ownerId,
    status: 'EMBEDDING',
    progress: { done: 1, total: 2 },
    error: null,
    at: new Date().toISOString(),
  });

  it('streams each person their own events and nobody else’s', async () => {
    const alma = await newUser(h.db, 'sse-alma');
    const bruno = await newUser(h.db, 'sse-bruno');
    // Both streams open at once, so both channels are live on the one
    // subscriber connection: a routing mistake would hand Alma Bruno's event.
    const almaStream = await openStream(alma);
    const brunoStream = await openStream(bruno);
    expect((await almaStream.next()).event).toBe('subscribed');
    expect((await brunoStream.next()).event).toBe('subscribed');

    // Bruno's first, so Alma receiving hers proves his was not delivered to her.
    await h.redis.publish(ingestChannel(bruno.id), JSON.stringify(event(bruno.id)));
    await h.redis.publish(ingestChannel(alma.id), JSON.stringify(event(alma.id)));

    const toAlma = await almaStream.next();
    expect(toAlma.event).toBe('ingest');
    expect((JSON.parse(toAlma.data) as IngestEvent).documentId).toBe(alma.id);
    const toBruno = await brunoStream.next();
    expect((JSON.parse(toBruno.data) as IngestEvent).documentId).toBe(bruno.id);

    almaStream.close();
    brunoStream.close();
    // Closed streams let go of their channels.
    const events = h.app.get(IngestEventsService);
    await expect.poll(() => events.channels, { timeout: 2_000 }).toBe(0);
  });

  it('is 401 without a session', async () => {
    expect((await call(h, 'GET', '/documents/events', { user: null })).status).toBe(401);
  });
});
