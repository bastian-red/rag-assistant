/**
 * Test doubles for the gate lane: a retrieval result built by hand and an
 * in-memory model that streams a fixed answer the way Ollama cuts one
 * (`streamPieces` from the fake server, so `[S12]` arrives split).
 */
import { streamPieces } from '@rag/llm';
import type { Retrieval, RetrievedSource } from '@rag/retrieval';
import type { ChatEvent, ChatMessage, ChatOptions, ChatUsage, LlmClient } from '@rag/shared';

export const DOC = 'cdocument0000000000000001';

export function source(
  marker: number,
  text: string,
  extra: Partial<RetrievedSource> = {},
): RetrievedSource {
  const chunkId = `cchunk${String(marker).padStart(19, '0')}`;
  return {
    marker,
    chunkId,
    documentId: DOC,
    documentTitle: 'Boiler manual',
    page: marker,
    pageEnd: marker,
    text,
    headingPath: ['Pressure'],
    chunkIds: [chunkId],
    fused: 1 / (60 + marker),
    similarity: 0.6,
    tokens: 40,
    ...extra,
  };
}

export const SOURCES: RetrievedSource[] = [
  source(1, 'The gauge should read between 1 and 1.5 bar when the system is cold.'),
  source(2, 'Bleed the radiators once a year, before the heating season starts.'),
];

export function retrieval(overrides: Partial<Retrieval> = {}): Retrieval {
  return {
    query: 'q',
    mode: 'hybrid',
    space: 'qwen3-embedding:0.6b@000000000000',
    abstained: false,
    reason: null,
    bestSimilarity: 0.6,
    sources: SOURCES,
    nearest: [],
    candidates: [],
    skipped: { duplicates: 0, overBudget: 0 },
    staleDocuments: 0,
    timings: { embedMs: 1, searchMs: 1, totalMs: 2 },
    ...overrides,
  };
}

export const USAGE: ChatUsage = {
  promptTokens: 100,
  outputTokens: 20,
  stopReason: 'stop',
  thinkingDropped: 0,
  firstTokenMs: 1,
  totalMs: 2,
  loadMs: 0,
  promptMs: 1,
  outputMs: 1,
};

/** An error shaped like @rag/llm's LlmError: what `failureOf` reads is the code. */
export class FakeLlmError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface ScriptedChat {
  readonly chat: LlmClient['chat'];
  readonly calls: { messages: readonly ChatMessage[]; options: ChatOptions | undefined }[];
  /** The signal of the last call was aborted while the call was running. */
  sawAbort(): boolean;
}

/**
 * Streams `answer` in pieces (or the given pieces), yielding to the event
 * loop between them so a stop can land mid-answer. `failAfter` throws a
 * model error after that many pieces; `stallAfter` waits (until aborted).
 */
export function scriptedChat(
  answer: string | readonly string[],
  script: { failAfter?: number; failCode?: string; stallAfter?: number } = {},
): ScriptedChat {
  const calls: ScriptedChat['calls'] = [];
  let aborted = false;
  async function* chat(
    messages: readonly ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatEvent> {
    calls.push({ messages, options });
    const signal = options?.signal;
    const fail = () => {
      aborted = true;
      throw new FakeLlmError('aborted');
    };
    signal?.addEventListener('abort', () => (aborted = true), { once: true });
    const pieces = typeof answer === 'string' ? streamPieces(answer) : answer;
    for (const [index, text] of pieces.entries()) {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted === true) fail();
      if (script.failAfter !== undefined && index >= script.failAfter) {
        throw new FakeLlmError(script.failCode ?? 'failed');
      }
      if (script.stallAfter !== undefined && index >= script.stallAfter) {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new FakeLlmError('aborted')), {
            once: true,
          });
        });
      }
      yield { type: 'token', text };
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (signal?.aborted === true) fail();
    yield { type: 'done', usage: USAGE };
  }
  return { chat, calls, sawAbort: () => aborted };
}
