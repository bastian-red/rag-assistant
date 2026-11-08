/**
 * The viewer's arithmetic: where a quote sits in its passage, and which page
 * it is on.
 *
 * Offsets are CODE POINTS of the chunk's text, as the citation resolver
 * stores them, never UTF-16 indexes: one emoji or a CJK supplementary
 * character before the quote would otherwise shift the highlight by one per
 * astral character. The split is done on `Array.from`, which iterates by
 * code point.
 */
import type { ChunkView } from '@rag/shared';

export interface Highlighted {
  readonly before: string;
  readonly quote: string;
  readonly after: string;
}

/**
 * The text cut around [from, to). Null when the span is missing or does not
 * fit the text, so the viewer shows the passage unmarked instead of a mark in
 * the wrong place.
 */
export function highlight(
  text: string,
  from: number | null,
  to: number | null,
): Highlighted | null {
  if (from === null || to === null) return null;
  const points = Array.from(text);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || to <= from || to > points.length) return null;
  return {
    before: points.slice(0, from).join(''),
    quote: points.slice(from, to).join(''),
    after: points.slice(to).join(''),
  };
}

/**
 * The page an offset of the chunk is on: the last later page starting at or
 * before it, else the chunk's first page (the chunker's own definition of
 * `pageStarts`). Null for markdown and text, which have no pages.
 */
export function pageAt(
  chunk: Pick<ChunkView, 'pageStart' | 'pageStarts'>,
  at: number,
): number | null {
  let page = chunk.pageStart;
  for (const start of chunk.pageStarts) if (start.at <= at) page = start.page;
  return page;
}

/** An offset from a query string: a non-negative integer, or null. */
export function offsetParam(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{1,7}$/u.test(value)) return null;
  return Number(value);
}

/** Where a citation chip goes: the passage, with the quote's span when known. */
export function passageHref(target: {
  readonly documentId: string;
  readonly chunkId: string;
  readonly from?: number;
  readonly to?: number;
}): string {
  const base = `/documents/${target.documentId}/passages/${target.chunkId}`;
  return target.from === undefined || target.to === undefined
    ? base
    : `${base}?from=${String(target.from)}&to=${String(target.to)}`;
}

/** The original file at a page. `#page=N` is the PDF open-parameters form every viewer reads. */
export function originalHref(documentId: string, page: number | null): string {
  const base = `/api/documents/${documentId}/file`;
  return page === null ? base : `${base}#page=${String(page)}`;
}
