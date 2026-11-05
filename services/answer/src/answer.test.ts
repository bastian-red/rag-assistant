import fc from 'fast-check';
import { NOT_FOUND_ANSWER, parseSources } from '@rag/shared';
import { describe, expect, it } from 'vitest';

import { answer, failureOf, snippetFor, type AnswerEvent } from './answer';
import { FakeLlmError, SOURCES, retrieval, scriptedChat, source } from './fixtures';
import { SYSTEM_PROMPT } from './prompt';

const ANSWER =
  'The gauge should read between 1 and 1.5 bar [S1]. Bleed the radiators once a year [S2].';

function recorder() {
  const events: AnswerEvent[] = [];
  return {
    events,
    emit: (event: AnswerEvent) => events.push(event),
    text: () => events.map((e) => (e.type === 'token' ? e.text : '')).join(''),
    types: () => events.map((e) => e.type),
  };
}

describe('answer: the happy path', () => {
  it('sends retrieval first, then the tokens, then each citation once, and ends DONE', async () => {
    const model = scriptedChat(ANSWER);
    const r = recorder();
    const out = await answer(
      { chat: model.chat, retrieve: async () => retrieval() },
      { question: 'What pressure, and when to bleed?', history: [] },
      { emit: r.emit },
    );
    expect(out.status).toBe('DONE');
    expect(r.types()[0]).toBe('retrieval');
    expect(r.types().indexOf('retrieval')).toBeLessThan(r.types().indexOf('token'));
    expect(r.text()).toBe(ANSWER);
    expect(out.content).toBe(ANSWER);
    expect(
      r.events
        .filter((e) => e.type === 'citation')
        .map((e) => (e.type === 'citation' ? e.marker : 0)),
    ).toEqual([1, 2]);
    expect(out.citations.map((c) => [c.marker, c.chunkId])).toEqual([
      [1, SOURCES[0]!.chunkId],
      [2, SOURCES[1]!.chunkId],
    ]);
    expect(out.dropped).toEqual([]);
    expect(out.usage?.stopReason).toBe('stop');
    expect(out.timings.firstTokenMs).not.toBeNull();
  });

  it('streams a source as its title, page and an opening snippet', async () => {
    const r = recorder();
    await answer(
      { chat: scriptedChat(ANSWER).chat, retrieve: async () => retrieval() },
      { question: 'q', history: [] },
      { emit: r.emit },
    );
    const first = r.events[0];
    expect(first?.type === 'retrieval' && first.sources[0]).toEqual({
      marker: 1,
      documentId: SOURCES[0]!.documentId,
      chunkId: SOURCES[0]!.chunkId,
      documentTitle: 'Boiler manual',
      page: 1,
      pageEnd: 1,
      headingPath: ['Pressure'],
      snippet: SOURCES[0]!.text,
    });
  });

  it('puts the packed sources, and only those, in the last user message', async () => {
    const model = scriptedChat(ANSWER);
    await answer(
      { chat: model.chat, retrieve: async () => retrieval() },
      { question: 'What pressure?', history: [] },
    );
    const messages = model.calls[0]!.messages;
    expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(parseSources(last.content).map((s) => [s.marker, s.text])).toEqual(
      SOURCES.map((s) => [s.marker, s.text]),
    );
    expect(last.content.endsWith('Question: What pressure?')).toBe(true);
    expect(messages.slice(0, -1).some((m) => parseSources(m.content).length > 0)).toBe(false);
  });

  it('asks for a bounded answer and passes temperature only when given', async () => {
    const model = scriptedChat(ANSWER);
    await answer(
      { chat: model.chat, retrieve: async () => retrieval() },
      { question: 'q', history: [] },
      { maxTokens: 64, temperature: 0 },
    );
    expect(model.calls[0]!.options).toMatchObject({ maxTokens: 64, temperature: 0 });
  });
});

