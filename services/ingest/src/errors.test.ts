import { CONTEXT_LENGTH_REFUSAL, LlmError } from '@rag/llm';
import { INGEST_FAILURES } from '@rag/shared';
import { describe, expect, it } from 'vitest';

import { finalReason, IngestRefusal, refusalOf } from './errors';

describe('sorting failures', () => {
  it('treats the file’s own problems as permanent', () => {
    const refusal = new IngestRefusal(INGEST_FAILURES.noTextLayer);
    expect(refusalOf(refusal)).toBe(refusal);
  });

  it('treats Ollama’s context-length 400 as a passage too long, permanently', () => {
    const error = new LlmError(
      'refused',
      `POST /api/embed answered 400: ${CONTEXT_LENGTH_REFUSAL}`,
    );
    expect(refusalOf(error)?.reason).toBe(INGEST_FAILURES.tooLong);
  });

  it('retries everything else: the server down, a timeout, another 400, a database error', () => {
    for (const error of [
      new LlmError('unreachable', 'ECONNREFUSED'),
      new LlmError('timeout', 'no embeddings'),
      new LlmError('refused', 'POST /api/embed answered 400: bad request'),
      new Error('Can’t reach database server'),
    ])
      expect(refusalOf(error)).toBeNull();
  });

  it('leaves a document that ran out of attempts with the reason that fits', () => {
    expect(finalReason(new LlmError('unreachable', 'x'))).toBe(INGEST_FAILURES.modelUnavailable);
    expect(finalReason(new Error('db'))).toBe(INGEST_FAILURES.gaveUp);
    expect(finalReason(new IngestRefusal(INGEST_FAILURES.empty))).toBe(INGEST_FAILURES.empty);
  });
});
