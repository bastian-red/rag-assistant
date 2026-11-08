import type { ChatStreamEvent, CitationView, MessageView, StreamSource } from '@rag/shared';
import { describe, expect, it } from 'vitest';

import {
  applyEvent,
  chipTarget,
  failTurn,
  pageWords,
  startTurn,
  stopTurn,
  turnsFromMessages,
  type Turn,
} from './chat-state';

const source = (marker: number, over: Partial<StreamSource> = {}): StreamSource => ({
  marker,
  documentId: `doc${String(marker)}`,
  chunkId: `chunk${String(marker)}`,
  documentTitle: `Manual ${String(marker)}`,
  page: marker,
  pageEnd: marker,
  headingPath: [],
  snippet: 'snippet',
  ...over,
});

const citation = (marker: number, over: Partial<CitationView> = {}): CitationView => ({
  marker,
  chunkId: `chunk${String(marker)}`,
  documentId: `doc${String(marker)}`,
  documentTitle: `Manual ${String(marker)}`,
  page: 2,
  quote: 'The quote.',
  quoteStart: 10,
  quoteEnd: 20,
  ...over,
});

const run = (events: ChatStreamEvent[]): Turn =>
  events.reduce(applyEvent, startTurn('How hot?', 'pending', '2026-11-08T09:00:00.000Z'));

const retrieval: ChatStreamEvent = {
  event: 'retrieval',
  data: {
    version: 1,
    questionId: 'q1',
    answerId: 'a1',
    sources: [source(1), source(2)],
    staleDocuments: 1,
  },
};

describe('applyEvent', () => {
  it('shows the sources before any word, keyed by the answer from then on', () => {
    const turn = run([retrieval]);
    expect(turn).toMatchObject({ key: 'a1', status: 'answering', text: '', staleDocuments: 1 });
    expect(turn.sources.map((s) => s.marker)).toEqual([1, 2]);
  });

  it('appends tokens in order and finishes with the resolved citations', () => {
    const turn = run([
      retrieval,
      { event: 'token', data: { text: 'Hot ' } },
      { event: 'token', data: { text: 'enough [S1].' } },
      {
        event: 'done',
        data: {
          answerId: 'a1',
          citations: [citation(1)],
          dropped: [],
          usage: null,
          timings: { retrievalMs: 1, firstTokenMs: 2, totalMs: 3 },
        },
      },
    ]);
    expect(turn).toMatchObject({ status: 'done', text: 'Hot enough [S1].' });
    expect(turn.citations).toHaveLength(1);
  });

  it('turns an abstention into the plain sentence with the nearest passages', () => {
    const turn = run([
      { ...retrieval, data: { ...retrieval.data, sources: [] } } as ChatStreamEvent,
      {
        event: 'abstain',
        data: {
          text: 'Not found in your documents.',
          reason: 'below_threshold',
          bestSimilarity: 0.2,
          nearest: [source(3)],
        },
      },
    ]);
    expect(turn.text).toBe('Not found in your documents.');
    expect(turn.abstained?.nearest.map((s) => s.marker)).toEqual([3]);
  });

  it('keeps the words already shown when the stream errors', () => {
    const turn = run([
      retrieval,
      { event: 'token', data: { text: 'Partial' } },
      { event: 'error', data: { code: 'timeout', message: 'No answer in 5 minutes.' } },
    ]);
    expect(turn).toMatchObject({ status: 'failed', text: 'Partial' });
    expect(turn.error).toBe('The answer took too long and was stopped. No answer in 5 minutes.');
  });
});

describe('stop and failure', () => {
  it('stop keeps the text and leaves a finished answer alone', () => {
    const streaming = run([retrieval, { event: 'token', data: { text: 'Half' } }]);
    expect(stopTurn(streaming)).toMatchObject({ status: 'stopped', text: 'Half' });
    const done = { ...streaming, status: 'done' as const };
    expect(stopTurn(done)).toBe(done);
  });

  it('a failed request does not overwrite a turn that already ended', () => {
    const stopped = stopTurn(run([retrieval]));
    expect(failTurn(stopped, 'network')).toBe(stopped);
    expect(failTurn(run([retrieval]), 'network')).toMatchObject({
      status: 'failed',
      error: 'network',
    });
  });
});

describe('chipTarget', () => {
  it('links to the source while streaming, then to the quote once resolved', () => {
    const live = run([retrieval]);
    expect(chipTarget(live, 2)).toEqual({
      kind: 'link',
      documentId: 'doc2',
      chunkId: 'chunk2',
      title: 'Manual 2',
      page: 2,
    });
    const resolved = { ...live, citations: [citation(2, { page: 3 })] };
    expect(chipTarget(resolved, 2)).toMatchObject({ page: 3, from: 10, to: 20 });
  });

  it('names a deleted document instead of linking nowhere', () => {
    const turn = {
      ...run([retrieval]),
      citations: [citation(1, { documentId: null, chunkId: null })],
    };
    expect(chipTarget(turn, 1)).toEqual({ kind: 'gone', title: 'Manual 1' });
  });

  it('is unknown for a marker no source carries', () => {
    expect(chipTarget(run([retrieval]), 9)).toEqual({ kind: 'unknown' });
  });
});

describe('turnsFromMessages', () => {
  const message = (over: Partial<MessageView>): MessageView => ({
    id: 'm',
    role: 'USER',
    content: '',
    status: 'DONE',
    error: null,
    abstained: false,
    createdAt: '2026-11-07T10:00:00.000Z',
    citations: [],
    ...over,
  });

  it('pairs each question with the answer after it, in every stored state', () => {
    const turns = turnsFromMessages([
      message({ id: 'q1', content: 'One?' }),
      message({ id: 'a1', role: 'ASSISTANT', content: 'Yes [S1].', citations: [citation(1)] }),
      message({ id: 'q2', content: 'Two?' }),
      message({ id: 'a2', role: 'ASSISTANT', content: 'Hal', status: 'STOPPED' }),
      message({ id: 'q3', content: 'Three?' }),
      message({
        id: 'a3',
        role: 'ASSISTANT',
        status: 'FAILED',
        error: 'The model server stopped.',
      }),
      message({ id: 'q4', content: 'Four?' }),
      message({
        id: 'a4',
        role: 'ASSISTANT',
        content: 'Not found in your documents.',
        abstained: true,
      }),
    ]);
    expect(turns.map((t) => [t.key, t.status, t.text])).toEqual([
      ['a1', 'done', 'Yes [S1].'],
      ['a2', 'stopped', 'Hal'],
      ['a3', 'failed', ''],
      ['a4', 'done', 'Not found in your documents.'],
    ]);
    expect(turns[2]!.error).toBe('The model server stopped.');
    expect(turns[3]!.abstained).toEqual({ nearest: [] });
    // The slip is stamped with when the question was asked, not answered.
    expect(turns[0]!.askedAt).toBe('2026-11-07T10:00:00.000Z');
  });

  it('keeps a question whose answer was never saved', () => {
    const [turn] = turnsFromMessages([message({ id: 'q1', content: 'Lost?' })]);
    expect(turn).toMatchObject({ key: 'q1', status: 'failed' });
  });
});

describe('pageWords', () => {
  it('says one page, a range, or nothing', () => {
    expect(pageWords(4)).toBe('page 4');
    expect(pageWords(4, 4)).toBe('page 4');
    expect(pageWords(4, 5)).toBe('pages 4–5');
    expect(pageWords(null)).toBeNull();
  });
});
