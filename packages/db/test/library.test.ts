/**
 * The library's guarantees, tried against the real database.
 *
 * Isolation first: every link between two owned rows is a composite foreign
 * key over (id, owner_id), so pointing at another person's row is refused by
 * the database whatever the application forgets. Then what a delete keeps,
 * then the uniques, then every CHECK. Each forbidden write is asserted refused
 * BY NAME, so a refusal for an unrelated reason cannot pass for the guarantee.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CHUNK_DOCUMENT_SAME_OWNER,
  CHUNK_EMBEDDING_MODEL,
  CHUNK_EMBEDDING_NONZERO,
  CHUNK_HEADING_PATH,
  CHUNK_ORD,
  CHUNK_ORD_UNIQUE,
  CHUNK_PAGES,
  CHUNK_SPAN,
  CHUNK_TEXT,
  CHUNK_TOKENS,
  CITATION_CHUNK_SAME_OWNER,
  CITATION_MARKER,
  CITATION_MARKER_UNIQUE,
  CITATION_MESSAGE_SAME_OWNER,
  CITATION_PAGE,
  CITATION_QUOTE,
  COLLECTION_NAME,
  COLLECTION_NAME_UNIQUE,
  CONVERSATION_COLLECTION_SAME_OWNER,
  CONVERSATION_TITLE,
  DOCUMENT_BYTES,
  DOCUMENT_COLLECTION_SAME_OWNER,
  DOCUMENT_ERROR,
  DOCUMENT_FILENAME,
  DOCUMENT_MIME,
  DOCUMENT_PAGES,
  DOCUMENT_SHA256,
  DOCUMENT_SHA256_UNIQUE,
  DOCUMENT_TITLE,
  MESSAGE_ANSWER_MODEL,
  MESSAGE_CONVERSATION_SAME_OWNER,
  MESSAGE_ERROR,
  MESSAGE_QUESTION,
  ONE_STREAMING_ANSWER,
  TRACE_CANDIDATES,
  TRACE_LATENCY,
  TRACE_MESSAGE_SAME_OWNER,
} from '../src/constraints';
import {
  db,
  documentData,
  insertChunk,
  names,
  newAnswer,
  newCollection,
  newConversation,
  newDocument,
  newUser,
  refused,
  removeCreatedUsers,
  unit,
} from './support';

/** Two people, each with a collection, a document, a chunk and an answer. */
let alma: string;
let bruno: string;
let almaShelf: string;
let brunoShelf: string;
let almaDoc: string;
let brunoDoc: string;
let almaChunk: string;
let brunoChunk: string;
let almaThread: string;
let brunoThread: string;
let almaAnswer: string;
let brunoAnswer: string;

beforeAll(async () => {
  alma = await newUser();
  bruno = await newUser();
  almaShelf = await newCollection(alma);
  brunoShelf = await newCollection(bruno);
  almaDoc = await newDocument(alma, almaShelf);
  brunoDoc = await newDocument(bruno, brunoShelf);
  almaChunk = await insertChunk({ ownerId: alma, documentId: almaDoc });
  brunoChunk = await insertChunk({ ownerId: bruno, documentId: brunoDoc });
  almaThread = await newConversation(alma, almaShelf);
  brunoThread = await newConversation(bruno, brunoShelf);
  almaAnswer = await newAnswer(alma, almaThread);
  brunoAnswer = await newAnswer(bruno, brunoThread);
});

afterAll(async () => {
  await removeCreatedUsers();
  await db.$disconnect();
});

const citation = (ownerId: string, messageId: string, chunkId: string | null, overrides = {}) =>
  db.citation.create({
    data: {
      ownerId,
      messageId,
      chunkId,
      marker: 1,
      documentTitle: 'Boiler manual',
      page: null,
      quote: 'serviced',
      quoteStart: 14,
      quoteEnd: 22,
      ...overrides,
    },
  });