describe('answer: markers (SPECS #2)', () => {
  it('drops a marker naming no packed source and counts it', async () => {
    const r = recorder();
    const out = await answer(
      {
        chat: scriptedChat('Cold pressure is 1 bar [S1][S9]. Also this [S7].').chat,
        retrieve: async () => retrieval(),
      },
      { question: 'q', history: [] },
      { emit: r.emit },
    );
    expect(out.content).toBe('Cold pressure is 1 bar [S1]. Also this.');
    expect(r.text()).toBe(out.content);
    expect(out.dropped).toEqual([
      { raw: '[S9]', labels: [9] },
      { raw: '[S7]', labels: [7] },
    ]);
  });

  it('gives the same text, citations and drops however the model cuts its tokens', async () => {
    const text = 'Between 1 and 1.5 bar [S1, S2]. Not this [S12]; and [s2] again.';
    const whole = await answer(
      { chat: scriptedChat([text]).chat, retrieve: async () => retrieval() },
      { question: 'q', history: [] },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: text.length - 1 }), { maxLength: 12 }),
        async (cuts) => {
          const at = [...new Set(cuts)].sort((a, b) => a - b);
          const pieces = [0, ...at].map((from, i) => text.slice(from, at[i] ?? text.length));
          const out = await answer(
            {
              chat: scriptedChat(pieces.filter((p) => p !== '')).chat,
              retrieve: async () => retrieval(),
            },
            { question: 'q', history: [] },
          );
          expect(out.content).toBe(whole.content);
          expect(out.dropped).toEqual(whole.dropped);
          expect(out.citations).toEqual(whole.citations);
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 40) },
    );
    expect(whole.content).toBe('Between 1 and 1.5 bar [S1][S2]. Not this; and [S2] again.');
  });
});

describe('answer: abstention', () => {
  it('answers "not found" with the nearest passages and never calls the model', async () => {
    const model = scriptedChat(ANSWER);
    const r = recorder();
    const near = [source(1, 'Unrelated text about a garden.')];
    const out = await answer(
      {
        chat: model.chat,
        retrieve: async () =>
          retrieval({
            abstained: true,
            reason: 'below_threshold',
            bestSimilarity: 0.2,
            sources: [],
            nearest: near,
          }),
      },
      { question: 'q', history: [] },
      { emit: r.emit },
    );
    expect(model.calls).toHaveLength(0);
    expect(out).toMatchObject({
      status: 'DONE',
      abstained: true,
      content: NOT_FOUND_ANSWER,
      prompt: null,
    });
    expect(r.types()).toEqual(['retrieval', 'abstain']);
    const abstain = r.events[1];
    expect(abstain?.type === 'abstain' && abstain.nearest.map((s) => s.snippet)).toEqual([
      'Unrelated text about a garden.',
    ]);
    expect(out.citations).toEqual([]);
  });
});

describe('answer: stop (SPECS #5)', () => {
  it('ends STOPPED with exactly the text sent, and aborts the model call', async () => {
    const stop = new AbortController();
    const model = scriptedChat(ANSWER);
    const r = recorder();
    const out = await answer(
      { chat: model.chat, retrieve: async () => retrieval() },
      { question: 'q', history: [] },
      {
        signal: stop.signal,
        emit: (event) => {
          r.emit(event);
          if (r.events.filter((e) => e.type === 'token').length === 3) stop.abort();
        },
      },
    );
    expect(out.status).toBe('STOPPED');
    expect(out.failure).toBeNull();
    expect(out.content).toBe(r.text());
    expect(out.content.length).toBeGreaterThan(0);
    expect(out.content.length).toBeLessThan(ANSWER.length);
    expect(model.sawAbort()).toBe(true);
  });

  it('a stop during retrieval ends STOPPED with no events and no model call', async () => {
    const stop = new AbortController();
    const model = scriptedChat(ANSWER);
    const r = recorder();
    const pending = answer(
      { chat: model.chat, retrieve: () => new Promise(() => undefined) },
      { question: 'q', history: [] },
      { signal: stop.signal, emit: r.emit },
    );
    stop.abort();
    const out = await pending;
    expect(out).toMatchObject({ status: 'STOPPED', content: '', retrieval: null });
    expect(r.events).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });

  it('does not store text the marker stream still held when the stop came', async () => {
    const stop = new AbortController();
    const r = recorder();
    const out = await answer(
      { chat: scriptedChat(['One bar ', '[S', '1]', '.']).chat, retrieve: async () => retrieval() },
      { question: 'q', history: [] },
      {
        signal: stop.signal,
        emit: (event) => {
          r.emit(event);
          if (event.type === 'token') stop.abort();
        },
      },
    );
    expect(out.status).toBe('STOPPED');
    expect(out.content).toBe('One bar');
    expect(out.content).toBe(r.text());
  });
});

