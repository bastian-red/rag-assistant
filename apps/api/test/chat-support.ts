/**
 * The chat lane's helpers: a READY document with its chunks written the way
 * the ingest worker writes them (the chunker's output, the fake model's hash
 * vectors, the fake's vector space), the fake model server's control and log
 * routes, and a reader for the event stream.
 *
 * No worker runs in this lane, so documents are written here rather than
 * uploaded and waited for. The vectors are the ones the fake model server
 * gives the API for a query, so retrieval ranks for real.
 */
import { randomBytes } from 'node:crypto';

import { chunkDocument } from '@rag/chunker';
import { Prisma, type PrismaClient } from '@rag/db';
import { fakeDigest, hashEmbedding } from '@rag/llm';
import {
  embeddingSpace,
  readChatStream,
  type ChatMessage,
  type ChatStreamEvent,
  type SessionUser,
} from '@rag/shared';
import { mintServiceToken } from '@rag/shared/server';

import { AUTH_SECRET, randomAddress, type Harness } from './support';

export const OLLAMA_URL = process.env.OLLAMA_URL ?? '';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'qwen3-embedding:0.6b';

/** The space the fake model server reports for the embedding model. */
export const FAKE_SPACE = embeddingSpace(EMBED_MODEL, fakeDigest(EMBED_MODEL));

export async function addDocument(
  db: PrismaClient,
  owner: { id: string; collectionId: string },
  title: string,
  text: string,
): Promise<{ id: string; chunkIds: string[] }> {
  const doc = await db.document.create({
    data: {
      ownerId: owner.id,
      collectionId: owner.collectionId,
      title,
      filename: `${title.replace(/[^a-z0-9]+/giu, '-')}.md`,
      mime: 'text/markdown',
      bytes: new TextEncoder().encode(text).byteLength,
      sha256: randomBytes(32).toString('hex'),
      status: 'READY',
    },
    select: { id: true },
  });
  const chunks = chunkDocument({ format: 'markdown', text }).chunks;
  const ids = chunks.map(() => `c${randomBytes(12).toString('hex')}`);
  const rows = chunks.map(
    (chunk, i) => Prisma.sql`(
      ${ids[i]!}, ${owner.id}, ${doc.id}, ${chunk.ord}, ${chunk.text},
      ${chunk.pageStart}::int, ${chunk.pageEnd}::int, ${JSON.stringify(chunk.pageStarts)}::jsonb,
      ${chunk.charStart}, ${chunk.charEnd}, ${[...chunk.headingPath]}::text[], ${chunk.tokens},
      ${`[${hashEmbedding(chunk.text).join(',')}]`}::halfvec, ${FAKE_SPACE}
    )`,
  );
  await db.$executeRaw`
    INSERT INTO "chunks" (
      "id", "owner_id", "document_id", "ord", "text",
      "page_start", "page_end", "page_starts",
      "char_start", "char_end", "heading_path", "tokens",
      "embedding", "embedding_model"
    ) VALUES ${Prisma.join(rows)}`;
  return { id: doc.id, chunkIds: ids };
}

// --- the fake model server --------------------------------------------------

export interface FakeChat {
  readonly model: string;
  readonly messages: ChatMessage[];
  readonly piecesSent: number;
  readonly aborted: boolean;
  readonly completed: boolean;
}

export async function fakeChats(): Promise<FakeChat[]> {
  const r = await fetch(`${OLLAMA_URL}/__fake/log`);
  return ((await r.json()) as { chats: FakeChat[] }).chats;
}

export async function fakeScript(script: Record<string, unknown> | null): Promise<void> {
  const r = await fetch(`${OLLAMA_URL}/__fake/chat`, {
    method: script === null ? 'DELETE' : 'PUT',
    headers: { 'content-type': 'application/json' },
    ...(script === null ? {} : { body: JSON.stringify(script) }),
  });
  if (!r.ok) throw new Error(`fake chat script: ${String(r.status)} ${await r.text()}`);
}

/** Poll until `check` holds, or fail naming what was waited for. */
export async function until<T>(
  what: string,
  read: () => Promise<T>,
  check: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// --- asking -----------------------------------------------------------------

export interface Asked {
  readonly status: number;
  readonly contentType: string | null;
  /** The events read, in order (empty for a non-stream reply). */
  readonly events: ChatStreamEvent[];
  /** The JSON body of a refused request. */
  readonly body: unknown;
  /** Every byte of the reply as text: what a leak check greps. */
  readonly raw: string;
  /** Token texts joined: what the reader saw. */
  readonly text: string;
  /** The request was aborted by `stopAfter`. */
  readonly stopped: boolean;
}

/**
 * `POST /chat/:id/messages`, read to the end, or stopped after `stopAfter`
 * token events (the client closing the request, as the Stop button does).
 */
export async function ask(
  h: Harness,
  user: SessionUser,
  conversationId: string,
  content: unknown,
  options: { stopAfter?: number; onEvent?: (event: ChatStreamEvent) => void | Promise<void> } = {},
): Promise<Asked> {
  const controller = new AbortController();
  const response = await fetch(`${h.base}/chat/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': randomAddress(),
      authorization: `Bearer ${mintServiceToken(user, AUTH_SECRET)}`,
    },
    body: JSON.stringify({ content }),
    signal: controller.signal,
  });
  const contentType = response.headers.get('content-type');
  if (!contentType?.startsWith('text/event-stream') || response.body === null) {
    const raw = await response.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // not JSON
    }
    return {
      status: response.status,
      contentType,
      events: [],
      body,
      raw,
      text: '',
      stopped: false,
    };
  }
  const [forEvents, forRaw] = response.body.tee();
  const rawText = new Response(forRaw).text().catch(() => '');
  const events: ChatStreamEvent[] = [];
  let tokens = 0;
  let stopped = false;
  try {
    for await (const event of readChatStream(forEvents)) {
      events.push(event);
      await options.onEvent?.(event);
      if (event.event === 'token') tokens += 1;
      if (options.stopAfter !== undefined && tokens >= options.stopAfter) {
        stopped = true;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!stopped) throw error;
  }
  const raw = stopped ? '' : await rawText;
  return {
    status: response.status,
    contentType,
    events,
    body: undefined,
    raw,
    text: events.map((e) => (e.event === 'token' ? e.data.text : '')).join(''),
    stopped,
  };
}

/** The event names of a reply, in order, with consecutive tokens folded into one. */
export function shape(events: readonly ChatStreamEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) if (out.at(-1) !== e.event || e.event !== 'token') out.push(e.event);
  return out;
}