describe('no row can point at another person’s row', () => {
  it('a document cannot go into someone else’s collection', async () => {
    const error = await refused(db.document.create({ data: documentData(alma, brunoShelf) }));
    expect(names(error, DOCUMENT_COLLECTION_SAME_OWNER)).toBe(true);
  });

  it('a chunk cannot belong to someone else’s document', async () => {
    const error = await refused(insertChunk({ ownerId: alma, documentId: brunoDoc, ord: 7 }));
    expect(names(error, CHUNK_DOCUMENT_SAME_OWNER)).toBe(true);
  });

  it('a conversation cannot be over someone else’s collection', async () => {
    const error = await refused(newConversation(alma, brunoShelf));
    expect(names(error, CONVERSATION_COLLECTION_SAME_OWNER)).toBe(true);
  });

  it('a message cannot go into someone else’s conversation', async () => {
    const error = await refused(newAnswer(alma, brunoThread));
    expect(names(error, MESSAGE_CONVERSATION_SAME_OWNER)).toBe(true);
  });

  it('a citation cannot name someone else’s chunk', async () => {
    // The leak this whole design exists to stop: an answer of Alma's citing
    // a passage of Bruno's.
    const error = await refused(citation(alma, almaAnswer, brunoChunk));
    expect(names(error, CITATION_CHUNK_SAME_OWNER)).toBe(true);
  });

  it('a citation cannot hang off someone else’s answer', async () => {
    const error = await refused(citation(alma, brunoAnswer, almaChunk));
    expect(names(error, CITATION_MESSAGE_SAME_OWNER)).toBe(true);
  });

  it('a retrieval trace cannot be filed under someone else’s answer', async () => {
    const error = await refused(
      db.retrievalTrace.create({
        data: {
          ownerId: alma,
          messageId: brunoAnswer,
          query: 'q',
          candidates: [],
          latencyMs: 1,
          embedModel: 'e',
          chatModel: 'c',
        },
      }),
    );
    expect(names(error, TRACE_MESSAGE_SAME_OWNER)).toBe(true);
  });

  it('the same writes are accepted for the right owner (the refusals are about ownership)', async () => {
    const answer = await newAnswer(alma, almaThread);
    await expect(citation(alma, answer, almaChunk)).resolves.toMatchObject({ chunkId: almaChunk });
  });
});

describe('what a delete keeps', () => {
  it('deleting a collection removes its documents and chunks, and keeps its conversations', async () => {
    const shelf = await newCollection(alma);
    const doc = await newDocument(alma, shelf);
    await insertChunk({ ownerId: alma, documentId: doc });
    const thread = await newConversation(alma, shelf);
    const answer = await newAnswer(alma, thread);

    await db.collection.delete({ where: { id: shelf } });

    expect(await db.document.count({ where: { id: doc } })).toBe(0);
    expect(await db.chunk.count({ where: { documentId: doc } })).toBe(0);
    // Only the link is cleared: the owner stays, and so do the answers.
    expect(await db.conversation.findUnique({ where: { id: thread } })).toMatchObject({
      ownerId: alma,
      collectionId: null,
    });
    expect(await db.message.count({ where: { id: answer } })).toBe(1);
  });

  it('deleting a document keeps every citation of it, with what it quoted', async () => {
    const doc = await newDocument(alma, almaShelf);
    const chunk = await insertChunk({ ownerId: alma, documentId: doc });
    const answer = await newAnswer(alma, almaThread);
    const cited = await citation(alma, answer, chunk);

    await db.document.delete({ where: { id: doc } });

    expect(await db.citation.findUnique({ where: { id: cited.id } })).toMatchObject({
      ownerId: alma,
      chunkId: null,
      documentTitle: 'Boiler manual',
      quote: 'serviced',
    });
  });

  it('deleting one person removes everything of theirs and nothing of anyone else’s', async () => {
    const leaving = await newUser();
    const shelf = await newCollection(leaving);
    const doc = await newDocument(leaving, shelf);
    await insertChunk({ ownerId: leaving, documentId: doc });
    await newAnswer(leaving, await newConversation(leaving, shelf));
    const before = await db.chunk.count({ where: { ownerId: { not: leaving } } });

    await db.user.delete({ where: { id: leaving } });

    for (const count of [
      db.collection.count({ where: { ownerId: leaving } }),
      db.document.count({ where: { ownerId: leaving } }),
      db.chunk.count({ where: { ownerId: leaving } }),
      db.conversation.count({ where: { ownerId: leaving } }),
      db.message.count({ where: { ownerId: leaving } }),
    ]) {
      expect(await count).toBe(0);
    }
    expect(await db.chunk.count({ where: { ownerId: { not: leaving } } })).toBe(before);
  });
});

