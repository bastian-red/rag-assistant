import 'server-only';

/**
 * The route handlers' half of "the browser never calls the API": a request
 * the browser starts (an upload, a live status feed, a streamed answer, the
 * original file) reaches this server, which forwards it with a fresh service
 * token and hands back the answer.
 *
 * Streams are re-framed, not piped blind. Every chat event is validated
 * against contract v1 here (`readChatStream`) and every ingest event against
 * its schema, so the browser bundle can parse frames with the zod-free
 * `@rag/shared/sse` and still only ever see contract-shaped data.
 *
 * **Stop travels as a disconnect.** When the reader presses Stop the browser
 * aborts its fetch; Next cancels the response stream (`cancel` below) and
 * that aborts the upstream request, which is how the API learns to stop the
 * model and store the answer as STOPPED (SPECS #5). The request's own signal
 * is wired too, and covers a disconnect before the first byte. Measured
 * 2026-11-07 in Chromium and Firefox: either path alone carries Stop, so the
 * red proof in scripts/red-proofs.mjs breaks both.
 */
import {
  idSchema,
  ingestEventSchema,
  readChatStream,
  sseFrame,
  createSseParser,
  type SessionUser,
} from '@rag/shared';
import { mintServiceToken } from '@rag/shared/server';

import { auth } from '../auth';
import { apiBaseUrl, authSecret } from './config';

/** A JSON problem in the API's own shape, so the browser reads one kind of error. */
export function problem(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { 'cache-control': 'no-store' } });
}

/** The signed-in user, or null. Route handlers answer 401 themselves; they never redirect. */
export async function sessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  return session?.user ?? null;
}

/** An id from a path segment, or null: a malformed id is a 404 here, not a call. */
export function pathId(value: string): string | null {
  return idSchema.safeParse(value).success ? value : null;
}

export async function upstream(
  user: SessionUser,
  path: string,
  init: {
    readonly method?: string;
    readonly body?: BodyInit | null;
    readonly headers?: Record<string, string>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...init.headers, authorization: `Bearer ${mintServiceToken(user, authSecret())}` },
    body: init.body ?? null,
    signal: init.signal,
    cache: 'no-store',
    // Node's fetch needs this to send a ReadableStream body (the upload).
    ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/** The API's answer as is: status and JSON body, never cached. */
export async function relayJson(response: Response): Promise<Response> {
  const text = await response.text();
  return new Response(text === '' ? null : text, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

/** An abort controller that also fires when the browser's request goes away. */
export function linkedAbort(request: Request): AbortController {
  const controller = new AbortController();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  // A proxy in front of Next must not hold frames back to fill a buffer.
  'x-accel-buffering': 'no',
} as const;

/**
 * A stream of SSE text written by `produce`, which ends when it returns.
 * The browser leaving cancels it, and cancelling aborts `abort`.
 */
function sseResponse(
  abort: AbortController,
  produce: (write: (text: string) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(text));
      };
      try {
        await produce(write);
      } finally {
        try {
          controller.close();
        } catch {
          // Already cancelled by the browser leaving.
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

/** A chat answer, each event validated against contract v1 on its way through. */
export function relayChat(response: Response, abort: AbortController): Response {
  return sseResponse(abort, async (write) => {
    try {
      for await (const event of readChatStream(response.body!)) write(sseFrame(event));
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error('[web] the chat stream broke off:', error);
      write(
        sseFrame({
          event: 'error',
          data: { code: 'internal', message: 'The answer stream broke off.' },
        }),
      );
    }
  });
}

/**
 * The ingest feed: `subscribed` and validated `ingest` events, and the
 * API's heartbeat forwarded as a comment so an idle connection stays open
 * through any proxy that closes silent ones.
 */
export function relayIngest(response: Response, abort: AbortController): Response {
  return sseResponse(abort, async (write) => {
    const parser = createSseParser();
    const decoder = new TextDecoder();
    const reader = response.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.event === 'subscribed') write('event: subscribed\ndata: {}\n\n');
          else if (frame.event === 'ping') write(': ping\n\n');
          else if (frame.event === 'ingest') {
            let json: unknown = null;
            try {
              json = JSON.parse(frame.data);
            } catch {
              // Counted as off-contract below.
            }
            const parsed = ingestEventSchema.safeParse(json);
            if (parsed.success) write(`event: ingest\ndata: ${JSON.stringify(parsed.data)}\n\n`);
            else console.error('[web] an ingest event did not match its contract');
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) console.error('[web] the ingest feed broke off:', error);
    } finally {
      reader.releaseLock();
    }
  });
}
