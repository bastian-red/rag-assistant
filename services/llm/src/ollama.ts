/**
 * The Ollama client. Every model call in this system goes through here.
 *
 * Four operations over Ollama's HTTP API, each measured against the real
 * server (0.40.12) before the fake copied it:
 *
 * - `listModels` / `checkModels`: `/api/tags`, then `/api/show` for each
 *   pulled model, so "pulled" and "able to do its job" are separate answers.
 *   A thinking-only chat build reports `thinking: {values: [true]}`: it cannot
 *   turn reasoning off, and writes it into every answer.
 * - `chat`: streamed `/api/chat` NDJSON with `think: false`. Reasoning in the
 *   `thinking` field is dropped and counted; a `<think>` block in the content
 *   is stripped as a backup. Two clocks: the first visible token (a cold load
 *   of the 4B model took 65 s here) and the gap between tokens. Aborting the
 *   caller's signal, or leaving the loop early, closes the request, which is
 *   what stops generation on the server.
 * - `embed`: batched `/api/embed` with `truncate: false`, so an input over the
 *   context length is an error instead of a silently shortened vector. Every
 *   reply is checked: one vector per input, the configured dimensions, finite.
 *
 * Responses are PARSED, not cast: a server that answers 200 with an HTML page
 * (a proxy, a wrong port) must read as "unreachable", never as "no models".
 */
import {
  embeddingSpace,
  normaliseModel,
  type ChatEvent,
  type ChatMessage,
  type ChatOptions,
  type EmbedOptions,
  type ModelCheck,
  type ModelStatus,
} from '@rag/shared';
import { chatMessageSchema } from '@rag/shared';
import { z } from 'zod';

import { LlmError, OllamaUnreachable, abortedBy, httpError, unreachable } from './errors';
import { lines } from './ndjson';
import { ThinkStripper } from './think';

export { LlmError, OllamaUnreachable } from './errors';

const tagsSchema = z.object({
  models: z.array(
    z.object({ name: z.string(), model: z.string().optional(), digest: z.string().optional() }),
  ),
});

const showSchema = z.object({
  capabilities: z.array(z.string()).default([]),
  thinking: z.object({ values: z.array(z.boolean()) }).optional(),
});

const nanos = z.number().nonnegative().optional();
const chatLineSchema = z.union([
  z.object({ error: z.string() }),
  z.object({
    message: z
      .object({ content: z.string().default(''), thinking: z.string().optional() })
      .optional(),
    done: z.boolean(),
    done_reason: z.string().optional(),
    prompt_eval_count: z.number().int().nonnegative().optional(),
    eval_count: z.number().int().nonnegative().optional(),
    total_duration: nanos,
    load_duration: nanos,
    prompt_eval_duration: nanos,
    eval_duration: nanos,
  }),
]);

const embedSchema = z.object({ embeddings: z.array(z.array(z.number())) });

export interface OllamaOptions {
  /** `OLLAMA_URL`, e.g. `http://localhost:11434`. A trailing slash is fine. */
  readonly baseUrl: string;
  /** How long a metadata call may take. Health probes cannot wait on a busy CPU. */
  readonly timeoutMs?: number;
  /** Injected in tests. */
  readonly fetch?: typeof fetch;
  readonly chat?: {
    /** Until the first visible token. Covers a cold model load. Default 180 s. */
    readonly firstTokenTimeoutMs?: number;
    /** Between visible tokens once the answer started. Default 30 s. */
    readonly idleTimeoutMs?: number;
    /** The context window asked for (`num_ctx`). Default 8192: 6 sources of ~400 tokens fit. */
    readonly contextTokens?: number;
  };
  readonly embed?: {
    /** Inputs per `/api/embed` call. Default 32. */
    readonly batchSize?: number;
    /** Per call. Default 120 s. */
    readonly timeoutMs?: number;
    /** What every vector must have. Default 1024, the `chunks.embedding` column. */
    readonly dimensions?: number;
  };
}

