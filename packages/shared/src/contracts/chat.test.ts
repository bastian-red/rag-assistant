import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CHAT_STREAM_EVENTS,
  ChatStreamError,
  NOT_FOUND_ANSWER,
  createSseParser,
  parseChatEvent,
  readChatStream,
  snippetOf,
  sseFrame,
  titleFromQuestion,
  type ChatStreamEvent,
  type SseFrame,
} from './chat';

const ID = 'cabcdefghijklmnopqrstuvwx';
const ID2 = 'czyxwvutsrqponmlkjihgfedc';

const source = {
  marker: 1,
  documentId: ID,
  chunkId: ID2,
  documentTitle: 'Boiler manual',
  page: 3,
  pageEnd: 3,
  headingPath: ['Pressure'],
  snippet: 'The gauge should read between 1 and 1.5 bar.',
};

/** One valid event of every kind, in stream order. */
const EVENTS: ChatStreamEvent[] = [
  {
    event: 'retrieval',
    data: { version: 1, questionId: ID, answerId: ID2, sources: [source], staleDocuments: 0 },
  },
  { event: 'token', data: { text: 'Between 1 and 1.5 bar ' } },
  { event: 'citation', data: { marker: 1, documentId: ID, chunkId: ID2 } },
  { event: 'token', data: { text: '[S1].\nline two "quoted"' } },
  {
    event: 'abstain',
    data: { text: NOT_FOUND_ANSWER, reason: 'below_threshold', bestSimilarity: 0.2, nearest: [] },
  },
  {
    event: 'done',
    data: {
      answerId: ID2,
      citations: [
        {
          marker: 1,
          chunkId: ID2,
          documentId: ID,
          documentTitle: 'Boiler manual',
          page: 3,
          quote: 'The gauge',
          quoteStart: 0,
          quoteEnd: 9,
        },
      ],
      dropped: [{ raw: '[S9]', labels: [9] }],
      usage: null,
      timings: { retrievalMs: 12, firstTokenMs: 40, totalMs: 900 },
    },
  },
  { event: 'error', data: { code: 'failed', message: 'The model stopped mid-answer.' } },
];

const wire = EVENTS.map(sseFrame).join('');

/** Cut a string at the given positions. */
function cut(text: string, at: readonly number[]): string[] {
  const points = [...new Set(at.map((n) => n % (text.length + 1)))].sort((a, b) => a - b);
  const pieces: string[] = [];
  let from = 0;
  for (const p of points) {
    pieces.push(text.slice(from, p));
    from = p;
  }
  pieces.push(text.slice(from));
  return pieces;
}

function parseAll(pieces: readonly string[]): SseFrame[] {
  const parser = createSseParser();
  return [...pieces.flatMap((p) => parser.push(p)), ...parser.end()];
}

describe('the event table', () => {
  it('has exactly the six events SPECS section 3 names', () => {
    expect(CHAT_STREAM_EVENTS.sort()).toEqual(
      ['abstain', 'citation', 'done', 'error', 'retrieval', 'token'].sort(),
    );
  });
});

describe('sseFrame', () => {
  it('writes one event line and one data line, a newline in the text escaped', () => {
    const frame = sseFrame({ event: 'token', data: { text: 'a\nb' } });
    expect(frame).toBe('event: token\ndata: {"text":"a\\nb"}\n\n');
  });

  it('refuses an event its schema rejects, so the server cannot write off-contract', () => {
    expect(() => sseFrame({ event: 'token', data: { text: '' } })).toThrow();
    expect(() =>
      sseFrame({
        event: 'abstain',
        data: {
          text: 'Nothing.' as typeof NOT_FOUND_ANSWER,
          reason: 'no_candidates',
          bestSimilarity: null,
          nearest: [],
        },
      }),
    ).toThrow();
  });
});

describe('createSseParser', () => {
  it('reads back every event written, in order', () => {
    expect(parseAll([wire]).map(parseChatEvent)).toEqual(EVENTS);
  });

  it('gives the same frames however the bytes are cut (split invariance)', () => {
    const whole = parseAll([wire]);
    fc.assert(
      fc.property(fc.array(fc.nat(), { maxLength: 30 }), (at) => {
        expect(parseAll(cut(wire, at))).toEqual(whole);
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 200) },
    );
  });

  it('accepts CRLF and CR line ends, including a CRLF cut between CR and LF', () => {
    const crlf = wire.replaceAll('\n', '\r\n');
    const cr = wire.replaceAll('\n', '\r');
    const whole = parseAll([wire]);
    expect(parseAll([crlf])).toEqual(whole);
    expect(parseAll([cr])).toEqual(whole);
    const at = crlf.indexOf('\r\n') + 1;
    expect(parseAll([crlf.slice(0, at), crlf.slice(at)])).toEqual(whole);
    fc.assert(
      fc.property(fc.array(fc.nat(), { maxLength: 30 }), (cuts) => {
        expect(parseAll(cut(crlf, cuts))).toEqual(whole);
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 200) },
    );
  });

  it('skips comments (the heartbeat), joins data lines, defaults the name to message', () => {
    expect(parseAll([': ping\n\ndata: a\ndata:b\n\nevent: x\ndata\n\n'])).toEqual([
      { event: 'message', data: 'a\nb' },
      { event: 'x', data: '' },
    ]);
  });

  it('does not dispatch a frame whose blank line never came', () => {
    expect(parseAll(['event: token\ndata: {"text":"a"}\n'])).toEqual([]);
  });
});

describe('parseChatEvent', () => {
  it('refuses an unknown event, bad JSON and an off-contract body by name', () => {
    expect(() => parseChatEvent({ event: 'tokens', data: '{}' })).toThrow(ChatStreamError);
    expect(() => parseChatEvent({ event: 'token', data: '{' })).toThrow(/not JSON/u);
    expect(() =>
      parseChatEvent({
        event: 'retrieval',
        data: JSON.stringify({ ...EVENTS[0]!.data, version: 2 }),
      }),
    ).toThrow(/contract v1/u);
    expect(() => parseChatEvent({ event: 'toString', data: '{}' })).toThrow(/unknown/u);
  });
});

describe('readChatStream', () => {
  it('decodes a body cut inside a multi-byte character', async () => {
    const text =
      sseFrame({ event: 'token', data: { text: 'café ' } }) +
      sseFrame({ event: 'token', data: { text: '日本' } });
    const bytes = new TextEncoder().encode(text);
    const accent = bytes.indexOf(0xc3);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, accent + 1));
        controller.enqueue(bytes.slice(accent + 1));
        controller.close();
      },
    });
    const events: ChatStreamEvent[] = [];
    for await (const event of readChatStream(body)) events.push(event);
    expect(events.map((e) => (e.event === 'token' ? e.data.text : ''))).toEqual(['café ', '日本']);
  });
});

describe('snippetOf and titleFromQuestion', () => {
  it('keeps a short text whole, one line', () => {
    expect(snippetOf('  When does\nthe warranty   end? ')).toBe('When does the warranty end?');
  });

  it('cuts a long text at a word, within the limit, with an ellipsis', () => {
    const long = 'word '.repeat(100);
    const snippet = snippetOf(long, 40);
    expect(Array.from(snippet).length).toBeLessThanOrEqual(40);
    expect(snippet.endsWith('word…')).toBe(true);
  });

  it('counts code points, so an astral character is never split', () => {
    const title = titleFromQuestion('😀'.repeat(100), 10);
    expect(Array.from(title)).toHaveLength(10);
    expect(title).toBe(`${'😀'.repeat(9)}…`);
  });
});
