/**
 * Conversations and the chat stream, contract v1 (SPECS section 3).
 *
 * `POST /chat/:conversationId/messages` answers `text/event-stream`. The
 * client reads it with fetch and a ReadableStream, not EventSource, because
 * the request has a body and an Authorization header. Every frame is
 *
 *     event: <name>
 *     data: <one line of JSON>
 *
 * and both sides validate the JSON with the schemas below. The order is fixed:
 *
 *     retrieval, then EITHER abstain OR (token | citation)*, then done
 *     error ends the stream at any point after the response started
 *
 * `retrieval` always comes before the first `token` (SPECS #5), and carries
 * the ids of the stored question and answer, so a client can find the answer
 * again after a reload. A comment line (`: ping`) keeps an idle connection
 * open while a CPU model reads the prompt; parsers skip it.
 *
 * The client stops a generation by aborting the request. The API then aborts
 * the model call and stores the answer as STOPPED with the text the reader
 * had been sent. No event is written after an abort, because nobody is
 * listening.
 */
import { z } from 'zod';

import { LIMITS } from '../constants';
import { chatUsageSchema } from './llm';
import { idSchema, instantSchema } from './primitives';

export const CHAT_STREAM_VERSION = 1;

/** What the stored answer says when retrieval found nothing to answer from (SPECS section 1). */
export const NOT_FOUND_ANSWER = 'Not found in your documents.';

// --- conversations -----------------------------------------------------------

/** `POST /conversations`. No collection asks the whole library. */
export const createConversationSchema = z
  .object({ collectionId: idSchema.nullable().default(null) })
  .strict();
export type CreateConversation = z.input<typeof createConversationSchema>;

/** `POST /chat/:conversationId/messages`. */
export const sendMessageSchema = z
  .object({ content: z.string().trim().min(1).max(LIMITS.question) })
  .strict();
export type SendMessage = z.infer<typeof sendMessageSchema>;