export interface Ollama {
  /** Every pulled model, normalised (`name:tag`). Throws `OllamaUnreachable`. */
  listModels(): Promise<string[]>;
  /** Pulled, and able to do its job, for both models. Throws `OllamaUnreachable`. */
  checkModels(models: { chat: string; embed: string }): Promise<ModelStatus>;
  /** One model only: the ingest worker never needs the chat model to be pulled. */
  checkModel(role: 'chat' | 'embed', model: string): Promise<ModelCheck>;
  chat(
    model: string,
    messages: readonly ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatEvent>;
  embed(model: string, texts: readonly string[], options?: EmbedOptions): Promise<number[][]>;
  /**
   * The vector space this server's `model` embeds into (`embeddingSpace` in
   * @rag/shared), from its `/api/tags` digest. `model_not_found` when not
   * pulled; `protocol` when the server gives no digest.
   */
  embeddingSpace(model: string): Promise<string>;
}

/** Why a pulled model cannot do its job, from `/api/show`; null when it can. */
export function modelProblem(
  role: 'chat' | 'embed',
  show: { capabilities: readonly string[]; thinking?: { values: readonly boolean[] } },
): string | null {
  if (role === 'embed') {
    return show.capabilities.includes('embedding') ? null : 'not an embedding model';
  }
  if (!show.capabilities.includes('completion')) return 'not a chat model';
  if (show.thinking !== undefined && !show.thinking.values.includes(false)) {
    return 'a thinking-only build: it writes its reasoning into every answer (use an instruct build, such as qwen3:4b-instruct)';
  }
  return null;
}

const ms = (ns: number | undefined) => Math.round((ns ?? 0) / 1e6);

export function createOllama(options: OllamaOptions): Ollama {
  const base = options.baseUrl.replace(/\/+$/u, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const firstTokenTimeoutMs = options.chat?.firstTokenTimeoutMs ?? 180_000;
  const idleTimeoutMs = options.chat?.idleTimeoutMs ?? 30_000;
  const contextTokens = options.chat?.contextTokens ?? 8192;
  const batchSize = options.embed?.batchSize ?? 32;
  const embedTimeoutMs = options.embed?.timeoutMs ?? 120_000;
  const dimensions = options.embed?.dimensions ?? 1024;

  /** A JSON POST, with network failures as `OllamaUnreachable` and aborts as the signal's reason. */
  async function post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw abortedBy(signal);
      throw unreachable(error);
    }
  }

  async function tags(): Promise<{ model: string; digest: string | undefined }[]> {
    let body: unknown;
    try {
      const response = await doFetch(`${base}/api/tags`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new OllamaUnreachable(`GET /api/tags answered ${response.status}`);
      body = await response.json();
    } catch (error) {
      if (error instanceof OllamaUnreachable) throw error;
      // The error CLASS or code, never the message: it carries the host and
      // port, and the health body that repeats it is public.
      throw unreachable(error);
    }
    const parsed = tagsSchema.safeParse(body);
    if (!parsed.success) {
      throw new OllamaUnreachable('GET /api/tags answered in a shape that is not Ollama’s');
    }
    return parsed.data.models.map((m) => ({
      model: normaliseModel(m.model ?? m.name),
      digest: m.digest,
    }));
  }

  async function listModels(): Promise<string[]> {
    return (await tags()).map((m) => m.model);
  }

  async function space(model: string): Promise<string> {
    const wanted = normaliseModel(model);
    const entry = (await tags()).find((m) => m.model === wanted);
    if (entry === undefined) {
      throw new LlmError('model_not_found', `model '${model}' is not pulled`);
    }
    try {
      return embeddingSpace(model, entry.digest ?? '');
    } catch {
      throw new LlmError('protocol', `GET /api/tags gave '${model}' no usable digest`);
    }
  }

  async function check(
    role: 'chat' | 'embed',
    model: string,
    pulled: Set<string>,
  ): Promise<ModelCheck> {
    if (!pulled.has(normaliseModel(model))) return { model, present: false, problem: null };
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await post('/api/show', { model }, signal).catch((error: unknown) => {
      throw error instanceof LlmError && error.code === 'aborted'
        ? new OllamaUnreachable('the model server did not answer (TimeoutError)')
        : error;
    });
    // Removed between the two calls: not pulled after all.
    if (response.status === 404) return { model, present: false, problem: null };
    if (!response.ok) throw new OllamaUnreachable(`POST /api/show answered ${response.status}`);
    const parsed = showSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new OllamaUnreachable('POST /api/show answered in a shape that is not Ollama’s');
    }
    return { model, present: true, problem: modelProblem(role, parsed.data) };
  }