describe('uniques', () => {
  it('the same bytes uploaded twice by one person are one document', async () => {
    const data = documentData(alma, almaShelf);
    await db.document.create({ data });
    const error = await refused(db.document.create({ data: { ...data, title: 'Again' } }));
    expect(names(error, DOCUMENT_SHA256_UNIQUE)).toBe(true);
  });

  it('the same bytes in two people’s libraries are two documents', async () => {
    const data = documentData(alma, almaShelf);
    await db.document.create({ data });
    await expect(
      db.document.create({ data: { ...data, ownerId: bruno, collectionId: brunoShelf } }),
    ).resolves.toBeDefined();
  });

  it('one person cannot have two collections of one name; two people can', async () => {
    const name = `Taxes ${String(Date.now())}`;
    await newCollection(alma, name);
    expect(names(await refused(newCollection(alma, name)), COLLECTION_NAME_UNIQUE)).toBe(true);
    await expect(newCollection(bruno, name)).resolves.toBeDefined();
  });

  it('a chunk position is taken once per document', async () => {
    const doc = await newDocument(alma, almaShelf);
    await insertChunk({ ownerId: alma, documentId: doc, ord: 0 });
    const error = await refused(insertChunk({ ownerId: alma, documentId: doc, ord: 0 }));
    expect(names(error, CHUNK_ORD_UNIQUE)).toBe(true);
  });

  it('an answer cites each marker once', async () => {
    const answer = await newAnswer(alma, almaThread);
    await citation(alma, answer, almaChunk);
    const error = await refused(citation(alma, answer, almaChunk));
    expect(names(error, CITATION_MARKER_UNIQUE)).toBe(true);
  });

  it('a conversation streams one answer at a time, and the next once that one ends', async () => {
    const thread = await newConversation(alma, almaShelf);
    const first = await newAnswer(alma, thread, 'STREAMING');
    // A reload or a second tab asking again while the first is in flight.
    const error = await refused(newAnswer(alma, thread, 'STREAMING'));
    expect(names(error, ONE_STREAMING_ANSWER)).toBe(true);
    // Finished answers do not count against it.
    await db.message.update({ where: { id: first }, data: { status: 'STOPPED' } });
    await expect(newAnswer(alma, thread, 'STREAMING')).resolves.toBeDefined();
    // Another conversation streams independently.
    await expect(
      newAnswer(alma, await newConversation(alma, almaShelf), 'STREAMING'),
    ).resolves.toBeDefined();
  });
});

