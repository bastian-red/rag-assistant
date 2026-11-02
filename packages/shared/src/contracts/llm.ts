import { z } from 'zod';

/**
 * The contract between every service and `services/llm`, the only process
 * code that talks to the model server.
 *
 * Model names are Ollama references (`qwen3:4b-instruct`). A reference with no tag
 * means `:latest`, exactly as Ollama resolves it, so `normaliseModel` is the
 * one place that rule lives.
 */

export const modelRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._-]+)?$/iu, 'must be an Ollama model reference');

/**
 * One configured model. `present` says it is pulled; `problem` says why a
 * pulled model still cannot do its job (a thinking-only chat build, an
 * embedding model configured as the chat model), or null when it can.
 */
export const modelCheckSchema = z.object({
  model: modelRefSchema,
  present: z.boolean(),
  problem: z.string().nullable(),
});

/** What the model server reports about the two models this system needs. */
export const modelStatusSchema = z.object({
  chat: modelCheckSchema,
  embed: modelCheckSchema,
});

export type ModelCheck = z.infer<typeof modelCheckSchema>;
export type ModelStatus = z.infer<typeof modelStatusSchema>;

// --- chat and embeddings: the `services/llm` contract (SPECS section 3) -----

export const CHAT_ROLES = ['system', 'user', 'assistant'] as const;

export const chatMessageSchema = z
  .object({ role: z.enum(CHAT_ROLES), content: z.string() })
  .strict();

export type ChatMessage = z.infer<typeof chatMessageSchema>;

const ms = z.number().int().nonnegative();

/**
 * What a finished generation cost. Token counts are the model server's own;
 * `firstTokenMs` and `totalMs` are measured by the client, from the request to
 * the first VISIBLE token and to the end, so a cold model load is in them.
 */
export const chatUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /** Ollama's `done_reason`: `stop` (finished), `length` (hit maxTokens). */
    stopReason: z.string().min(1),
    /** Characters of reasoning removed before the reader saw them (0 for an instruct build). */
    thinkingDropped: z.number().int().nonnegative(),
    firstTokenMs: ms.nullable(),
    totalMs: ms,
    loadMs: ms,
    promptMs: ms,
    outputMs: ms,
  })
  .strict();

export type ChatUsage = z.infer<typeof chatUsageSchema>;

/**
 * `chat()` yields visible text in order, then exactly one `done`. A token is a
 * piece of text as the model server sent it, not one tokenizer token: a marker
 * like `[S12]` can arrive split over several, which is why citations are
 * parsed with `createMarkerStream`.
 */
export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string().min(1) }).strict(),
  z.object({ type: z.literal('done'), usage: chatUsageSchema }).strict(),
]);

export type ChatEvent = z.infer<typeof chatEventSchema>;

/**
 * Why a model call failed, as a stable code the API maps to a message:
 *
 * - `unreachable`: no answer, or an answer that is not Ollama's
 * - `model_not_found`: the model is not pulled
 * - `model_unsupported`: the model cannot do this (chat on an embedding model)
 * - `refused`: the server rejected the request (an input over the context length)
 * - `failed`: the server failed mid-generation or answered 5xx
 * - `protocol`: a reply in a shape the contract does not allow
 * - `timeout`: no first token, or no next token, within the limit
 * - `aborted`: the caller's signal stopped it
 */
export const LLM_ERROR_CODES = [
  'unreachable',
  'model_not_found',
  'model_unsupported',
  'refused',
  'failed',
  'protocol',
  'timeout',
  'aborted',
] as const;

export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number];

export interface ChatOptions {
  /** Aborting it stops the generation on the model server, not just the read. */
  readonly signal?: AbortSignal;
  /** Upper bound on generated tokens (Ollama `num_predict`). */
  readonly maxTokens?: number;
  /** 0 for the eval lane's repeatable runs. */
  readonly temperature?: number;
}

export interface EmbedOptions {
  readonly signal?: AbortSignal;
}

/**
 * The contract every other service codes against. `services/llm` implements it
 * over Ollama (`createLlm`); the same contract suite runs against the real
 * server and the fake.
 */
export interface LlmClient {
  chat(messages: readonly ChatMessage[], options?: ChatOptions): AsyncIterable<ChatEvent>;
  /** One vector per text, in order. `[]` for `[]`, with no call made. */
  embed(texts: readonly string[], options?: EmbedOptions): Promise<number[][]>;
  /** The configured chat and embedding models: pulled, and able to do their job. */
  models(): Promise<ModelStatus>;
}

/** `qwen3` -> `qwen3:latest`; `qwen3:4b` unchanged. Case-insensitive, like Ollama. */
export function normaliseModel(ref: string): string {
  const trimmed = ref.trim().toLowerCase();
  // A registry path can contain ':' only in a port (`host:5000/ns/model`), and
  // the tag always follows the last '/'.
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return name.includes(':') ? trimmed : `${trimmed}:latest`;
}