  async function checkModels(models: { chat: string; embed: string }): Promise<ModelStatus> {
    const pulled = new Set(await listModels());
    const [chat, embed] = await Promise.all([
      check('chat', models.chat, pulled),
      check('embed', models.embed, pulled),
    ]);
    return { chat, embed };
  }

  async function* chat(
    model: string,
    messages: readonly ChatMessage[],
    chatOptions: ChatOptions = {},
  ): AsyncGenerator<ChatEvent> {
    const parsedMessages = z.array(chatMessageSchema).min(1).safeParse(messages);
    if (!parsedMessages.success) {
      throw new LlmError(
        'refused',
        'chat needs at least one message of role system, user or assistant',
      );
    }
    const caller = chatOptions.signal;
    if (caller?.aborted) throw abortedBy(caller);

    const controller = new AbortController();
    const onAbort = () => controller.abort(abortedBy(caller!));
    caller?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (limit: number, what: string) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new LlmError('timeout', `${what} within ${String(limit)} ms`)),
        limit,
      );
    };
    const started = performance.now();
    arm(firstTokenTimeoutMs, 'no first token');

    try {
      const response = await post(
        '/api/chat',
        {
          model,
          messages: parsedMessages.data,
          stream: true,
          think: false,
          options: {
            num_ctx: contextTokens,
            ...(chatOptions.maxTokens === undefined ? {} : { num_predict: chatOptions.maxTokens }),
            ...(chatOptions.temperature === undefined
              ? {}
              : { temperature: chatOptions.temperature }),
          },
        },
        controller.signal,
      );
      if (!response.ok) throw await httpError(response, 'POST /api/chat');
      if (response.body === null) throw new LlmError('protocol', 'POST /api/chat had no body');

      const strip = new ThinkStripper();
      let thinking = 0;
      let leading = true;
      let firstTokenMs: number | null = null;
      try {
        for await (const line of lines(response.body)) {
          // One network read can hold many lines: an abort during a `yield`
          // must not let the lines already read through.
          if (controller.signal.aborted) throw abortedBy(controller.signal);
          let json: unknown;
          try {
            json = JSON.parse(line);
          } catch {
            throw new LlmError('protocol', 'POST /api/chat streamed a line that is not JSON');
          }
          const parsed = chatLineSchema.safeParse(json);
          if (!parsed.success) {
            throw new LlmError(
              'protocol',
              'POST /api/chat streamed a line in a shape that is not Ollama’s',
            );
          }
          const chunk = parsed.data;
          if ('error' in chunk) {
            throw new LlmError(
              'failed',
              `the model failed mid-answer: ${chunk.error.slice(0, 300)}`,
            );
          }
          thinking += Array.from(chunk.message?.thinking ?? '').length;
          let text = strip.push(chunk.message?.content ?? '');
          if (chunk.done) text += strip.end();
          // What follows a stripped block is usually a blank line: the answer
          // starts at its first visible character.
          if (leading) {
            text = text.replace(/^\s+/u, '');
            if (text !== '') leading = false;
          }
          if (text !== '') {
            firstTokenMs ??= Math.round(performance.now() - started);
            // The consumer's own time (writing to a socket) is not the model's silence.
            clearTimeout(timer);
            yield { type: 'token', text };
            arm(idleTimeoutMs, 'no next token');
          }
          if (chunk.done) {
            clearTimeout(timer);
            yield {
              type: 'done',
              usage: {
                promptTokens: chunk.prompt_eval_count ?? 0,
                outputTokens: chunk.eval_count ?? 0,
                stopReason: chunk.done_reason ?? 'stop',
                thinkingDropped: thinking + strip.dropped,
                firstTokenMs,
                totalMs: Math.round(performance.now() - started),
                loadMs: ms(chunk.load_duration),
                promptMs: ms(chunk.prompt_eval_duration),
                outputMs: ms(chunk.eval_duration),
              },
            };
            return;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) throw abortedBy(controller.signal);
        if (error instanceof LlmError) throw error;
        throw new LlmError('failed', 'the answer stream broke off', { cause: error });
      }
      throw new LlmError('protocol', 'POST /api/chat ended before the model said it was done');
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onAbort);
      // Leaving early (a `break`, an error, a timeout) closes the request in
      // `lines`, which cancels the body: that is what stops the server
      // generating into nothing.
    }
  }

  async function embedBatch(
    model: string,
    input: readonly string[],
    caller: AbortSignal | undefined,
  ): Promise<number[][]> {
    const signal = caller
      ? AbortSignal.any([caller, AbortSignal.timeout(embedTimeoutMs)])
      : AbortSignal.timeout(embedTimeoutMs);
    let response: Response;
    try {
      response = await post('/api/embed', { model, input, truncate: false }, signal);
    } catch (error) {
      if (caller?.aborted) throw abortedBy(caller);
      if (signal.aborted)
        throw new LlmError('timeout', `no embeddings within ${String(embedTimeoutMs)} ms`);
      throw error;
    }
    if (!response.ok) throw await httpError(response, 'POST /api/embed');
    const parsed = embedSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new LlmError('protocol', 'POST /api/embed answered in a shape that is not Ollama’s');
    }
    const vectors = parsed.data.embeddings;
    if (vectors.length !== input.length) {
      throw new LlmError(
        'protocol',
        `POST /api/embed returned ${String(vectors.length)} vectors for ${String(input.length)} inputs`,
      );
    }
    for (const vector of vectors) {
      if (vector.length !== dimensions) {
        throw new LlmError(
          'protocol',
          `POST /api/embed returned ${String(vector.length)} dimensions, expected ${String(dimensions)} (EMBED_MODEL changed?)`,
        );
      }
      if (!vector.every(Number.isFinite)) {
        throw new LlmError('protocol', 'POST /api/embed returned a vector with a non-finite value');
      }
    }
    return vectors;
  }

  async function embed(
    model: string,
    texts: readonly string[],
    embedOptions: EmbedOptions = {},
  ): Promise<number[][]> {
    if (!Array.isArray(texts) || !texts.every((t) => typeof t === 'string')) {
      throw new LlmError('refused', 'embed takes an array of strings');
    }
    if (embedOptions.signal?.aborted) throw abortedBy(embedOptions.signal);
    const out: number[][] = [];
    // One batch at a time: the caller caps concurrency, so chat stays responsive.
    for (let at = 0; at < texts.length; at += batchSize) {
      out.push(...(await embedBatch(model, texts.slice(at, at + batchSize), embedOptions.signal)));
    }
    return out;
  }

  async function checkModel(role: 'chat' | 'embed', model: string): Promise<ModelCheck> {
    return check(role, model, new Set(await listModels()));
  }

  return { listModels, checkModels, checkModel, chat, embed, embeddingSpace: space };
}

/** The models a status says are missing, by the names the operator configured. */
export function missingModels(status: ModelStatus): string[] {
  return [status.chat, status.embed].filter((m) => !m.present).map((m) => m.model);
}

/** Pulled models that cannot do their job, as `name: reason`. */
export function modelProblems(status: ModelStatus): string[] {
  return [status.chat, status.embed]
    .filter((m) => m.present && m.problem !== null)
    .map((m) => `${m.model}: ${m.problem ?? ''}`);
}
