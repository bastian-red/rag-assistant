/**
 * The worker as it runs: a real BullMQ queue on Redis db 1, the health
 * server, the start-up reconcile, and a worker process killed mid-embed
 * (SPECS #4: "a worker killed mid-embed retries to READY with no duplicate
 * chunks").
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { chunkDocument } from '@rag/chunker';
import { healthSchema, ingestJobOptions, INGEST_QUEUE } from '@rag/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startIngest, type RunningIngest } from '../src/app';
import { ingestDocument } from '../src/pipeline';
import {
  addDocument,
  chunksOf,
  closeSupport,
  config,
  db,
  deps,
  eventually,
  FAKE_SPACE,
  fakeEmbedCalls,
  forgetPeople,
  longMarkdown,
  newPerson,
  setFakeEmbed,
} from './support';

const encode = (s: string) => new TextEncoder().encode(s);
const quiet = () => undefined;

let connection: Redis;
let queue: Queue;
beforeAll(() => {
  connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  queue = new Queue(INGEST_QUEUE, { connection });
});
const running: RunningIngest[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(running.splice(0).map((r) => r.close()));
  await setFakeEmbed(null);
  await queue.obliterate({ force: true });
  await forgetPeople();
});
afterAll(async () => {
  await queue.close();
  connection.disconnect();
  await closeSupport();
});

async function start(overrides: Partial<typeof config> = {}): Promise<RunningIngest> {
  const r = await startIngest({ ...config, port: 0, ...overrides }, quiet);
  running.push(r);
  return r;
}

const statusOf = async (id: string) =>
  (await db.document.findUnique({ where: { id }, select: { status: true } }))?.status;

describe('the running worker', () => {
  it('takes a queued job to READY, and a second add for the same document is a no-op', async () => {
    const person = await newPerson('queued');
    const job = await addDocument(person, 'q.md', encode('# Queue\n\nOne passage to embed.'));
    await setFakeEmbed({ delayMs: 300 });
    await queue.add(INGEST_QUEUE, job, ingestJobOptions(job.documentId));
    await queue.add(INGEST_QUEUE, job, ingestJobOptions(job.documentId));
    expect(await queue.getJobCounts('wait', 'active')).toEqual({ wait: 1, active: 0 });
    await start();
    await eventually('READY', async () => (await statusOf(job.documentId)) === 'READY');
    expect(await db.chunk.count({ where: { documentId: job.documentId } })).toBe(1);
  });

  it('queues, at start, every unfinished document that has no job', async () => {
    const person = await newPerson('orphan');
    const job = await addDocument(person, 'orphan.md', encode('# Orphan\n\nNever queued.'));
    await start();
    await eventually('READY', async () => (await statusOf(job.documentId)) === 'READY');
  });

  it('answers /health 200 when ready and 503 naming the embedding model when it is not', async () => {
    const r = await start();
    const ok = await fetch(`http://127.0.0.1:${String(r.port)}/health`);
    expect(ok.status).toBe(200);
    const body = healthSchema.parse(await ok.json());
    expect(body.service).toBe('ingest');
    expect(body.checks.map((c) => [c.name, c.status])).toEqual([
      ['postgres', 'ok'],
      ['redis', 'ok'],
      ['embed-model', 'ok'],
      ['uploads', 'ok'],
      ['worker', 'ok'],
    ]);

    const missing = await start({ embedModel: 'nomic-embed-text:latest' });
    const degraded = await fetch(`http://127.0.0.1:${String(missing.port)}/health`);
    expect(degraded.status).toBe(503);
    const check = healthSchema
      .parse(await degraded.json())
      .checks.find((c) => c.name === 'embed-model');
    expect(check?.detail).toBe('not pulled: nomic-embed-text:latest (run scripts/ollama-setup.sh)');
  });
});

describe('chunks from another vector space', () => {
  /** A READY document whose chunks say they came from `label`. */
  async function readyUnder(label: string, name: string) {
    const person = await newPerson(name);
    const job = await addDocument(person, `${name}.md`, encode(longMarkdown(3)));
    await ingestDocument(job, deps());
    await db.$executeRaw`UPDATE chunks SET embedding_model = ${label} WHERE document_id = ${job.documentId}`;
    return job;
  }
  const spacesOf = async (documentId: string) =>
    new Set((await chunksOf(documentId)).map((c) => c.embedding_model));

  it('are embedded again at start: the bare name the fake once wrote under is not this space', async () => {
    // Exactly what the dev database held on 2026-11-05: the fake's hashed
    // vectors labelled with the real model's name.
    const job = await readyUnder(config.embedModel, 'stale-start');
    const chunks = (await chunksOf(job.documentId)).length;
    await start();
    await eventually('re-embedded in the current space', async () => {
      const spaces = await spacesOf(job.documentId);
      return (
        spaces.size === 1 && spaces.has(FAKE_SPACE) && (await statusOf(job.documentId)) === 'READY'
      );
    });
    expect((await chunksOf(job.documentId)).length).toBe(chunks);
  });

  it('are found by the periodic sweep too, not only at start', async () => {
    const person = await newPerson('stale-sweep');
    const job = await addDocument(person, 'sweep.md', encode(longMarkdown(2)));
    await start({ sweepMs: 1_000 });
    await eventually('READY', async () => (await statusOf(job.documentId)) === 'READY');
    await db.$executeRaw`UPDATE chunks SET embedding_model = 'other-model:1b@0123456789ab' WHERE document_id = ${job.documentId}`;
    await eventually('the sweep to re-embed it', async () => {
      const spaces = await spacesOf(job.documentId);
      return spaces.size === 1 && spaces.has(FAKE_SPACE);
    });
  });

  it('leave a document in the current space alone', async () => {
    const job = await readyUnder(FAKE_SPACE, 'current');
    const before = await fakeEmbedCalls();
    await start({ sweepMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await fakeEmbedCalls()).toBe(before);
    expect(await statusOf(job.documentId)).toBe('READY');
  });
});

