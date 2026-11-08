/**
 * The chat stream through the real graph, with the fake model server behind
 * it. Holds SPECS outcomes #2 (a marker naming nothing packed is dropped and
 * counted), #3 (a canary in one person's library never reaches another's
 * candidates, prompt, answer, citations or trace), #5 (retrieval before the
 * first token; stop leaves a STOPPED answer and the model server sees the
 * abort), and the answer rules of section 1 (abstain without a model call).
 */
import {
  NOT_FOUND_ANSWER,
  conversationDetailSchema,
  parseSources,
  type ChatStreamEvent,
  type ConversationSummary,
} from '@rag/shared';
import { PROMPT_VERSION } from '@rag/answer';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ORPHAN_ERROR } from '../src/conversations/conversations.service';
import { addDocument, ask, fakeChats, fakeScript, shape, until } from './chat-support';
import { boot, call, newUser, type Harness } from './support';

const CHAT_BUDGET = Number(process.env.RATE_LIMIT_CHAT ?? '20');

const BOILER = [
  '# Boiler care',
  '',
  'The boiler pressure gauge should read between 1 and 1.5 bar when the heating is cold.',
  '',
  'Bleed every radiator once a year, before the heating season starts, and check the gauge again.',
].join('\n');
const BOILER_QUESTION = 'What should the boiler pressure gauge read when the heating is cold?';

const GARDEN = [
  '# Garden',
  '',
  'Prune the apple trees in late winter while they are dormant.',
].join('\n');

const CANARY = 'heliotrope-4417';

/**
 * Shares no word with any document here, so its hash similarity is 0.000
 * (measured): below the lane's 0.12. A question with "the" or "in" in it is
 * not unrelated to the fake: "Which zebra won the xylophone quiz in
 * Ulaanbaatar?" scores 0.168 against the boiler manual.
 */
const UNRELATED = 'Zebra xylophone quiz Ulaanbaatar?';

let h: Harness;
beforeAll(async () => {
  h = await boot();
  await fakeScript(null);
});
afterEach(async () => {
  await fakeScript(null);
});
afterAll(async () => {
  await h.close();
});

async function person(label: string) {
  const user = await newUser(h.db, label);
  const shelf = await call<{ id: string }>(h, 'POST', '/collections', {
    user,
    body: { name: 'Shelf' },
  });
  expect(shelf.status).toBe(201);
  return { user, owner: { id: user.id, collectionId: shelf.body.id } };
}

async function conversation(user: { id: string; email: string; name: string }, body: unknown = {}) {
  const r = await call<ConversationSummary>(h, 'POST', '/conversations', { user, body });
  expect(r.status).toBe(201);
  return r.body;
}

async function detail(user: { id: string; email: string; name: string }, id: string) {
  const r = await call(h, 'GET', `/conversations/${id}`, { user });
  expect(r.status).toBe(200);
  return conversationDetailSchema.parse(r.body);
}

const first = <K extends ChatStreamEvent['event']>(events: ChatStreamEvent[], name: K) =>
  events.find((e): e is Extract<ChatStreamEvent, { event: K }> => e.event === name);

