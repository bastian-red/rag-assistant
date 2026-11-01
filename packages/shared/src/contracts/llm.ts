import { z } from 'zod';

/**
 * The contract between every service and `services/llm`, the only process
 * code that talks to the model server.
 *
 * Model names are Ollama references (`qwen3:4b`). A reference with no tag
 * means `:latest`, exactly as Ollama resolves it, so `normaliseModel` is the
 * one place that rule lives.
 */

export const modelRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._-]+)?$/iu, 'must be an Ollama model reference');

/** What the model server reports about the two models this system needs. */
export const modelStatusSchema = z.object({
  chat: z.object({ model: modelRefSchema, present: z.boolean() }),
  embed: z.object({ model: modelRefSchema, present: z.boolean() }),
});

export type ModelStatus = z.infer<typeof modelStatusSchema>;

/** `qwen3` -> `qwen3:latest`; `qwen3:4b` unchanged. Case-insensitive, like Ollama. */
export function normaliseModel(ref: string): string {
  const trimmed = ref.trim().toLowerCase();
  // A registry path can contain ':' only in a port (`host:5000/ns/model`), and
  // the tag always follows the last '/'.
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return name.includes(':') ? trimmed : `${trimmed}:latest`;
}