describe('CHECKs: each malformed row is refused by name', () => {
  it.each([
    ['a blank name', '   ', COLLECTION_NAME],
    ['a name with padding', ' Taxes', COLLECTION_NAME],
    ['a name over 80 characters', 'x'.repeat(81), COLLECTION_NAME],
  ])('collection: %s', async (_, name, constraint) => {
    expect(names(await refused(newCollection(alma, name)), constraint)).toBe(true);
  });

  it.each([
    ['a type outside ACCEPTED_TYPES', { mime: 'text/html' }, DOCUMENT_MIME],
    ['zero bytes', { bytes: 0 }, DOCUMENT_BYTES],
    ['one byte over 20 MiB', { bytes: 20 * 1024 * 1024 + 1 }, DOCUMENT_BYTES],
    ['an uppercase sha256', { sha256: 'A'.repeat(64) }, DOCUMENT_SHA256],
    ['a short sha256', { sha256: 'a'.repeat(63) }, DOCUMENT_SHA256],
    ['FAILED with no reason', { status: 'FAILED' }, DOCUMENT_ERROR],
    ['a reason on a READY document', { status: 'READY', error: 'boom' }, DOCUMENT_ERROR],
    ['a blank reason', { status: 'FAILED', error: '  ' }, DOCUMENT_ERROR],
    ['pages on a markdown file', { pages: 3 }, DOCUMENT_PAGES],
    ['zero pages on a PDF', { mime: 'application/pdf', pages: 0 }, DOCUMENT_PAGES],
    ['a blank title', { title: '' }, DOCUMENT_TITLE],
    ['a filename with a slash', { filename: '../etc/passwd' }, DOCUMENT_FILENAME],
    ['a filename with a newline', { filename: 'a\nb.md' }, DOCUMENT_FILENAME],
  ])('document: %s', async (_, overrides, constraint) => {
    const error = await refused(
      db.document.create({ data: documentData(alma, almaShelf, overrides) }),
    );
    expect(names(error, constraint)).toBe(true);
  });

  it('document: a FAILED document with a reason, and a PDF with pages, are fine', async () => {
    await expect(
      db.document.create({
        data: documentData(alma, almaShelf, { status: 'FAILED', error: 'No text layer.' }),
      }),
    ).resolves.toBeDefined();
    await expect(
      db.document.create({
        data: documentData(alma, almaShelf, { mime: 'application/pdf', pages: 12 }),
      }),
    ).resolves.toBeDefined();
  });

  let ord = 100;
  it.each([
    ['a negative position', { ord: -1 }, CHUNK_ORD],
    ['blank text', { text: '  \n ' }, CHUNK_TEXT],
    ['a span that is not the text', { charStart: 10, charEnd: 11 }, CHUNK_SPAN],
    ['a negative start', { charStart: -1 }, CHUNK_SPAN],
    ['a page start without an end', { pageStart: 2, pageEnd: null }, CHUNK_PAGES],
    ['pages running backwards', { pageStart: 3, pageEnd: 2 }, CHUNK_PAGES],
    ['page zero', { pageStart: 0, pageEnd: 0 }, CHUNK_PAGES],
    ['zero tokens', { tokens: 0 }, CHUNK_TOKENS],
    ['a null heading path', { headingPath: null }, CHUNK_HEADING_PATH],
    ['a blank embedding model', { embeddingModel: ' ' }, CHUNK_EMBEDDING_MODEL],
    [
      'a zero embedding, whose cosine distance is NaN',
      { embedding: new Array<number>(1024).fill(0) },
      CHUNK_EMBEDDING_NONZERO,
    ],
  ])('chunk: %s', async (_, overrides, constraint) => {
    ord += 1;
    const error = await refused(
      insertChunk({ ownerId: alma, documentId: almaDoc, ord, ...overrides }),
    );
    expect(names(error, constraint)).toBe(true);
  });

  it('chunk: an embedding of the wrong width is refused by the column type', async () => {
    const error = await refused(
      insertChunk({ ownerId: alma, documentId: almaDoc, ord: 999, embedding: unit(3, 1023) }),
    );
    expect(String((error as Error).message)).toMatch(/expected 1024 dimensions/u);
  });

  it.each([
    ['a blank title', { title: ' ' }, CONVERSATION_TITLE],
    ['a title over 200 characters', { title: 'x'.repeat(201) }, CONVERSATION_TITLE],
  ])('conversation: %s', async (_, overrides, constraint) => {
    const error = await refused(db.conversation.create({ data: { ownerId: alma, ...overrides } }));
    expect(names(error, constraint)).toBe(true);
  });

  const question = { role: 'USER', status: 'DONE', content: 'Is it serviced?' } as const;
  it.each([
    ['a question still streaming', { ...question, status: 'STREAMING' }, MESSAGE_QUESTION],
    ['a question with a model', { ...question, model: 'qwen3:4b' }, MESSAGE_QUESTION],
    ['a blank question', { ...question, content: '   ' }, MESSAGE_QUESTION],
    [
      'a question over 2,000 characters',
      { ...question, content: 'x'.repeat(2001) },
      MESSAGE_QUESTION,
    ],
    [
      'an answer with no model',
      { role: 'ASSISTANT', status: 'DONE', content: 'Yes.' },
      MESSAGE_ANSWER_MODEL,
    ],
    [
      'a FAILED answer with no reason',
      { role: 'ASSISTANT', status: 'FAILED', content: '', model: 'qwen3:4b' },
      MESSAGE_ERROR,
    ],
    [
      'a reason on a finished answer',
      { role: 'ASSISTANT', status: 'DONE', content: 'Yes.', model: 'qwen3:4b', error: 'x' },
      MESSAGE_ERROR,
    ],
  ] as const)('message: %s', async (_, data, constraint) => {
    const error = await refused(
      db.message.create({ data: { ownerId: alma, conversationId: almaThread, ...data } }),
    );
    expect(names(error, constraint)).toBe(true);
  });

  it('message: a question and an answer that stopped mid-way are fine', async () => {
    await expect(
      db.message.create({ data: { ownerId: alma, conversationId: almaThread, ...question } }),
    ).resolves.toBeDefined();
    await expect(newAnswer(alma, almaThread, 'STOPPED')).resolves.toBeDefined();
  });

  let marker = 10;
  it.each([
    ['marker zero', { marker: 0 }, CITATION_MARKER],
    ['a quote that is not its span', { quoteStart: 0, quoteEnd: 3 }, CITATION_QUOTE],
    ['an empty span', { quote: '', quoteStart: 4, quoteEnd: 4 }, CITATION_QUOTE],
    ['page zero', { page: 0 }, CITATION_PAGE],
  ])('citation: %s', async (_, overrides, constraint) => {
    marker += 1;
    const error = await refused(citation(alma, almaAnswer, almaChunk, { marker, ...overrides }));
    expect(names(error, constraint)).toBe(true);
  });

  it.each([
    ['a negative latency', { latencyMs: -1 }, TRACE_LATENCY],
    ['candidates that are not a list', { candidates: { top: [] } }, TRACE_CANDIDATES],
  ])('retrieval trace: %s', async (_, overrides, constraint) => {
    const error = await refused(
      db.retrievalTrace.create({
        data: {
          ownerId: alma,
          messageId: await newAnswer(alma, almaThread),
          query: 'Is it serviced?',
          candidates: [],
          latencyMs: 12,
          embedModel: 'qwen3-embedding:0.6b',
          chatModel: 'qwen3:4b',
          ...overrides,
        },
      }),
    );
    expect(names(error, constraint)).toBe(true);
  });
});
