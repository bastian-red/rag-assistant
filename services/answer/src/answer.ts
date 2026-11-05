/**
 * One question, one answer, as events while it happens and an outcome after.
 *
 *   retrieve -> `retrieval` event
 *     abstained? -> `abstain` event, "Not found in your documents.", no model call
 *     else       -> prompt -> streamed chat -> `token` / `citation` events
 *
 * The caller (the API, or the eval runner) supplies retrieval and the model
 * and decides what to do with the events and the outcome; nothing here knows
 * about HTTP or storage.
 *
 * **Markers.** Every token goes through `createMarkerStream` with the packed
 * markers, so a `[S7]` when six sources were packed never reaches the reader:
 * it is dropped and counted (SPECS #2), and a marker split across tokens is
 * still one marker.
 *
 * **Stop and deadline.** `signal` is the reader's stop; the run also stops
 * itself after `deadlineMs`. Either one aborts the model call (the model
 * server stops generating, SPECS #5). A stop ends as STOPPED with exactly
 * the text the reader was sent: text the marker stream still held (a
 * half-written `[S`) was never shown, so it is not stored. The deadline ends
 * as FAILED with code `timeout`. The two are told apart by which signal
 * fired, never by the error's text.
 */
import {
  createMarkerStream,
  resolveCitations,
  type DroppedMarker,
  type ResolvedCitation,
  type StreamOutput,
} from '@rag/citations';
import type { Retrieval, RetrievedSource } from '@rag/retrieval';
import {
  LLM_ERROR_CODES,
  NOT_FOUND_ANSWER,
  snippetOf,
  type ChatErrorCode,
  type ChatUsage,
  type LlmClient,
  type LlmErrorCode,
  type StreamSource,
} from '@rag/shared';

import { buildPrompt, type Exchange, type Prompt } from './prompt';

/** Longer than any answer a 4B model on a CPU writes in 1,024 tokens, cold load included. */
export const ANSWER_DEADLINE_MS = 5 * 60_000;

/** Upper bound on generated tokens: a brief answer is a few hundred. */
export const MAX_ANSWER_TOKENS = 1_024;

export interface AnswerDeps {
  readonly chat: LlmClient['chat'];
  /** Retrieval for the asking person's scope, already bound (`retrieve` in @rag/retrieval). */
  readonly retrieve: (question: string) => Promise<Retrieval>;
  readonly now?: () => number;
}

export interface AnswerRequest {
  readonly question: string;
  /** Earlier finished exchanges of the conversation, oldest first. */
  readonly history: readonly Exchange[];
}

export type AnswerEvent =
  | {
      readonly type: 'retrieval';
      readonly sources: StreamSource[];
      readonly staleDocuments: number;
    }
  | { readonly type: 'token'; readonly text: string }
  | {
      readonly type: 'citation';
      readonly marker: number;
      readonly documentId: string;
      readonly chunkId: string;
    }
  | {
      readonly type: 'abstain';
      readonly reason: 'no_candidates' | 'below_threshold';
      readonly bestSimilarity: number | null;
      readonly nearest: StreamSource[];
    };

export interface AnswerOptions {
  /** The reader's stop. */
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly maxTokens?: number;
  /** 0 in the eval lane, for repeatable runs. */
  readonly temperature?: number;
  /** Called synchronously for every event, in order. */
  readonly emit?: (event: AnswerEvent) => void;
}

export type AnswerStatus = 'DONE' | 'STOPPED' | 'FAILED';

export interface AnswerFailure {
  readonly code: ChatErrorCode;
  /** A sentence for the reader; never a server address or a passage. */
  readonly message: string;
  readonly cause?: unknown;
}

export interface AnswerOutcome {
  readonly status: AnswerStatus;
  /** The text the reader was sent, markers canonical. */
  readonly content: string;
  readonly abstained: boolean;
  /** Null when retrieval itself failed or was stopped. */
  readonly retrieval: Retrieval | null;
  /** Null when the model was not called. */
  readonly prompt: Prompt | null;
  readonly citations: ResolvedCitation[];
  readonly dropped: DroppedMarker[];
  readonly usage: ChatUsage | null;
  readonly failure: AnswerFailure | null;
  readonly timings: {
    readonly retrievalMs: number;
    /** From the start of the run to the first visible token; null when none was sent. */
    readonly firstTokenMs: number | null;
    readonly totalMs: number;
  };
}

const MESSAGES: Readonly<Record<ChatErrorCode, string>> = Object.freeze({
  unavailable: 'The model server is not available right now. Try again once it is running.',
  failed: 'The model stopped before it finished the answer.',
  timeout: 'The answer took longer than five minutes and was stopped.',
  internal: 'Something went wrong while answering.',
});

const BY_LLM_CODE: Readonly<Record<LlmErrorCode, ChatErrorCode>> = Object.freeze({
  unreachable: 'unavailable',
  model_not_found: 'unavailable',
  model_unsupported: 'unavailable',
  refused: 'failed',
  failed: 'failed',
  protocol: 'failed',
  timeout: 'timeout',
  aborted: 'failed',
});

