/**
 * An Ollama-compatible fake, for every lane that must run with no model:
 * integration, E2E, dev-smoke and CI.
 *
 * It speaks the HTTP shapes the real server does (measured against 0.40.12;
 * the contract suite runs the same assertions against both), so the client is
 * exercised unchanged and nothing in the app knows it is talking to a fake:
 *
 * - `GET /api/version`, `GET /api/tags`
 * - `POST /api/show`: capabilities by name (`embed` in the name is an embedding
 *   model, anything else a chat model), and `thinking: {values: [true]}` for
 *   the names in `thinkingOnly`, as a thinking-only build reports
 * - `POST /api/embed`: `hashEmbedding` vectors (deterministic, L2-normalised)
 * - `POST /api/chat`: `scriptedAnswer` (the first sentence of each given
 *   source with its marker), streamed as NDJSON in `streamPieces`, then a
 *   `done` line with counts; `stream: false` answers in one object
 *
 * Errors as Ollama words them: 404 `model 'x' not found`, 400 `"x" does not
 * support chat`, 501 for embeddings from a chat model, 400 for a body that is
 * not JSON or has no model, and a plain-text 404 for an unknown route.
 *
 * Every chat is recorded with whether the client went away before the end
 * (`aborted`), which is how the stop guarantee (SPECS outcome 5) is observed.
 *
 * Control routes, for specs that cannot reach into this process (the real
 * Ollama has none of them, and nothing in the app calls them):
 *
 * - `PUT /__fake/models` `{models, thinkingOnly?}`: what is pulled
 * - `PUT /__fake/chat` (a partial `FakeChatScript`), `DELETE /__fake/chat`: how it answers
 * - `PUT /__fake/embed` (a partial `FakeEmbedScript`), `DELETE /__fake/embed`: how embeddings
 *   answer (a delay per call so a test can kill a worker mid-embed, injected failures, Ollama's
 *   context-length refusal)
 * - `GET /__fake/log`: requests, chats and embeds; `DELETE /__fake/log` clears it
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { chatMessageSchema, normaliseModel, type ChatMessage } from '@rag/shared';
import { z } from 'zod';

import { resolveCites, scriptedAnswer, streamPieces } from './answer';
import { hashEmbedding } from './embedding';

/**
 * The fake's digest for a model: 64 hex digits like a real one, derived from
 * the name with a `fake:` prefix, so it is stable across runs and can never
 * equal the real model's. The fake answers to the real model's NAME; its
 * vectors are hashes, a different space, and the digest is what says so.
 */
export function fakeDigest(model: string): string {
  return createHash('sha256')
    .update(`fake:${normaliseModel(model)}`)
    .digest('hex');
}

/** How the fake answers. Every field has a default; a script overrides some. */
export interface FakeChatScript {
  /**
   * The whole answer; null derives it from the sources in the prompt. `[S:text]`
   * cites the source holding `text` (`resolveCites`).
   */
  readonly answer: string | null;
  /**
   * Reasoning to emit before the answer: in the `thinking` field when the
   * request allows thinking, else inside `<think>…</think>` in the content,
   * the way a template that tags its reasoning leaks it.
   */
  readonly thinking: string;
  /** Between pieces. */
  readonly tokenDelayMs: number;
  /** Before the first piece (a cold model load). */
  readonly firstTokenDelayMs: number;
  /** Send this many pieces, then go silent with the connection open. */
  readonly stallAfter: number | null;
  /** Send this many pieces, then an `{"error"}` line, as a crashed runner does. */
  readonly failAfter: number | null;
}

const DEFAULT_SCRIPT: FakeChatScript = {
  answer: null,
  thinking: '',
  tokenDelayMs: 0,
  firstTokenDelayMs: 0,
  stallAfter: null,
  failAfter: null,
};

/**
 * How `/api/embed` behaves. Every field is a test's lever on the ingest worker:
 * `delayMs` holds each call open long enough to kill the worker mid-embed,
 * `failNext` answers the next N calls 500 (a transient fault the worker must
 * retry), and `maxInputChars` refuses an input over it with Ollama's own 400
 * for `truncate: false` (a permanent fault it must not retry).
 */