describe('POST /chat/:id/messages: an answer', () => {
  it('streams retrieval before the first token, cites its source, and stores what was sent (SPECS #5)', async () => {
    const { user, owner } = await person('answer');
    const doc = await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);

    const r = await ask(h, user, conv.id, BOILER_QUESTION);
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/^text\/event-stream/u);
    // The marker is in the last piece ("1]."), so its citation follows the last token.
    expect(shape(r.events)).toEqual(['retrieval', 'token', 'citation', 'done']);

    const retrieval = first(r.events, 'retrieval')!.data;
    expect(retrieval.sources.map((s) => [s.marker, s.documentId, s.documentTitle])).toEqual([
      [1, doc.id, 'Boiler manual'],
    ]);
    expect(retrieval.sources[0]!.snippet).toMatch(/^The boiler pressure gauge should read/u);
    // The fake answers with the first sentence of each source and its marker.
    expect(r.text).toBe(
      'The boiler pressure gauge should read between 1 and 1.5 bar when the heating is cold [S1].',
    );
    expect(first(r.events, 'citation')!.data).toEqual({
      marker: 1,
      documentId: doc.id,
      chunkId: doc.chunkIds[0],
    });

    const done = first(r.events, 'done')!.data;
    expect(done.answerId).toBe(retrieval.answerId);
    expect(done.dropped).toEqual([]);
    expect(done.usage?.stopReason).toBe('stop');
    expect(done.citations).toHaveLength(1);
    expect(done.citations[0]).toMatchObject({
      marker: 1,
      chunkId: doc.chunkIds[0],
      documentId: doc.id,
      documentTitle: 'Boiler manual',
      page: null,
      quote:
        'The boiler pressure gauge should read between 1 and 1.5 bar when the heating is cold.',
    });
    // The stored span is the quote inside the chunk's own text.
    const chunk = await h.db.chunk.findUniqueOrThrow({ where: { id: doc.chunkIds[0]! } });
    const cite = done.citations[0]!;
    expect([...chunk.text].slice(cite.quoteStart, cite.quoteEnd).join('')).toBe(cite.quote);

    const stored = await detail(user, conv.id);
    expect(stored.title).toBe(BOILER_QUESTION);
    expect(stored.messages.map((m) => [m.role, m.status])).toEqual([
      ['USER', 'DONE'],
      ['ASSISTANT', 'DONE'],
    ]);
    expect(stored.messages[0]!.id).toBe(retrieval.questionId);
    expect(stored.messages[1]).toMatchObject({
      id: retrieval.answerId,
      content: r.text,
      abstained: false,
      error: null,
      citations: done.citations,
    });

    const trace = await h.db.retrievalTrace.findUniqueOrThrow({
      where: { messageId: done.answerId },
    });
    expect(trace).toMatchObject({
      ownerId: user.id,
      query: BOILER_QUESTION,
      abstainReason: null,
      chatModel: process.env.CHAT_MODEL,
      dropped: [],
    });
    expect(trace.bestSimilarity).toBeGreaterThanOrEqual(
      Number(process.env.RETRIEVAL_MIN_SIMILARITY),
    );
    expect(trace.details).toMatchObject({
      status: 'DONE',
      promptVersion: PROMPT_VERSION,
      historyExchanges: 0,
    });
    const candidates = trace.candidates as { chunkId: string; marker: number | null }[];
    expect(candidates.map((c) => c.chunkId)).toEqual(doc.chunkIds);
    expect(candidates[0]!.marker).toBe(1);
  });

  it('drops a marker that names no packed source, and counts it in done and the trace (SPECS #2)', async () => {
    const { user, owner } = await person('dropped');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    await fakeScript({ answer: 'Keep it at about one bar [S1][S7]. Then this [S9].' });

    const r = await ask(h, user, conv.id, BOILER_QUESTION);
    expect(r.text).toBe('Keep it at about one bar [S1]. Then this.');
    const done = first(r.events, 'done')!.data;
    expect(done.dropped).toEqual([
      { raw: '[S7]', labels: [7] },
      { raw: '[S9]', labels: [9] },
    ]);
    expect(r.events.filter((e) => e.event === 'citation')).toHaveLength(1);
    const trace = await h.db.retrievalTrace.findUniqueOrThrow({
      where: { messageId: done.answerId },
    });
    expect(trace.dropped).toEqual(done.dropped);
    expect((await detail(user, conv.id)).messages[1]!.content).toBe(r.text);
  });

  it('carries earlier finished exchanges, markers removed, and only this turn’s sources (history)', async () => {
    const { user, owner } = await person('history');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    await addDocument(h.db, owner, 'Garden notes', GARDEN);
    const conv = await conversation(user);

    const one = await ask(h, user, conv.id, BOILER_QUESTION);
    expect(first(one.events, 'done')).toBeDefined();
    const before = (await fakeChats()).length;
    const two = await ask(h, user, conv.id, 'When should the apple trees be pruned while dormant?');
    expect(first(two.events, 'done')).toBeDefined();

    const chats = await fakeChats();
    expect(chats).toHaveLength(before + 1);
    const messages = chats.at(-1)!.messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[1]!.content).toBe(BOILER_QUESTION);
    // The first answer cited both documents (the garden passage packs too: 0.127).
    expect(one.text).toMatch(/\[S1\].*\[S2\]/u);
    expect(messages[2]!.content).toBe(one.text.replaceAll(/ \[S\d+\]/gu, ''));
    expect(messages[2]!.content).not.toMatch(/\[S\d+\]/u);
    expect(
      parseSources(
        messages
          .slice(0, -1)
          .map((m) => m.content)
          .join('\n'),
      ),
    ).toEqual([]);
    expect(parseSources(messages[3]!.content)[0]!.title).toBe('Garden notes');

    const stored = await detail(user, conv.id);
    expect(stored.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
    expect(stored.title).toBe(BOILER_QUESTION);
  });
});