/** A thrown value as a failure: model errors by their stable code, anything else `internal`. */
export function failureOf(error: unknown): AnswerFailure {
  const code = (error as { code?: unknown } | null)?.code;
  const known =
    typeof code === 'string' && (LLM_ERROR_CODES as readonly string[]).includes(code)
      ? BY_LLM_CODE[code as LlmErrorCode]
      : error instanceof Error && error.name === 'QueryVectorError'
        ? 'failed'
        : 'internal';
  return { code: known, message: MESSAGES[known], cause: error };
}

/** Leading markdown heading lines: the reader gets them as `headingPath`, not as `#` text. */
const LEADING_HEADINGS = /^(?:[ \t]{0,3}#{1,6}(?:[ \t][^\n]*)?(?:\n|$)\s*)+/u;

/** A passage's opening for the reader: headings skipped (unless that is all there is). */
export function snippetFor(text: string): string {
  const body = text.replace(LEADING_HEADINGS, '');
  return snippetOf(body.trim() === '' ? text : body);
}

export function streamSource(source: RetrievedSource): StreamSource {
  return {
    marker: source.marker,
    documentId: source.documentId,
    chunkId: source.chunkId,
    documentTitle: source.documentTitle,
    page: source.page,
    pageEnd: source.pageEnd,
    headingPath: [...source.headingPath],
    snippet: snippetFor(source.text),
  };
}

/** Resolve `promise`, or reject as soon as `signal` aborts (the work itself may run on). */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function answer(
  deps: AnswerDeps,
  request: AnswerRequest,
  options: AnswerOptions = {},
): Promise<AnswerOutcome> {
  const now = deps.now ?? (() => performance.now());
  const emit = options.emit ?? (() => undefined);
  const started = now();
  const stop = options.signal;
  const deadline = AbortSignal.timeout(options.deadlineMs ?? ANSWER_DEADLINE_MS);
  const signal = stop === undefined ? deadline : AbortSignal.any([stop, deadline]);

  let retrieval: Retrieval | null = null;
  let retrievalMs = 0;
  let prompt: Prompt | null = null;
  let content = '';
  let firstTokenMs: number | null = null;
  let usage: ChatUsage | null = null;
  let sources: readonly RetrievedSource[] = [];
  let markers = createMarkerStream([]);

  const finish = (status: AnswerStatus, failure: AnswerFailure | null): AnswerOutcome => ({
    status,
    content,
    abstained: retrieval?.abstained ?? false,
    retrieval,
    prompt,
    citations: content === '' ? [] : resolveCitations(content, sources),
    dropped: [...markers.dropped()],
    usage,
    failure,
    timings: { retrievalMs, firstTokenMs, totalMs: Math.round(now() - started) },
  });
  /** How an interrupted run ends: the reader's stop wins over the deadline. */
  const interrupted = (error: unknown): AnswerOutcome => {
    if (stop?.aborted === true) return finish('STOPPED', null);
    if (deadline.aborted) return finish('FAILED', { code: 'timeout', message: MESSAGES.timeout });
    return finish('FAILED', failureOf(error));
  };

  try {
    retrieval = await unlessAborted(deps.retrieve(request.question), signal);
  } catch (error) {
    retrievalMs = Math.round(now() - started);
    return interrupted(error);
  }
  retrievalMs = Math.round(now() - started);
  sources = retrieval.sources;

  emit({
    type: 'retrieval',
    sources: retrieval.sources.map(streamSource),
    staleDocuments: retrieval.staleDocuments,
  });

  if (retrieval.abstained) {
    content = NOT_FOUND_ANSWER;
    emit({
      type: 'abstain',
      reason: retrieval.reason ?? 'no_candidates',
      bestSimilarity: retrieval.bestSimilarity,
      nearest: retrieval.nearest.map(streamSource),
    });
    return finish('DONE', null);
  }
  if (signal.aborted) return interrupted(signal.reason);

  prompt = buildPrompt({
    question: request.question,
    sources: retrieval.sources.map((s) => ({
      marker: s.marker,
      title: s.documentTitle,
      page: s.page,
      text: s.text,
    })),
    history: request.history,
  });
  markers = createMarkerStream(retrieval.sources.map((s) => s.marker));
  const byMarker = new Map(retrieval.sources.map((s) => [s.marker, s]));
  const show = (out: StreamOutput) => {
    if (out.text !== '') {
      content += out.text;
      firstTokenMs ??= Math.round(now() - started);
      emit({ type: 'token', text: out.text });
    }
    for (const marker of out.cited) {
      const source = byMarker.get(marker)!;
      emit({ type: 'citation', marker, documentId: source.documentId, chunkId: source.chunkId });
    }
  };

  try {
    for await (const event of deps.chat(prompt.messages, {
      signal,
      maxTokens: options.maxTokens ?? MAX_ANSWER_TOKENS,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    })) {
      // A stop that lands while a token is in hand: the reader is gone.
      if (signal.aborted) return interrupted(signal.reason);
      if (event.type === 'token') show(markers.push(event.text));
      else {
        usage = event.usage;
        show(markers.end());
      }
    }
  } catch (error) {
    return interrupted(error);
  }
  if (usage === null) {
    return finish('FAILED', { code: 'failed', message: MESSAGES.failed });
  }
  if (content.trim() === '') {
    return finish('FAILED', { code: 'failed', message: 'The model wrote no answer.' });
  }
  return finish('DONE', null);
}
