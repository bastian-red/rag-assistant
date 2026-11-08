/**
 * The returned tickets: what the reference desk pulled for a question, drawn
 * before the answer and numbered with the number the answer cites them by
 * (docs/DESIGN.md, the signature).
 *
 * Pure, so the rules a reader relies on are unit tested:
 *
 * - a live answer's tickets are the `retrieval` sources, in marker order,
 *   from the moment they arrive; once the answer is `done` each one says
 *   whether the answer cited it, in a word as well as a mark;
 * - a stored answer keeps no retrieval list, only its citations, so its
 *   tickets are the cited passages (title, page, quote), labelled "Cited"
 *   rather than pretending to be everything that was found;
 * - a cited ticket links to the passage with the quote's span, so the mark
 *   lands on the quoted words; a deleted document's ticket says so and links
 *   nowhere.
 */
import type { CitationView, StreamSource } from '@rag/shared';

import { pageWords, type Turn } from './chat-state';
import { passageHref } from './passage';

export type TicketState = 'returned' | 'cited' | 'not-cited' | 'gone';

export interface Ticket {
  readonly marker: number;
  readonly title: string;
  /** "Warranty · page 4": the section and the page, whichever are known. */
  readonly where: string | null;
  /** The quoted words when cited, else the passage's opening. */
  readonly excerpt: string;
  readonly href: string | null;
  readonly state: TicketState;
}

export interface TicketRow {
  /** "Returned" (everything found), "Cited" (stored answers), "Nearest passages" (not found). */
  readonly label: string;
  /** "3 passages", "cited 2 of 3". */
  readonly count: string;
  readonly tickets: readonly Ticket[];
}

const passages = (n: number) => (n === 1 ? '1 passage' : `${String(n)} passages`);

function where(section: string | null, page: string | null): string | null {
  const parts = [section, page].filter((p): p is string => p !== null && p !== '');
  return parts.length === 0 ? null : parts.join(' · ');
}

function fromSource(
  source: StreamSource,
  citation: CitationView | undefined,
  done: boolean,
): Ticket {
  const cited = citation !== undefined;
  return {
    marker: source.marker,
    title: source.documentTitle,
    where: where(source.headingPath.at(-1) ?? null, pageWords(source.page, source.pageEnd)),
    excerpt: cited ? citation.quote : source.snippet,
    href:
      cited && citation.documentId !== null && citation.chunkId !== null
        ? passageHref({
            documentId: citation.documentId,
            chunkId: citation.chunkId,
            from: citation.quoteStart,
            to: citation.quoteEnd,
          })
        : passageHref(source),
    state: done ? (cited ? 'cited' : 'not-cited') : 'returned',
  };
}

function fromCitation(citation: CitationView): Ticket {
  const linked = citation.documentId !== null && citation.chunkId !== null;
  return {
    marker: citation.marker,
    title: citation.documentTitle,
    where: where(null, pageWords(citation.page)),
    excerpt: citation.quote,
    href: linked
      ? passageHref({
          documentId: citation.documentId!,
          chunkId: citation.chunkId!,
          from: citation.quoteStart,
          to: citation.quoteEnd,
        })
      : null,
    state: linked ? 'cited' : 'gone',
  };
}

/** The ticket row under a question, or null while nothing has come back. */
export function ticketsOf(turn: Turn): TicketRow | null {
  const byMarker = new Map(turn.citations.map((c) => [c.marker, c]));
  if (turn.sources.length > 0) {
    const done = turn.status === 'done';
    const tickets = [...turn.sources]
      .sort((a, b) => a.marker - b.marker)
      .map((source) => fromSource(source, byMarker.get(source.marker), done));
    const cited = tickets.filter((t) => t.state === 'cited').length;
    return {
      label: 'Returned',
      count: done
        ? `cited ${String(cited)} of ${String(tickets.length)}`
        : passages(tickets.length),
      tickets,
    };
  }
  if (turn.citations.length > 0) {
    const tickets = [...byMarker.values()].sort((a, b) => a.marker - b.marker).map(fromCitation);
    return { label: 'Cited', count: passages(tickets.length), tickets };
  }
  return null;
}

/** "Not found": the passages that came nearest, so the reader sees what was close. */
export function nearestTickets(nearest: readonly StreamSource[]): TicketRow | null {
  if (nearest.length === 0) return null;
  const tickets = [...nearest]
    .sort((a, b) => a.marker - b.marker)
    .map((source) => fromSource(source, undefined, false));
  return { label: 'Nearest passages', count: passages(tickets.length), tickets };
}

/** What a ticket's state says, in a mark and a word (never the colour alone). */
export const TICKET_STATE_WORDS: Record<
  TicketState,
  { readonly glyph: string; readonly word: string } | null
> = {
  returned: null,
  cited: { glyph: '✓', word: 'cited' },
  'not-cited': { glyph: '–', word: 'not cited' },
  gone: { glyph: '✕', word: 'document deleted' },
};
