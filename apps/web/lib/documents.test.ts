import type { DocumentView, IngestEvent } from '@rag/shared';
import { describe, expect, it } from 'vitest';

import { addUploaded, applyIngest, live, sizeWords, statusWords, uploadOutcome } from './documents';

const doc = (over: Partial<DocumentView> = {}): DocumentView => ({
  id: 'doc1',
  collectionId: 'col1',
  title: 'Boiler manual',
  filename: 'boiler.pdf',
  mime: 'application/pdf',
  bytes: 2048,
  status: 'QUEUED',
  error: null,
  pages: null,
  chunks: 0,
  createdAt: '2026-11-07T10:00:00.000Z',
  updatedAt: '2026-11-07T10:00:00.000Z',
  ...over,
});

const event = (over: Partial<IngestEvent> = {}): IngestEvent => ({
  documentId: 'doc1',
  collectionId: 'col1',
  status: 'PARSING',
  progress: null,
  error: null,
  at: '2026-11-07T10:00:01.000Z',
  ...over,
});

describe('statusWords', () => {
  it('pairs every state with a glyph and a word', () => {
    expect(statusWords('READY')).toEqual({
      glyph: '✓',
      word: 'Ready to ask about',
      detail: null,
      tone: 'ok',
    });
    expect(statusWords('FAILED', null, 'no text layer; OCR not supported')).toMatchObject({
      glyph: '⚠',
      detail: 'no text layer; OCR not supported',
      tone: 'danger',
    });
  });

  it('counts passages while indexing, in the singular when there is one', () => {
    expect(statusWords('EMBEDDING', { done: 3, total: 12 }).detail).toBe('3 of 12 passages');
    expect(statusWords('EMBEDDING', { done: 0, total: 1 }).detail).toBe('0 of 1 passage');
  });
});

describe('applyIngest', () => {
  const list = [live(doc())];

  it('moves a document through its states and reports when it settles', () => {
    const parsing = applyIngest(list, event(), 'col1');
    expect(parsing.documents[0]!.status).toBe('PARSING');
    expect(parsing.settled).toBeNull();
    const ready = applyIngest(
      parsing.documents,
      event({ status: 'READY', at: '2026-11-07T10:00:05.000Z' }),
      'col1',
    );
    expect(ready.settled?.status).toBe('READY');
  });

  it('keeps progress only while indexing', () => {
    const embedding = applyIngest(
      list,
      event({ status: 'EMBEDDING', progress: { done: 1, total: 4 } }),
      'col1',
    );
    expect(embedding.documents[0]!.progress).toEqual({ done: 1, total: 4 });
    const ready = applyIngest(
      embedding.documents,
      event({ status: 'READY', progress: { done: 4, total: 4 }, at: '2026-11-07T10:00:09.000Z' }),
      'col1',
    );
    expect(ready.documents[0]!.progress).toBeNull();
  });

  it('ignores another collection, flags a document it does not hold, and drops a stale event', () => {
    expect(applyIngest(list, event({ collectionId: 'col2' }), 'col1').documents).toBe(list);
    expect(applyIngest(list, event({ documentId: 'doc9' }), 'col1').unknown).toBe(true);
    const stale = applyIngest(list, event({ at: '2026-11-07T09:59:00.000Z' }), 'col1');
    expect(stale.documents).toBe(list);
  });
});

describe('addUploaded', () => {
  it('puts a new document first and never lists a duplicate twice', () => {
    const fresh = doc({ id: 'doc2' });
    const once = addUploaded([live(doc())], { document: fresh, duplicate: false }, 'col1');
    expect(once.map((d) => d.id)).toEqual(['doc2', 'doc1']);
    expect(addUploaded(once, { document: fresh, duplicate: true }, 'col1')).toBe(once);
  });

  it('does not list a duplicate that lives in another collection', () => {
    const elsewhere = doc({ id: 'doc3', collectionId: 'col2' });
    const list = [live(doc())];
    expect(addUploaded(list, { document: elsewhere, duplicate: true }, 'col1')).toBe(list);
  });
});

describe('uploadOutcome', () => {
  it('says added, already there (and where), or why it was refused', () => {
    expect(
      uploadOutcome('a.pdf', {
        ok: true,
        result: { document: doc(), duplicate: false },
        collectionName: null,
      }).text,
    ).toBe('a.pdf: added, reading it now.');
    expect(
      uploadOutcome('a.pdf', {
        ok: true,
        result: { document: doc(), duplicate: true },
        collectionName: 'Home',
      }).text,
    ).toBe('a.pdf: already in your library in “Home” as “Boiler manual”.');
    expect(uploadOutcome('a.pdf', { ok: false, message: 'That file is not a PDF.' })).toEqual({
      tone: 'danger',
      text: 'a.pdf: That file is not a PDF.',
    });
  });
});

describe('sizeWords', () => {
  it('uses binary units with one decimal under ten', () => {
    expect(sizeWords(1)).toBe('1 byte');
    expect(sizeWords(512)).toBe('512 bytes');
    expect(sizeWords(1024)).toBe('1 KB');
    expect(sizeWords(1536)).toBe('1.5 KB');
    expect(sizeWords(20 * 1024 * 1024)).toBe('20 MB');
  });
});
