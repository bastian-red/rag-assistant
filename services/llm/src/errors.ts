/**
 * Every failure of a model call is one `LlmError` with a stable `code` from
 * the shared contract (`LLM_ERROR_CODES`), so the API maps codes to messages
 * and never parses one.
 *
 * A message never carries the server's address: `/health` repeats it in a
 * public body. Ollama's own error text ("model 'x' not found", "the input
 * length exceeds the context length") is safe and is kept, because it is the
 * part that says what to fix.
 */
import type { LlmErrorCode } from '@rag/shared';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}

/** No answer, or an answer that is not Ollama's. Kept as its own class for `/health`. */
export class OllamaUnreachable extends LlmError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('unreachable', message, options);
    this.name = 'OllamaUnreachable';
  }
}

/** A network failure, named by its code or class and never by its message. */
export function unreachable(error: unknown): OllamaUnreachable {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  const reason = typeof code === 'string' ? code : error instanceof Error ? error.name : 'Error';
  return new OllamaUnreachable(`the model server did not answer (${reason})`, { cause: error });
}

const MAX_SERVER_MESSAGE = 300;

/**
 * A non-2xx answer as an `LlmError`, from Ollama's `{"error": "..."}` body:
 * 404 is a model that is not pulled; 400 "does not support" and 501 (embed on
 * a chat model) are a model that cannot do this; any other 4xx is a refused
 * request; 5xx is a failure.
 */
export async function httpError(response: Response, what: string): Promise<LlmError> {
  const raw = await response.text().catch(() => '');
  let said: string | null = null;
  try {
    const body = JSON.parse(raw) as { error?: unknown };
    if (typeof body.error === 'string') said = body.error.slice(0, MAX_SERVER_MESSAGE);
  } catch {
    // Not JSON: a proxy page or a plain-text 404. Its status is all we trust.
  }
  const status = response.status;
  const detail = `${what} answered ${String(status)}${said === null ? '' : `: ${said}`}`;
  if (said === null && status === 404) {
    // A plain-text 404 is an unknown ROUTE: this is not an Ollama, or an old one.
    return new OllamaUnreachable(
      `${what} answered ${String(status)} in a shape that is not Ollama’s`,
    );
  }
  if (status === 404) return new LlmError('model_not_found', detail);
  if (status === 501 || (status === 400 && /does not support/iu.test(said ?? ''))) {
    return new LlmError('model_unsupported', detail);
  }
  if (status >= 400 && status < 500) return new LlmError('refused', detail);
  return new LlmError('failed', detail);
}

/** The caller stopped it: their signal's abort, as an `LlmError`. */
export function abortedBy(signal: AbortSignal): LlmError {
  const reason: unknown = signal.reason;
  if (reason instanceof LlmError) return reason;
  return new LlmError('aborted', 'the caller stopped the request', { cause: reason });
}
