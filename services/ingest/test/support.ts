/**
 * The integration lane's helpers: real Postgres (rag_it), real Redis (db 1)
 * and the fake model server, all started by scripts/integration.sh.
 *
 * Every test makes its own person (a user with one collection) and deletes
 * them after, which cascades their documents and chunks.
 */
import { randomUUID } from 'node:crypto';

import { createPrismaClient, type PrismaClient } from '@rag/db';
import { createOllama, fakeDigest } from '@rag/llm';
import {
  documentTitle,
  embeddingSpace,
  ingestChannel,
  ingestEventSchema,
  type IngestEvent,
} from '@rag/shared';
import { sha256Of, writeStoredFile } from '@rag/shared/server';
import { Redis } from 'ioredis';

import { loadConfig, type IngestConfig } from '../src/config';
import type { PipelineDeps } from '../src/pipeline';
import { redisPublisher } from '../src/events';

export const config: IngestConfig = loadConfig();
export const db: PrismaClient = createPrismaClient({ url: config.databaseUrl });
const ollama = createOllama({ baseUrl: config.ollamaUrl });

/** The space the fake model server embeds into: its own digest, not the real model's. */
export const FAKE_SPACE = embeddingSpace(config.embedModel, fakeDigest(config.embedModel));

export function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  const redis = publisher();
  return {
    prisma: db,
    embed: (texts) => ollama.embed(config.embedModel, texts),
    embeddingSpace: () => ollama.embeddingSpace(config.embedModel),
    uploadDir: config.uploadDir,
    publish: redisPublisher(redis),
    ...overrides,
  };
}

let shared: Redis | undefined;
function publisher(): Redis {
  shared ??= new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  return shared;
}

export interface Person {
  readonly id: string;
  readonly collectionId: string;
}

const made: string[] = [];

export async function newPerson(label: string): Promise<Person> {
  const user = await db.user.create({
    data: {
      email: `ingest-${label}-${randomUUID()}@test.invalid`,
      name: `Ingest ${label}`,
      passwordHash: 'not-a-real-hash',
    },
  });
  made.push(user.id);
  const collection = await db.collection.create({ data: { ownerId: user.id, name: 'Shelf' } });
  return { id: user.id, collectionId: collection.id };
}

export async function forgetPeople(): Promise<void> {
  await db.user.deleteMany({ where: { id: { in: made.splice(0) } } });
}

const MIME = {
  md: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
} as const;

/** Store the bytes as the API does and insert a QUEUED row. Returns the job. */
export async function addDocument(
  person: Person,
  filename: string,
  bytes: Uint8Array,
  options: { store?: boolean } = {},
) {
  const ext = filename.slice(filename.lastIndexOf('.') + 1) as keyof typeof MIME;
  const mime = MIME[ext];
  const sha256 =
    options.store === false
      ? sha256Of(bytes)
      : (await writeStoredFile(config.uploadDir, person.id, bytes)).sha256;
  const text = mime === 'application/pdf' ? null : new TextDecoder().decode(bytes);
  const doc = await db.document.create({
    data: {
      ownerId: person.id,
      collectionId: person.collectionId,
      title: documentTitle(filename, text),
      filename,
      mime,
      bytes: bytes.byteLength,
      sha256,
    },
  });
  return { documentId: doc.id, ownerId: person.id, sha256 };
}

export interface ChunkRow {
  id: string;
  ord: number;
  text: string;
  page_start: number | null;
  page_end: number | null;
  embedding_model: string;
  dims: number;
}

export function chunksOf(documentId: string): Promise<ChunkRow[]> {
  return db.$queryRaw<ChunkRow[]>`
    SELECT "id", "ord", "text", "page_start", "page_end", "embedding_model",
           vector_dims("embedding"::vector) AS "dims"
    FROM "chunks" WHERE "document_id" = ${documentId} ORDER BY "ord"`;
}

/** Every event on a person's channel until `stop()`. */
export async function listen(ownerId: string) {
  const subscriber = new Redis(config.redisUrl);
  const events: IngestEvent[] = [];
  subscriber.on('message', (_channel: string, message: string) => {
    events.push(ingestEventSchema.parse(JSON.parse(message)));
  });
  await subscriber.subscribe(ingestChannel(ownerId));
  return {
    events,
    stop: async () => {
      await subscriber.quit();
    },
  };
}

/** Poll until `check` returns a value, or fail after `timeoutMs` naming what was awaited. */
export async function eventually<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function setFakeEmbed(script: Record<string, unknown> | null): Promise<void> {
  const response = await fetch(`${config.ollamaUrl}/__fake/embed`, {
    method: script === null ? 'DELETE' : 'PUT',
    body: script === null ? undefined : JSON.stringify(script),
  });
  if (!response.ok) throw new Error(`fake embed control answered ${String(response.status)}`);
}

export async function fakeEmbedCalls(): Promise<number> {
  const response = await fetch(`${config.ollamaUrl}/__fake/log`);
  const log = (await response.json()) as { embeds: unknown[] };
  return log.embeds.length;
}

export async function closeSupport(): Promise<void> {
  await forgetPeople();
  shared?.disconnect();
  shared = undefined;
  await db.$disconnect();
}

/** A markdown file long enough for `n` chunks of roughly 400 tokens each. */
export function longMarkdown(sections: number): string {
  const sentence =
    'The relief valve opens when the pressure passes three bar and closes again below it. ';
  return Array.from(
    { length: sections },
    (_, i) => `## Section ${String(i + 1)}\n\n${sentence.repeat(22)}\n`,
  ).join('\n');
}