describe('a worker killed mid-embed (SPECS #4)', () => {
  it('is picked up by another worker and ends READY with one gap-free chunk set', async () => {
    const person = await newPerson('killed');
    const text = longMarkdown(40);
    const expected = chunkDocument({ format: 'markdown', text }).chunks.length;
    // More than one 32-passage batch, so the kill lands between batches.
    expect(expected).toBeGreaterThan(32);
    const job = await addDocument(person, 'killed.md', encode(text));
    await setFakeEmbed({ delayMs: 1_500 });
    const before = await fakeEmbedCalls();

    // The first worker is a real process, so SIGKILL is a real crash: no
    // graceful close, no lock released, nothing written after the signal.
    const lockMs = 5_000;
    const child = spawn(process.execPath, [join(__dirname, '..', 'dist', 'main.js')], {
      env: { ...process.env, INGEST_PORT: '4591', INGEST_LOCK_MS: String(lockMs) },
      stdio: 'ignore',
    });
    children.push(child);
    await queue.add(INGEST_QUEUE, job, ingestJobOptions(job.documentId));
    await eventually(
      'the first batch to be embedded',
      async () => (await fakeEmbedCalls()) > before,
    );
    expect(await statusOf(job.documentId)).toBe('EMBEDDING');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect(await db.chunk.count({ where: { documentId: job.documentId } })).toBe(0);

    // A second worker finds the stalled job once the dead one's lock expires.
    await setFakeEmbed(null);
    await start({ lockMs });
    await eventually(
      'READY after the crash',
      async () => (await statusOf(job.documentId)) === 'READY',
      60_000,
    );

    const rows = await chunksOf(job.documentId);
    expect(rows).toHaveLength(expected);
    expect(rows.map((r) => r.ord)).toEqual(Array.from({ length: expected }, (_, i) => i));
    // Both runs embedded: the first one really was killed mid-document.
    expect((await fakeEmbedCalls()) - before).toBeGreaterThan(Math.ceil(expected / 32));
  });
});