export interface FakeEmbedScript {
  readonly delayMs: number;
  readonly failNext: number;
  readonly maxInputChars: number | null;
}

const DEFAULT_EMBED: FakeEmbedScript = { delayMs: 0, failNext: 0, maxInputChars: null };

/** Ollama's words when an input is over the context and `truncate` is false. */
export const CONTEXT_LENGTH_REFUSAL = 'the input length exceeds the context length';

const embedScriptSchema = z
  .object({
    delayMs: z.number().int().min(0).max(600_000),
    failNext: z.number().int().min(0).max(1000),
    maxInputChars: z.number().int().positive().nullable(),
  })
  .strict()
  .partial();

const scriptSchema = z
  .object({
    answer: z.string().nullable(),
    thinking: z.string(),
    tokenDelayMs: z.number().int().min(0).max(60_000),
    firstTokenDelayMs: z.number().int().min(0).max(600_000),
    stallAfter: z.number().int().min(0).nullable(),
    failAfter: z.number().int().min(0).nullable(),
  })
  .strict()
  .partial();

const modelsSchema = z
  .object({ models: z.array(z.string()), thinkingOnly: z.array(z.string()).optional() })
  .strict();

const chatBodySchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema),
  stream: z.boolean().optional(),
  think: z.boolean().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const embedBodySchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string())]),
  truncate: z.boolean().optional(),
});

export interface FakeChatRecord {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly think: boolean | undefined;
  readonly options: Readonly<Record<string, unknown>>;
  /** Content pieces written before the end or the abort. */
  piecesSent: number;
  /** The client closed the connection before the last line. */
  aborted: boolean;
  /** The `done` line was written. */
  completed: boolean;
}

export interface FakeEmbedRecord {
  readonly model: string;
  readonly inputs: number;
}

export interface FakeOllamaOptions {
  /** 0 picks a free port. */
  readonly port?: number;
  readonly host?: string;
  /** What `/api/tags` lists, as Ollama would name them. */
  readonly models: readonly string[];
  /** Pulled models that report themselves thinking-only. */
  readonly thinkingOnly?: readonly string[];
  /** Embedding dimensions. Default 1024. */
  readonly dimensions?: number;
  readonly script?: Partial<FakeChatScript>;
  readonly embed?: Partial<FakeEmbedScript>;
}

export interface FakeOllama {
  readonly url: string;
  readonly requests: readonly { method: string; path: string }[];
  readonly chats: readonly FakeChatRecord[];
  readonly embeds: readonly FakeEmbedRecord[];
  /** The in-process form of `PUT /__fake/models`. */
  setModels(models: readonly string[], thinkingOnly?: readonly string[]): void;
  /** The in-process form of `PUT /__fake/embed`; `null` resets to the defaults. */
  setEmbed(next: Partial<FakeEmbedScript> | null): void;
  /** The in-process form of `PUT /__fake/chat`; `null` resets to the defaults. */
  setScript(script: Partial<FakeChatScript> | null): void;
  close(): Promise<void>;
}

