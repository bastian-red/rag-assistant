import type { CitationView, StreamSource } from '@rag/shared';
import { describe, expect, it } from 'vitest';

import { startTurn, type Turn } from './chat-state';
import { nearestTickets, ticketsOf } from './tickets';

const source = (marker: number, over: Partial<StreamSource> = {}): StreamSource => ({
  marker,
  documentId: `doc${String(marker)}`,
  chunkId: `chunk${String(marker)}`,
  documentTitle: `Manual ${String(marker)}`,
  page: null,
  pageEnd: null,
  headingPath: [],
  snippet: `Opening ${String(marker)}`,
  ...over,
});

const citation = (marker: number, over: Partial<CitationView> = {}): CitationView => ({
  marker,
  chunkId: `chunk${String(marker)}`,
  documentId: `doc${String(marker)}`,
  documentTitle: `Manual ${String(marker)}`,
  page: null,
  quote: `Quote ${String(marker)}.`,
  quoteStart: 4,
  quoteEnd: 12,
  ...over,
});

const turn = (over: Partial<Turn>): Turn => ({
  ...startTurn('When?', 'a1', '2026-11-08T09:00:00.000Z'),
  ...over,
});

describe('ticketsOf, a live answer', () => {
  it('is nothing while the desk is still searching', () => {
    expect(ticketsOf(turn({ status: 'searching' }))).toBeNull();
  });

  it('returns every source in marker order, before any word, with its section and page', () => {
    const row = ticketsOf(
      turn({
        status: 'answering',
        sources: [
          source(2, { page: 4, pageEnd: 5, headingPath: ['Boiler', 'Pressure'] }),
          source(1, { headingPath: ['Warranty'] }),
        ],
      }),
    );
    expect(row?.label).toBe('Returned');
    expect(row?.count).toBe('2 passages');
    expect(row?.tickets.map((t) => [t.marker, t.where, t.state])).toEqual([
      [1, 'Warranty', 'returned'],
      [2, 'Pressure · pages 4–5', 'returned'],
    ]);
    expect(row?.tickets[0]?.href).toBe('/documents/doc1/passages/chunk1');
    expect(row?.tickets[0]?.excerpt).toBe('Opening 1');
  });

  it('says which tickets the finished answer cited, and links a cited one to its quote', () => {
    const row = ticketsOf(
      turn({
        status: 'done',
        sources: [source(1), source(2), source(3)],
        citations: [citation(2)],
      }),
    );
    expect(row?.count).toBe('cited 1 of 3');
    expect(row?.tickets.map((t) => t.state)).toEqual(['not-cited', 'cited', 'not-cited']);
    expect(row?.tickets[1]).toMatchObject({
      excerpt: 'Quote 2.',
      href: '/documents/doc2/passages/chunk2?from=4&to=12',
    });
  });

  it('never sets a quote under the section its passage started in', () => {
    // The radiators sentence comes from further down a passage that opens
    // under "Pressure" (seen in the demo): the ticket names its page only.
    const radiators = source(1, { page: 3, pageEnd: 4, headingPath: ['Boiler', 'Pressure'] });
    const row = ticketsOf(
      turn({
        status: 'done',
        sources: [radiators, source(2, { headingPath: ['Repairs'] })],
        citations: [citation(1, { page: 4, quote: 'Bleed the radiators each winter.' })],
      }),
    );
    expect(row?.tickets.map((t) => [t.excerpt, t.where])).toEqual([
      ['Bleed the radiators each winter.', 'page 4'],
      ['Opening 2', 'Repairs'],
    ]);
  });

  it('does not repeat the title as the section of a passage that opens under it', () => {
    const row = nearestTickets([
      source(1, { documentTitle: 'Flat lease', headingPath: ['Flat lease'] }),
      source(2, { documentTitle: 'Flat lease', headingPath: ['Flat lease'], page: 2 }),
      source(3, { documentTitle: 'Flat lease', headingPath: ['Flat lease', 'Repairs'] }),
    ]);
    expect(row?.tickets.map((t) => t.where)).toEqual([null, 'page 2', 'Repairs']);
  });

  it('keeps "returned" on a stopped or failed answer: it never finished citing', () => {
    for (const status of ['stopped', 'failed'] as const) {
      const row = ticketsOf(turn({ status, sources: [source(1)], citations: [citation(1)] }));
      expect(row?.tickets[0]?.state).toBe('returned');
    }
  });
});

describe('ticketsOf, a stored answer', () => {
  it('shows the cited passages, labelled as cited, one per marker', () => {
    const row = ticketsOf(
      turn({
        status: 'done',
        citations: [citation(3, { page: 2 }), citation(1), citation(3, { page: 2 })],
      }),
    );
    expect(row?.label).toBe('Cited');
    expect(row?.count).toBe('2 passages');
    expect(row?.tickets.map((t) => [t.marker, t.where, t.state])).toEqual([
      [1, null, 'cited'],
      [3, 'page 2', 'cited'],
    ]);
  });

  it('names a deleted document and links nowhere', () => {
    const row = ticketsOf(
      turn({ status: 'done', citations: [citation(1, { documentId: null, chunkId: null })] }),
    );
    expect(row?.tickets[0]).toMatchObject({ state: 'gone', href: null, title: 'Manual 1' });
  });
});

describe('nearestTickets', () => {
  it('lists what came nearest, or nothing', () => {
    expect(nearestTickets([])).toBeNull();
    const row = nearestTickets([source(2), source(1)]);
    expect(row?.label).toBe('Nearest passages');
    expect(row?.tickets.map((t) => t.marker)).toEqual([1, 2]);
  });
});
