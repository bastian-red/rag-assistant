/**
 * How a failed ingestion is sorted. Two kinds, and the difference decides
 * whether the job is tried again:
 *
 * - `IngestRefusal`: the file itself is the problem (no text layer, not
 *   UTF-8, damaged). Trying again gives the same answer, so the document goes
 *   FAILED at once with the sentence from `INGEST_FAILURES`, and the job is
 *   not retried.
 * - Anything else (the model server down, a timeout, Postgres restarting) is
 *   transient: the job is retried with backoff, and only the last attempt
 *   marks the document FAILED.
 */
import { INGEST_FAILURES } from '@rag/shared';
import { LlmError } from '@rag/llm';

export type IngestFailure = (typeof INGEST_FAILURES)[keyof typeof INGEST_FAILURES];

export class IngestRefusal extends Error {
  constructor(readonly reason: IngestFailure) {
    super(reason);
    this.name = 'IngestRefusal';
  }
}

/**
 * Ollama's 400 for an input over the model's context with `truncate: false`.
 * Matched on the words because the status alone (400) is also what a
 * malformed request gets, and that one is a bug, not the document's fault.
 */
const CONTEXT_LENGTH = /input length exceeds the context length/iu;

/** A thrown error as a refusal (permanent), or null for one worth retrying. */
export function refusalOf(error: unknown): IngestRefusal | null {
  if (error instanceof IngestRefusal) return error;
  if (error instanceof LlmError && error.code === 'refused' && CONTEXT_LENGTH.test(error.message))
    return new IngestRefusal(INGEST_FAILURES.tooLong);
  return null;
}

/**
 * The sentence a document is left with when its last attempt fails for a
 * transient reason: the model server's, when the model was the trouble.
 */
export function finalReason(error: unknown): IngestFailure {
  const refusal = refusalOf(error);
  if (refusal !== null) return refusal.reason;
  return error instanceof LlmError ? INGEST_FAILURES.modelUnavailable : INGEST_FAILURES.gaveUp;
}