describe('abstention (SPECS section 1)', () => {
  it('answers "not found" with the nearest passages and never calls the model', async () => {
    const { user, owner } = await person('abstain');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    const before = (await fakeChats()).length;

    const r = await ask(h, user, conv.id, UNRELATED);
    expect(shape(r.events)).toEqual(['retrieval', 'abstain', 'done']);
    const abstain = first(r.events, 'abstain')!.data;
    expect(abstain).toMatchObject({ text: NOT_FOUND_ANSWER, reason: 'below_threshold' });
    expect(abstain.bestSimilarity).toBeLessThan(Number(process.env.RETRIEVAL_MIN_SIMILARITY));
    expect(abstain.nearest.map((s) => s.documentTitle)).toEqual(['Boiler manual']);
    expect(first(r.events, 'retrieval')!.data.sources).toEqual([]);
    expect(first(r.events, 'done')!.data).toMatchObject({
      usage: null,
      citations: [],
      dropped: [],
    });
    expect(await fakeChats()).toHaveLength(before);

    const answer = (await detail(user, conv.id)).messages[1]!;
    expect(answer).toMatchObject({ content: NOT_FOUND_ANSWER, status: 'DONE', abstained: true });
    const trace = await h.db.retrievalTrace.findUniqueOrThrow({ where: { messageId: answer.id } });
    expect(trace.abstainReason).toBe('below_threshold');
  });

  it('says `no_candidates` for an empty library', async () => {
    const { user } = await person('empty');
    const conv = await conversation(user);
    const r = await ask(h, user, conv.id, BOILER_QUESTION);
    expect(first(r.events, 'abstain')!.data).toMatchObject({
      reason: 'no_candidates',
      nearest: [],
    });
  });

  it('keeps an abstention out of the next prompt’s history', async () => {
    const { user, owner } = await person('abstain-history');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    await ask(h, user, conv.id, UNRELATED);
    await ask(h, user, conv.id, BOILER_QUESTION);
    expect((await fakeChats()).at(-1)!.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
});

describe('stop (SPECS #5)', () => {
  it('stores STOPPED with the text sent, the fake sees the abort, and a reload shows that one answer', async () => {
    const { user, owner } = await person('stop');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    await fakeScript({ tokenDelayMs: 40 });
    const before = (await fakeChats()).length;

    const r = await ask(h, user, conv.id, BOILER_QUESTION, { stopAfter: 3 });
    expect(r.stopped).toBe(true);
    const answerId = first(r.events, 'retrieval')!.data.answerId;

    const settled = await until(
      'the answer to leave STREAMING',
      () => h.db.message.findUniqueOrThrow({ where: { id: answerId } }),
      (m) => m.status !== 'STREAMING',
    );
    expect(settled.status).toBe('STOPPED');
    expect(settled.error).toBeNull();
    // The server may have written a token the client had not read yet; it
    // never stores text it did not send, nor the whole answer.
    expect(settled.content.startsWith(r.text)).toBe(true);
    expect(settled.content.length).toBeLessThan(
      'The boiler pressure gauge should read between 1 and 1.5 bar when the heating is cold [S1].'
        .length,
    );

    const chats = await until(
      'the fake model server to see the request close',
      fakeChats,
      (all) => all.length === before + 1 && all.at(-1)!.aborted,
    );
    expect(chats.at(-1)!.completed).toBe(false);

    const stored = await detail(user, conv.id);
    expect(stored.messages.map((m) => [m.role, m.status])).toEqual([
      ['USER', 'DONE'],
      ['ASSISTANT', 'STOPPED'],
    ]);
    // Reading it again generates nothing.
    expect(await fakeChats()).toHaveLength(before + 1);
    // A stopped half-answer is not history for the next question.
    await fakeScript(null);
    await ask(h, user, conv.id, BOILER_QUESTION);
    expect((await fakeChats()).at(-1)!.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
});

describe('one answer at a time', () => {
  it('is 409 while an answer is being written, before any stream starts', async () => {
    const { user, owner } = await person('busy');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    await fakeScript({ tokenDelayMs: 40 });

    let second: Awaited<ReturnType<typeof ask>> | undefined;
    await ask(h, user, conv.id, BOILER_QUESTION, {
      stopAfter: 2,
      onEvent: async (event) => {
        if (event.event === 'token' && second === undefined) {
          second = await ask(h, user, conv.id, 'And again?');
        }
      },
    });
    expect(second?.status).toBe(409);
    expect(second?.body).toMatchObject({ code: 'CONFLICT' });
    // The refused question was not stored.
    expect(await h.db.message.count({ where: { conversationId: conv.id, role: 'USER' } })).toBe(1);
  });

  it('lets exactly one of two questions sent at once through; the other is 409', async () => {
    const { user, owner } = await person('race');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    const replies = await Promise.all([
      ask(h, user, conv.id, BOILER_QUESTION),
      ask(h, user, conv.id, BOILER_QUESTION),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await h.db.message.count({ where: { conversationId: conv.id } })).toBe(2);
  });

  it('settles an answer a dead process left STREAMING, then answers', async () => {
    const { user, owner } = await person('orphan');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    const orphan = await h.db.message.create({
      data: {
        ownerId: user.id,
        conversationId: conv.id,
        role: 'ASSISTANT',
        content: '',
        status: 'STREAMING',
        model: 'qwen3:4b-instruct',
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const r = await ask(h, user, conv.id, BOILER_QUESTION);
    expect(first(r.events, 'done')).toBeDefined();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({
      status: 'FAILED',
      error: ORPHAN_ERROR,
    });
  });

  it('shows such an answer as FAILED when the conversation is read', async () => {
    const { user } = await person('orphan-read');
    const conv = await conversation(user);
    await h.db.message.create({
      data: {
        ownerId: user.id,
        conversationId: conv.id,
        role: 'ASSISTANT',
        content: '',
        status: 'STREAMING',
        model: 'qwen3:4b-instruct',
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const young = await h.db.message.create({
      data: {
        ownerId: user.id,
        conversationId: (await conversation(user)).id,
        role: 'ASSISTANT',
        content: '',
        status: 'STREAMING',
        model: 'qwen3:4b-instruct',
      },
    });
    expect((await detail(user, conv.id)).messages[0]).toMatchObject({
      status: 'FAILED',
      error: ORPHAN_ERROR,
    });
    // A young STREAMING row in another conversation is somebody's live answer: untouched.
    expect((await h.db.message.findUniqueOrThrow({ where: { id: young.id } })).status).toBe(
      'STREAMING',
    );
  });
});

describe('failures inside the stream', () => {
  it('keeps the partial text of an answer the model broke off, FAILED with a reason', async () => {
    const { user, owner } = await person('broken');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    await fakeScript({ failAfter: 6 });

    const r = await ask(h, user, conv.id, BOILER_QUESTION);
    expect(shape(r.events)).toEqual(['retrieval', 'token', 'error']);
    expect(first(r.events, 'error')!.data.code).toBe('failed');
    const answer = (await detail(user, conv.id)).messages[1]!;
    expect(answer.status).toBe('FAILED');
    expect(answer.error).toBe(first(r.events, 'error')!.data.message);
    expect(answer.content).toBe(r.text);
    expect(r.raw).not.toMatch(/fake: the model runner stopped/u);
  });

  it('keeps a citation’s words when its document is deleted mid-answer, with no chunk', async () => {
    const { user, owner } = await person('deleted');
    const doc = await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    await fakeScript({ tokenDelayMs: 20 });

    const r = await ask(h, user, conv.id, BOILER_QUESTION, {
      onEvent: async (event) => {
        if (event.event === 'retrieval') {
          expect((await call(h, 'DELETE', `/documents/${doc.id}`, { user })).status).toBe(204);
        }
      },
    });
    const done = first(r.events, 'done')!.data;
    expect(done.citations).toEqual([
      expect.objectContaining({
        marker: 1,
        chunkId: null,
        documentId: null,
        documentTitle: 'Boiler manual',
      }),
    ]);
    expect((await detail(user, conv.id)).messages[1]!.citations[0]!.quote).toMatch(
      /^The boiler pressure/u,
    );
  });

  it('says so when the conversation is deleted while its answer is written, storing nothing', async () => {
    const { user, owner } = await person('gone');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const conv = await conversation(user);
    await fakeScript({ tokenDelayMs: 20 });
    const r = await ask(h, user, conv.id, BOILER_QUESTION, {
      onEvent: async (event) => {
        if (event.event === 'retrieval') {
          expect((await call(h, 'DELETE', `/conversations/${conv.id}`, { user })).status).toBe(204);
        }
      },
    });
    expect(shape(r.events).at(-1)).toBe('error');
    expect(first(r.events, 'error')!.data.code).toBe('failed');
    expect(await h.db.message.count({ where: { conversationId: conv.id } })).toBe(0);
    expect(await h.db.retrievalTrace.count({ where: { ownerId: user.id } })).toBe(0);
  });
});

describe('isolation (SPECS #3)', () => {
  it('never puts another person’s canary in my candidates, prompt, answer, citations or trace', async () => {
    const alma = await person('alma-leak');
    const bruno = await person('bruno-leak');
    const brunoDoc = await addDocument(
      h.db,
      bruno.owner,
      'Cold room',
      `# Cold room\n\nThe cold room door code is ${CANARY}, and the compressor is serviced in March.`,
    );
    await addDocument(
      h.db,
      alma.owner,
      'Cold room log',
      '# Cold room log\n\nThe cold room was cleaned on Monday; ask the manager for the door code.',
    );
    const question = 'What is the cold room door code?';

    // Positive control: the canary is findable, by its owner, through this
    // exact path. Without this, "absent for Alma" could mean "absent for all".
    const brunoConv = await conversation(bruno.user);
    const control = await ask(h, bruno.user, brunoConv.id, question);
    expect(control.raw).toContain(CANARY);
    expect(JSON.stringify((await fakeChats()).at(-1)!.messages)).toContain(CANARY);

    const before = (await fakeChats()).length;
    const almaConv = await conversation(alma.user);
    const r = await ask(h, alma.user, almaConv.id, question);
    expect(first(r.events, 'done')).toBeDefined();
    expect(r.raw.length).toBeGreaterThan(0);
    expect(r.raw).not.toContain(CANARY);
    expect(
      first(r.events, 'retrieval')!.data.sources.every((s) => s.documentId !== brunoDoc.id),
    ).toBe(true);

    const prompts = (await fakeChats()).slice(before);
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0]!.messages)).not.toContain(CANARY);
    expect(parseSources(prompts[0]!.messages.at(-1)!.content).map((s) => s.title)).toEqual([
      'Cold room log',
    ]);

    const stored = await detail(alma.user, almaConv.id);
    expect(JSON.stringify(stored)).not.toContain(CANARY);
    const traces = await h.db.retrievalTrace.findMany({ where: { ownerId: alma.user.id } });
    expect(traces).toHaveLength(1);
    expect(JSON.stringify(traces)).not.toContain(CANARY);
    const candidateIds = (traces[0]!.candidates as { chunkId: string }[]).map((c) => c.chunkId);
    expect(candidateIds.length).toBeGreaterThan(0);
    expect(
      await h.db.chunk.count({
        where: { id: { in: candidateIds }, ownerId: { not: alma.user.id } },
      }),
    ).toBe(0);
    expect(candidateIds).not.toContain(brunoDoc.chunkIds[0]);
  });

  it('answers another person’s conversation with 404 and stores nothing', async () => {
    const alma = await person('alma-404');
    const bruno = await person('bruno-404');
    const conv = await conversation(alma.user);
    const r = await ask(h, bruno.user, conv.id, BOILER_QUESTION);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'NOT_FOUND' });
    expect((await call(h, 'GET', `/conversations/${conv.id}`, { user: bruno.user })).status).toBe(
      404,
    );
    expect(
      (await call(h, 'DELETE', `/conversations/${conv.id}`, { user: bruno.user })).status,
    ).toBe(404);
    expect(await h.db.message.count({ where: { conversationId: conv.id } })).toBe(0);
  });

  it('scopes a conversation over one collection to that collection', async () => {
    const { user, owner } = await person('scoped');
    await addDocument(h.db, owner, 'Boiler manual', BOILER);
    const other = await call<{ id: string }>(h, 'POST', '/collections', {
      user,
      body: { name: 'Other' },
    });
    await addDocument(h.db, { id: user.id, collectionId: other.body.id }, 'Boiler copy', BOILER);
    const conv = await conversation(user, { collectionId: other.body.id });
    const r = await ask(h, user, conv.id, BOILER_QUESTION);
    expect(first(r.events, 'retrieval')!.data.sources.map((s) => s.documentTitle)).toEqual([
      'Boiler copy',
    ]);
  });
});

describe('refused before the stream', () => {
  it('is 401 without a session, 400 for an empty or overlong question, 400 for a bad id', async () => {
    const { user } = await person('refused');
    const conv = await conversation(user);
    const anonymous = await call(h, 'POST', `/chat/${conv.id}/messages`, {
      user: null,
      body: { content: 'Hello?' },
    });
    expect(anonymous.status).toBe(401);
    for (const content of ['', '   \n ', 'x'.repeat(2_001), 42]) {
      const r = await ask(h, user, conv.id, content);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: 'INVALID', fields: ['content'] });
    }
    expect((await ask(h, user, 'not-an-id', 'Hello?')).status).toBe(400);
    expect(await h.db.message.count({ where: { conversationId: conv.id } })).toBe(0);
  });
});

describe('the chat budget', () => {
  it(`allows ${String(CHAT_BUDGET)} questions a minute per person, then 429, and limits nothing else`, async () => {
    const { user } = await person('chat-budget');
    const conv = await conversation(user);
    for (let i = 0; i < CHAT_BUDGET; i += 1) {
      const r = await ask(h, user, conv.id, `Question ${String(i)}?`);
      expect(r.status).toBe(200);
    }
    const over = await ask(h, user, conv.id, 'One too many?');
    expect(over.status).toBe(429);

    // Past the chat budget, the same person still reads and creates
    // conversations, and /health answers. Removing the chat `skipIf` makes
    // each of these the 429 above.
    expect((await call(h, 'GET', `/conversations/${conv.id}`, { user })).status).toBe(200);
    expect((await call(h, 'GET', '/conversations', { user })).status).toBe(200);
    expect((await call(h, 'POST', '/conversations', { user, body: {} })).status).toBe(201);
    expect((await call(h, 'GET', '/collections', { user })).status).toBe(200);
    expect((await call(h, 'GET', '/health')).status).not.toBe(429);

    const other = await person('chat-budget-other');
    expect((await ask(h, other.user, (await conversation(other.user)).id, 'Mine?')).status).toBe(
      200,
    );
  });
});