const VERSION = '0.0.0-fake';
const isEmbeddingModel = (name: string) => /embed/iu.test(name);
const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export async function startFakeOllama(options: FakeOllamaOptions): Promise<FakeOllama> {
  const requests: { method: string; path: string }[] = [];
  const chats: FakeChatRecord[] = [];
  const embeds: FakeEmbedRecord[] = [];
  const dimensions = options.dimensions ?? 1024;
  let models: readonly string[] = [...options.models];
  let thinkingOnly = new Set((options.thinkingOnly ?? []).map(normaliseModel));
  let script: FakeChatScript = { ...DEFAULT_SCRIPT, ...options.script };
  let embedScript: FakeEmbedScript = { ...DEFAULT_EMBED, ...options.embed };
  const setEmbed = (next: Partial<FakeEmbedScript> | null) => {
    embedScript =
      next === null ? { ...DEFAULT_EMBED, ...options.embed } : { ...embedScript, ...next };
  };
  const open = new Set<ServerResponse>();

  const pulled = (model: string) => models.some((m) => normaliseModel(m) === normaliseModel(model));
  const setModels = (next: readonly string[], thinking: readonly string[] = []) => {
    models = [...next];
    thinkingOnly = new Set(thinking.map(normaliseModel));
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://fake').pathname;
    const method = request.method ?? 'GET';
    requests.push({ method, path });
    open.add(response);
    response.on('close', () => open.delete(response));

    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const error = (status: number, message: string) => json(status, { error: message });

    /** The body as JSON, or a 400 in Ollama's words and `undefined`. */
    const readJson = async (): Promise<unknown> => {
      let raw = '';
      for await (const chunk of request) raw += (chunk as Buffer).toString('utf8');
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        error(400, 'invalid character in request body: not JSON');
        return undefined;
      }
    };

    const route = async () => {
      if (method === 'GET' && path === '/api/version') return json(200, { version: VERSION });
      if (method === 'GET' && path === '/api/tags') {
        return json(200, {
          models: models.map((name) => ({ name, model: name, size: 0, digest: fakeDigest(name) })),
        });
      }
      if (method === 'POST' && path === '/api/show') {
        const body = await readJson();
        if (body === undefined) return;
        const model = (body as { model?: unknown } | null)?.model;
        if (typeof model !== 'string' || model === '') return error(400, 'model is required');
        if (!pulled(model)) return error(404, `model '${model}' not found`);
        const embedding = isEmbeddingModel(model);
        return json(200, {
          capabilities: embedding ? ['embedding'] : ['completion', 'tools', 'thinking'],
          details: {
            format: 'gguf',
            family: 'fake',
            parameter_size: '0',
            quantization_level: 'none',
          },
          ...(thinkingOnly.has(normaliseModel(model))
            ? { thinking: { values: [true], default: true } }
            : {}),
        });
      }
      if (method === 'POST' && path === '/api/embed') {
        const raw = await readJson();
        if (raw === undefined) return;
        const body = embedBodySchema.safeParse(raw);
        if (!body.success)
          return error(400, 'model is required, and input is a string or a list of strings');
        const { model } = body.data;
        if (!pulled(model)) return error(404, `model '${model}' not found`);
        if (!isEmbeddingModel(model)) {
          return error(
            501,
            'This server does not support embeddings. Start it with `--embeddings`',
          );
        }
        const input = typeof body.data.input === 'string' ? [body.data.input] : body.data.input;
        const plan = embedScript;
        await sleep(plan.delayMs);
        if (plan.failNext > 0) {
          embedScript = { ...embedScript, failNext: embedScript.failNext - 1 };
          return error(500, 'fake: injected embedding failure');
        }
        const limit = plan.maxInputChars;
        if (body.data.truncate === false && limit !== null && input.some((t) => t.length > limit)) {
          return error(400, CONTEXT_LENGTH_REFUSAL);
        }
        embeds.push({ model, inputs: input.length });
        return json(200, {
          model,
          embeddings: input.map((text) => hashEmbedding(text, dimensions)),
          total_duration: 0,
          load_duration: 0,
          prompt_eval_count: input.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
        });
      }
      if (method === 'POST' && path === '/api/chat') return chat(response, await readJson());
      if (method === 'PUT' && path === '/__fake/models') {
        const body = modelsSchema.safeParse(await readJsonQuiet(request));
        if (!body.success) return error(400, 'models must be an array of strings');
        setModels(body.data.models, body.data.thinkingOnly);
        return json(200, { models, thinkingOnly: [...thinkingOnly] });
      }
      if (method === 'PUT' && path === '/__fake/chat') {
        const body = scriptSchema.safeParse(await readJsonQuiet(request));
        if (!body.success)
          return error(400, `not a chat script: ${body.error.issues[0]?.message ?? ''}`);
        script = { ...script, ...body.data };
        return json(200, script);
      }
      if (method === 'DELETE' && path === '/__fake/chat') {
        script = { ...DEFAULT_SCRIPT, ...options.script };
        return json(200, script);
      }
      if (method === 'PUT' && path === '/__fake/embed') {
        const body = embedScriptSchema.safeParse(await readJsonQuiet(request));
        if (!body.success)
          return error(400, `not an embed script: ${body.error.issues[0]?.message ?? ''}`);
        setEmbed(body.data);
        return json(200, embedScript);
      }
      if (method === 'DELETE' && path === '/__fake/embed') {
        setEmbed(null);
        return json(200, embedScript);
      }
      if (method === 'GET' && path === '/__fake/log') return json(200, { requests, chats, embeds });
      if (method === 'DELETE' && path === '/__fake/log') {
        requests.length = 0;
        chats.length = 0;
        embeds.length = 0;
        return json(200, {});
      }
      // Ollama answers an unknown route with a plain-text 404.
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('404 page not found');
    };

    route().catch(() => {
      if (!response.headersSent) error(500, 'fake: internal error');
      else response.destroy();
    });
  });

  async function chat(response: ServerResponse, raw: unknown) {
    if (raw === undefined) return; // readJson already answered 400
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const body = chatBodySchema.safeParse(raw);
    if (!body.success)
      return send(400, { error: 'model is required, and messages is a list of {role, content}' });
    const { model, messages, think } = body.data;
    if (!pulled(model)) return send(404, { error: `model '${model}' not found` });
    if (isEmbeddingModel(model)) return send(400, { error: `"${model}" does not support chat` });

    const plan = script; // a script change mid-stream does not change this answer
    const answer =
      plan.answer === null ? scriptedAnswer(messages) : resolveCites(plan.answer, messages);
    const record: FakeChatRecord = {
      model,
      messages,
      think,
      options: body.data.options ?? {},
      piecesSent: 0,
      aborted: false,
      completed: false,
    };
    chats.push(record);
    let finished = false;
    response.on('close', () => {
      if (!finished) record.aborted = true;
    });

    const thinkingInField = plan.thinking !== '' && think !== false;
    const content =
      plan.thinking !== '' && !thinkingInField
        ? `<think>${plan.thinking}</think>\n\n${answer}`
        : answer;
    const pieces = streamPieces(content);
    const promptTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    const line = (fields: Record<string, unknown>) =>
      `${JSON.stringify({ model, created_at: new Date().toISOString(), ...fields })}\n`;
    const doneFields = {
      done: true,
      done_reason: 'stop',
      total_duration: 1_000_000,
      load_duration: 0,
      prompt_eval_count: promptTokens,
      prompt_eval_cached_count: 0,
      prompt_eval_duration: 500_000,
      eval_count: pieces.length,
      eval_duration: 500_000,
    };

    if (body.data.stream === false) {
      finished = true;
      record.completed = true;
      return send(200, {
        model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: thinkingInField ? answer : content,
          ...(thinkingInField ? { thinking: plan.thinking } : {}),
        },
        ...doneFields,
      });
    }

    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const write = (text: string) => !record.aborted && response.write(text);
    await sleep(plan.firstTokenDelayMs);
    if (thinkingInField) {
      for (const piece of streamPieces(plan.thinking)) {
        if (record.aborted) return;
        write(line({ message: { role: 'assistant', content: '', thinking: piece }, done: false }));
        await sleep(plan.tokenDelayMs);
      }
    }
    for (const [index, piece] of pieces.entries()) {
      if (record.aborted) return;
      if (plan.stallAfter !== null && index >= plan.stallAfter) return; // silent, still open
      if (plan.failAfter !== null && index >= plan.failAfter) {
        finished = true;
        write(`${JSON.stringify({ error: 'fake: the model runner stopped' })}\n`);
        response.end();
        return;
      }
      write(line({ message: { role: 'assistant', content: piece }, done: false }));
      record.piecesSent += 1;
      await sleep(index === pieces.length - 1 ? 0 : plan.tokenDelayMs);
    }
    if (record.aborted) return;
    finished = true;
    record.completed = true;
    response.end(line({ message: { role: 'assistant', content: '' }, ...doneFields }));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${address.address}:${String(address.port)}`,
    requests,
    chats,
    embeds,
    setModels,
    setEmbed,
    setScript: (next) => {
      script = next === null ? { ...DEFAULT_SCRIPT, ...options.script } : { ...script, ...next };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A stalled stream would hold `close` open forever, and an idle
        // keep-alive socket holds it for seconds.
        for (const response of open) response.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** A control route's body: JSON or null, never a 400 of its own. */
async function readJsonQuiet(request: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) raw += (chunk as Buffer).toString('utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
