/**
 * The Ollama client. Every model call in this system goes through here.
 *
 * Build step 1 needs one operation: "is the server up, and are both models
 * pulled?", which `/health` and `scripts/dev.sh` ask. Streamed chat and batched
 * embeddings join it in build step 4 (docs/PLAN.md).
 *
 * The response is PARSED, not cast: a server that answers 200 with an HTML
 * error page (a proxy, a wrong port) must read as "unreachable", never as
 * "no models".
 */
import { normaliseModel, type ModelStatus } from '@rag/shared';
import { z } from 'zod';

const tagsSchema = z.object({
  models: z.array(z.object({ name: z.string(), model: z.string().optional() })),
});

export interface OllamaOptions {
  /** `OLLAMA_URL`, e.g. `http://localhost:11434`. A trailing slash is fine. */
  readonly baseUrl: string;
  /** How long a metadata call may take. Health probes cannot wait on a busy CPU. */
  readonly timeoutMs?: number;
  /** Injected in tests. */
  readonly fetch?: typeof fetch;
}

export class OllamaUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaUnreachable';
  }
}

export interface Ollama {
  /** Every pulled model, normalised (`name:tag`). Throws `OllamaUnreachable`. */
  listModels(): Promise<string[]>;
  /** Whether the chat and embedding models are both pulled. Throws `OllamaUnreachable`. */
  checkModels(models: { chat: string; embed: string }): Promise<ModelStatus>;
}

export function createOllama(options: OllamaOptions): Ollama {
  const base = options.baseUrl.replace(/\/+$/u, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;

  async function listModels(): Promise<string[]> {
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
      const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      const reason =
        typeof code === 'string' ? code : error instanceof Error ? error.name : 'Error';
      throw new OllamaUnreachable(`the model server did not answer (${reason})`);
    }
    const parsed = tagsSchema.safeParse(body);
    if (!parsed.success) {
      throw new OllamaUnreachable('GET /api/tags answered in a shape that is not Ollama’s');
    }
    return parsed.data.models.map((m) => normaliseModel(m.model ?? m.name));
  }

  async function checkModels(models: { chat: string; embed: string }): Promise<ModelStatus> {
    const pulled = new Set(await listModels());
    return {
      chat: { model: models.chat, present: pulled.has(normaliseModel(models.chat)) },
      embed: { model: models.embed, present: pulled.has(normaliseModel(models.embed)) },
    };
  }

  return { listModels, checkModels };
}

/** The models a status says are missing, by the names the operator configured. */
export function missingModels(status: ModelStatus): string[] {
  return [status.chat, status.embed].filter((m) => !m.present).map((m) => m.model);
}