export const conversationSummarySchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(LIMITS.conversationTitle),
    /** The collection it asks; null for the whole library (or a collection since deleted). */
    collectionId: idSchema.nullable(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/** `GET /conversations`: newest activity first. */
export const conversationListSchema = z
  .object({ conversations: z.array(conversationSummarySchema) })
  .strict();
export type ConversationList = z.infer<typeof conversationListSchema>;

export const MESSAGE_ROLES = ['USER', 'ASSISTANT'] as const;
export const MESSAGE_STATUSES = ['STREAMING', 'DONE', 'STOPPED', 'FAILED'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * One stored citation: the passage a marker named, copied at answer time.
 * `chunkId` and `documentId` are null once the document was deleted; the
 * title, page and quote still say what was cited.
 */
export const citationViewSchema = z
  .object({
    marker: z.number().int().min(1).max(50),
    chunkId: idSchema.nullable(),
    documentId: idSchema.nullable(),
    documentTitle: z.string().min(1),
    page: z.number().int().positive().nullable(),
    quote: z.string().min(1),
    /** [quoteStart, quoteEnd) in code points of the chunk's text. */
    quoteStart: z.number().int().nonnegative(),
    quoteEnd: z.number().int().positive(),
  })
  .strict();
export type CitationView = z.infer<typeof citationViewSchema>;

export const messageViewSchema = z
  .object({
    id: idSchema,
    role: z.enum(MESSAGE_ROLES),
    content: z.string(),
    status: z.enum(MESSAGE_STATUSES),
    /** Why an answer FAILED; null otherwise. */
    error: z.string().nullable(),
    /** The answer is the "not found" reply: retrieval found nothing to answer from. */
    abstained: z.boolean(),
    createdAt: instantSchema,
    citations: z.array(citationViewSchema),
  })
  .strict();
export type MessageView = z.infer<typeof messageViewSchema>;

/** `GET /conversations/:id`: the conversation and its messages, oldest first. */
export const conversationDetailSchema = conversationSummarySchema
  .extend({ messages: z.array(messageViewSchema) })
  .strict();
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

// --- stream events -------------------------------------------------------------

/** How much of a passage the `retrieval` event shows before the answer arrives. */
export const SNIPPET_CHARS = 240;

/** A source as the reader sees it while the answer streams. */
export const streamSourceSchema = z
  .object({
    marker: z.number().int().min(1).max(50),
    documentId: idSchema,
    /** The (first) stored chunk the source is made of: what the viewer opens. */
    chunkId: idSchema,
    documentTitle: z.string().min(1),
    page: z.number().int().positive().nullable(),
    pageEnd: z.number().int().positive().nullable(),
    headingPath: z.array(z.string()),
    /** The passage's opening, at most SNIPPET_CHARS code points, cut at a word. */
    snippet: z.string(),
  })
  .strict();
export type StreamSource = z.infer<typeof streamSourceSchema>;

export const droppedMarkerSchema = z
  .object({ raw: z.string().min(1), labels: z.array(z.number().int().nonnegative()) })
  .strict();

/**
 * Why a stream ended in `error`, as a code a client switches on:
 * `unavailable` (the model server or a model is missing), `failed` (the
 * model or a dependency failed mid-answer), `timeout` (no answer in time),
 * `internal` (anything else; the message says nothing more).
 */
export const CHAT_ERROR_CODES = ['unavailable', 'failed', 'timeout', 'internal'] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

const ms = z.number().int().nonnegative();

export const chatStreamEventSchemas = {
  retrieval: z
    .object({
      version: z.literal(CHAT_STREAM_VERSION),
      questionId: idSchema,
      answerId: idSchema,
      /** What the prompt carries, [S1] first. Empty when the answer is an abstention. */
      sources: z.array(streamSourceSchema),
      /** READY documents in scope that are being embedded again and could not be searched. */
      staleDocuments: z.number().int().nonnegative(),
    })
    .strict(),
  /** Visible answer text, markers in canonical form (`[S1][S3]`). */
  token: z.object({ text: z.string().min(1) }).strict(),
  /** A marker cited for the first time; its source is in `retrieval`. */
  citation: z
    .object({ marker: z.number().int().min(1).max(50), documentId: idSchema, chunkId: idSchema })
    .strict(),
  /** Nothing in reach: the chat model was not called (SPECS section 1). */
  abstain: z
    .object({
      text: z.literal(NOT_FOUND_ANSWER),
      reason: z.enum(['no_candidates', 'below_threshold']),
      bestSimilarity: z.number().min(-1).max(1).nullable(),
      /** The closest passages, shown so the reader sees what was near. */
      nearest: z.array(streamSourceSchema),
    })
    .strict(),
  done: z
    .object({
      answerId: idSchema,
      citations: z.array(citationViewSchema),
      /** Markers that named no packed source, removed from the text (SPECS #2). */
      dropped: z.array(droppedMarkerSchema),
      /** The model's own accounting; null for an abstention (no model call). */
      usage: chatUsageSchema.nullable(),
      timings: z.object({ retrievalMs: ms, firstTokenMs: ms.nullable(), totalMs: ms }).strict(),
    })
    .strict(),
  error: z.object({ code: z.enum(CHAT_ERROR_CODES), message: z.string().min(1) }).strict(),
} as const;

export type ChatStreamEventName = keyof typeof chatStreamEventSchemas;
export const CHAT_STREAM_EVENTS = Object.keys(chatStreamEventSchemas) as ChatStreamEventName[];

export type ChatStreamEvent = {
  [K in ChatStreamEventName]: { event: K; data: z.infer<(typeof chatStreamEventSchemas)[K]> };
}[ChatStreamEventName];

/**
 * One SSE frame. The data is JSON on one line: `JSON.stringify` never emits
 * a raw newline (it escapes them inside strings), so a frame cannot be split
 * by the text it carries.
 */
export function sseFrame(event: ChatStreamEvent): string {
  const data = chatStreamEventSchemas[event.event].parse(event.data);
  return `event: ${event.event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A raw frame as the SSE grammar defines it, before validation. */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/**
 * An incremental parser for the `text/event-stream` grammar (the WHATWG
 * HTML "event stream interpretation" subset this API uses): lines end in
 * LF, CR or CRLF; `event:` names the frame (default `message`); every
 * `data:` line is joined by LF; a line starting with `:` is a comment; a
 * blank line dispatches. One leading space after the colon is dropped.
 *
 * Split invariance: the frames are the same however the stream is cut into
 * pushes, including a CRLF cut between its CR and its LF.
 */
export function createSseParser(): {
  push(text: string): SseFrame[];
  end(): SseFrame[];
} {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  /** The last push ended in CR: an LF at the start of the next is its pair. */
  let pendingCr = false;

  const line = (text: string, out: SseFrame[]) => {
    if (text === '') {
      if (data.length > 0)
        out.push({ event: event === '' ? 'message' : event, data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    // id and retry are not used by this API; unknown fields are ignored.
  };

  return {
    push(text) {
      if (pendingCr && text.startsWith('\n')) text = text.slice(1);
      pendingCr = false;
      buffer += text;
      const out: SseFrame[] = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const c = buffer[i];
        if (c !== '\n' && c !== '\r') continue;
        line(buffer.slice(start, i), out);
        if (c === '\r') {
          if (i + 1 === buffer.length) pendingCr = true;
          else if (buffer[i + 1] === '\n') i += 1;
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
    end() {
      // A frame without its closing blank line is not dispatched (the spec's rule).
      buffer = '';
      event = '';
      data = [];
      return [];
    },
  };
}

export class ChatStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatStreamError';
  }
}

/** A raw frame as a validated event; throws ChatStreamError on an unknown name or a bad body. */
export function parseChatEvent(frame: SseFrame): ChatStreamEvent {
  if (!Object.prototype.hasOwnProperty.call(chatStreamEventSchemas, frame.event)) {
    throw new ChatStreamError(`unknown chat stream event "${frame.event}"`);
  }
  const name = frame.event as ChatStreamEventName;
  let json: unknown;
  try {
    json = JSON.parse(frame.data);
  } catch {
    throw new ChatStreamError(`the ${name} event's data is not JSON`);
  }
  const parsed = chatStreamEventSchemas[name].safeParse(json);
  if (!parsed.success) {
    throw new ChatStreamError(
      `the ${name} event does not match contract v${String(CHAT_STREAM_VERSION)}: ${parsed.error.issues[0]?.message ?? ''}`,
    );
  }
  return { event: name, data: parsed.data } as ChatStreamEvent;
}

/** Every event of a response body, validated, in order. Browser and Node alike. */
export async function* readChatStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent> {
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        yield parseChatEvent(frame);
      }
    }
    for (const frame of parser.push(decoder.decode())) yield parseChatEvent(frame);
    parser.end();
  } finally {
    reader.releaseLock();
  }
}

/** A passage's opening for the `retrieval` event: SNIPPET_CHARS code points, cut at a word. */
export function snippetOf(text: string, max = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const points = Array.from(flat);
  if (points.length <= max) return flat;
  const cut = points.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A conversation's title from its first question: one line, at most 80 code points. */
export function titleFromQuestion(question: string, max = 80): string {
  return snippetOf(question, max);
}