describe('answer: failures', () => {
  it('ends FAILED timeout at the deadline, aborting a model that went silent', async () => {
    const model = scriptedChat(ANSWER, { stallAfter: 2 });
    const out = await answer(
      { chat: model.chat, retrieve: async () => retrieval() },
      { question: 'q', history: [] },
      { deadlineMs: 50 },
    );
    expect(out.status).toBe('FAILED');
    expect(out.failure?.code).toBe('timeout');
    expect(model.sawAbort()).toBe(true);
    expect(out.content.length).toBeGreaterThan(0);
  });

  it('keeps the partial text of an answer the model broke off, FAILED with a reason', async () => {
    const out = await answer(
      { chat: scriptedChat(ANSWER, { failAfter: 4 }).chat, retrieve: async () => retrieval() },
      { question: 'q', history: [] },
    );
    expect(out.status).toBe('FAILED');
    expect(out.failure?.code).toBe('failed');
    expect(out.content.length).toBeGreaterThan(0);
  });

  it('maps a model that is not reachable to `unavailable`', async () => {
    const out = await answer(
      {
        chat: scriptedChat(ANSWER, { failAfter: 0, failCode: 'unreachable' }).chat,
        retrieve: async () => retrieval(),
      },
      { question: 'q', history: [] },
    );
    expect(out.failure?.code).toBe('unavailable');
    expect(out.content).toBe('');
  });

  it('a retrieval failure is FAILED with no events: internal for a database error', async () => {
    const r = recorder();
    const out = await answer(
      {
        chat: scriptedChat(ANSWER).chat,
        retrieve: async () => Promise.reject(new Error('connection refused')),
      },
      { question: 'q', history: [] },
      { emit: r.emit },
    );
    expect(out).toMatchObject({ status: 'FAILED', retrieval: null });
    expect(out.failure?.code).toBe('internal');
    expect(out.failure?.message).not.toMatch(/connection/u);
    expect(r.events).toEqual([]);
  });

  it('an answer with no visible text is FAILED, not an empty DONE', async () => {
    const out = await answer(
      { chat: scriptedChat('[S9]').chat, retrieve: async () => retrieval() },
      { question: 'q', history: [] },
    );
    expect(out.status).toBe('FAILED');
    expect(out.dropped).toHaveLength(1);
  });
});

describe('failureOf', () => {
  it('maps every model code and nothing else to a model code', () => {
    expect(failureOf(new FakeLlmError('model_not_found')).code).toBe('unavailable');
    expect(failureOf(new FakeLlmError('timeout')).code).toBe('timeout');
    expect(failureOf(new FakeLlmError('protocol')).code).toBe('failed');
    expect(failureOf(Object.assign(new Error('x'), { name: 'QueryVectorError' })).code).toBe(
      'failed',
    );
    expect(failureOf({ code: 'P2002' }).code).toBe('internal');
    expect(failureOf(null).code).toBe('internal');
  });
});

describe('snippetFor', () => {
  it('skips leading heading lines, which the reader gets as the heading path', () => {
    expect(snippetFor('# Boiler care\n\n## Pressure\nThe gauge reads 1 bar.')).toBe(
      'The gauge reads 1 bar.',
    );
  });

  it('keeps a heading that is all the passage has, and a # that is not a heading', () => {
    expect(snippetFor('# Only a heading')).toBe('# Only a heading');
    expect(snippetFor('#hashtag first. Then text.')).toBe('#hashtag first. Then text.');
    expect(snippetFor('Text first\n# Later heading')).toBe('Text first # Later heading');
  });
});
