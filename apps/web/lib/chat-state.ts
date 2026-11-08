/**
 * One question and its answer, as the page shows it, built from the stream
 * events (live) or from stored messages (history). Pure, so the order rules
 * are unit tested rather than discovered in a browser:
 *
 * - sources arrive before the words (`retrieval` before any `token`), and a
 *   chip can link to its source from the moment its marker appears;
 * - `done` replaces the provisional links with the resolved citations, which
 *   carry the exact quote span and its page;
 * - stopping keeps every word already shown (the API stores the same text);
 * - an `error` after some text keeps the text and says what went wrong.
 */
import type { ChatStreamEvent, CitationView, MessageView, StreamSource } from '@rag/shared';

export type TurnStatus = 'searching' | 'answering' | 'done' | 'stopped' | 'failed';

export interface Turn {
  /** The answer's id once known; the question's text is the key before that. */
  readonly key: string;
  readonly question: string;
  readonly status: TurnStatus;
  readonly text: string;
  /** What the answer was built from, in marker order (live answers only). */
  readonly sources: readonly StreamSource[];
  /** The resolved citations (after `done`, and for stored answers). */
  readonly citations: readonly CitationView[];
  /** Nothing in reach: the nearest passages, shown so the reader sees what was close. */
  readonly abstained: { readonly nearest: readonly StreamSource[] } | null;
  readonly error: string | null;
  /** READY documents that were being re-indexed and could not be searched. */
  readonly staleDocuments: number;
}

export function startTurn(question: string, key: string): Turn {
  return {
    key,
    question,
    status: 'searching',
    text: '',
    sources: [],
    citations: [],
    abstained: null,
    error: null,
    staleDocuments: 0,
  };
}

const ERROR_WORDS: Record<string, string> = {
  unavailable: 'The model server is not available right now.',
  timeout: 'The answer took too long and was stopped.',
  failed: 'The answer failed part way through.',
  internal: 'Something went wrong while answering.',
};

export function applyEvent(turn: Turn, event: ChatStreamEvent): Turn {
  switch (event.event) {
    case 'retrieval':
      return {
        ...turn,
        key: event.data.answerId,
        status: 'answering',
        sources: event.data.sources,
        staleDocuments: event.data.staleDocuments,
      };
    case 'token':
      return { ...turn, status: 'answering', text: turn.text + event.data.text };
    case 'citation':
      return turn;
    case 'abstain':
      return {
        ...turn,
        status: 'answering',
        text: event.data.text,
        abstained: { nearest: event.data.nearest },
      };
    case 'done':
      return {
        ...turn,
        key: event.data.answerId,
        status: 'done',
        citations: event.data.citations,
      };
    case 'error':
      return {
        ...turn,
        status: 'failed',
        error:
          `${ERROR_WORDS[event.data.code] ?? ERROR_WORDS.internal!} ${event.data.message}`.trim(),
      };
  }
}

/** The reader pressed Stop: the words so far stay. A finished turn is left alone. */
export function stopTurn(turn: Turn): Turn {
  return turn.status === 'searching' || turn.status === 'answering'
    ? { ...turn, status: 'stopped' }
    : turn;
}

/** The request itself failed (refused before the stream, or the connection dropped). */
export function failTurn(turn: Turn, message: string): Turn {
  return turn.status === 'done' || turn.status === 'stopped'
    ? turn
    : { ...turn, status: 'failed', error: message };
}

/** Stored messages, oldest first, as turns: each USER message and the answer after it. */
export function turnsFromMessages(messages: readonly MessageView[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const question = messages[i]!;
    if (question.role !== 'USER') continue;
    const answer = messages[i + 1]?.role === 'ASSISTANT' ? messages[i + 1]! : null;
    if (answer !== null) i += 1;
    turns.push({
      key: answer?.id ?? question.id,
      question: question.content,
      status:
        answer === null
          ? 'failed'
          : answer.status === 'DONE'
            ? 'done'
            : answer.status === 'STOPPED'
              ? 'stopped'
              : answer.status === 'STREAMING'
                ? 'answering'
                : 'failed',
      text: answer?.content ?? '',
      sources: [],
      citations: answer?.citations ?? [],
      // Stored abstentions keep no nearest passages: the reply says so plainly.
      abstained: answer?.abstained ? { nearest: [] } : null,
      error:
        answer === null
          ? 'No answer was saved for this question.'
          : answer.status === 'FAILED'
            ? (answer.error ?? 'The answer failed.')
            : null,
      staleDocuments: 0,
    });
  }
  return turns;
}

/** Where a marker's chip points, from the best information the turn has. */
export type ChipTarget =
  | {
      readonly kind: 'link';
      readonly documentId: string;
      readonly chunkId: string;
      readonly title: string;
      readonly page: number | null;
      readonly from?: number;
      readonly to?: number;
    }
  | { readonly kind: 'gone'; readonly title: string }
  | { readonly kind: 'unknown' };

export function chipTarget(turn: Turn, marker: number): ChipTarget {
  const citation = turn.citations.find((c) => c.marker === marker);
  if (citation !== undefined) {
    if (citation.documentId === null || citation.chunkId === null) {
      return { kind: 'gone', title: citation.documentTitle };
    }
    return {
      kind: 'link',
      documentId: citation.documentId,
      chunkId: citation.chunkId,
      title: citation.documentTitle,
      page: citation.page,
      from: citation.quoteStart,
      to: citation.quoteEnd,
    };
  }
  const source = turn.sources.find((s) => s.marker === marker);
  if (source !== undefined) {
    return {
      kind: 'link',
      documentId: source.documentId,
      chunkId: source.chunkId,
      title: source.documentTitle,
      page: source.page,
    };
  }
  return { kind: 'unknown' };
}

/** "page 4", "pages 4-5", or null for a document without pages. */
export function pageWords(page: number | null, pageEnd: number | null = null): string | null {
  if (page === null) return null;
  if (pageEnd === null || pageEnd === page) return `page ${String(page)}`;
  return `pages ${String(page)}–${String(pageEnd)}`;
}
