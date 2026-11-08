/**
 * A stored passage as a reader sees it: headings as headings, paragraphs
 * reflowed, list items as a list, tables and code kept as set, and the quoted
 * span marked on exactly the characters the citation names.
 *
 * The structure is the chunker's own (`unitsOf`, the parser that cut the
 * passage in the first place), so the viewer and the index cannot disagree
 * about where a heading or a table row is. Units are UTF-16 offsets; the
 * citation's span is in CODE POINTS, so it is converted once, here.
 *
 * Only markdown has markup. A PDF's or a text file's passage is reflowed into
 * paragraphs and list items and nothing is promoted to a heading: a shape
 * guess ("a short line") would turn a running header or a table cell into a
 * heading the document never had.
 *
 * Whitespace between units is dropped (the chunker guarantees it is only
 * whitespace), and a hard line break inside a sentence becomes a space, which
 * is the reflow. A mark that crosses blocks is cut into one piece per block.
 */
import { unitsOf, utf16Offset, type Unit } from '@rag/chunker';
import type { ChunkView } from '@rag/shared';

export interface Piece {
  readonly text: string;
  readonly marked: boolean;
}

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly pieces: readonly Piece[] }
  | { readonly kind: 'paragraph'; readonly pieces: readonly Piece[] }
  | { readonly kind: 'list'; readonly items: readonly (readonly Piece[])[] }
  | { readonly kind: 'table' | 'code'; readonly pieces: readonly Piece[] };

export type PassageFormat = 'markdown' | 'text';

interface Span {
  readonly from: number;
  readonly to: number;
}

const ATX_PREFIX = /^ {0,3}#{1,6}[ \t]+/u;
const ATX_SUFFIX = /[ \t]+#+[ \t]*$/u;
const BULLET = /^\s*[-*+][ \t]+/u;
const BLANK_LINE = /\n[ \t]*\n/u;

/** [start, end) of `text` cut at the mark, each part flagged, `clean` applied to each. */
function cut(
  text: string,
  start: number,
  end: number,
  mark: Span | null,
  clean: (part: string) => string,
): Piece[] {
  const bounds = [start, end];
  if (mark !== null) {
    if (mark.from > start && mark.from < end) bounds.push(mark.from);
    if (mark.to > start && mark.to < end) bounds.push(mark.to);
  }
  bounds.sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const a = bounds[i]!;
    const b = bounds[i + 1]!;
    if (a === b) continue;
    pieces.push({
      text: clean(text.slice(a, b)),
      marked: mark !== null && a >= mark.from && b <= mark.to,
    });
  }
  return pieces;
}

/** Adjacent pieces with the same flag become one, so a sentence is one text node. */
function merge(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.text === '') continue;
    const last = out.at(-1);
    if (last !== undefined && last.marked === piece.marked) {
      out[out.length - 1] = { text: last.text + piece.text, marked: last.marked };
    } else out.push(piece);
  }
  return out;
}

const reflow = (part: string) => part.replace(/[ \t]*\n[ \t]*/gu, ' ');
const asSet = (part: string) => part;

/** The gap between two units of one block, as one space, marked when the mark spans it. */
function gap(prev: Unit, next: Unit, mark: Span | null): Piece {
  return { text: ' ', marked: mark !== null && mark.from <= prev.end && mark.to >= next.start };
}

/** The pieces of a heading line without its `#`s, the mark kept on the words it covers. */
function headingPieces(text: string, unit: Unit, mark: Span | null): Piece[] {
  const line = text.slice(unit.start, unit.end);
  const lead = ATX_PREFIX.exec(line)?.[0].length ?? 0;
  const tail = ATX_SUFFIX.exec(line.slice(lead))?.[0].length ?? 0;
  return merge(cut(text, unit.start + lead, unit.end - tail, mark, asSet));
}

/** A list item's pieces without its bullet; a number ("1.") is kept, it is content. */
function itemPieces(text: string, unit: Unit, mark: Span | null): Piece[] {
  const bullet = BULLET.exec(text.slice(unit.start, unit.end))?.[0].length ?? 0;
  return merge(cut(text, unit.start + bullet, unit.end, mark, reflow));
}

export function passageBlocks(
  text: string,
  format: PassageFormat,
  /** [from, to) in code points of `text`, or null for an unmarked passage. */
  quote: Span | null,
): Block[] {
  const mark =
    quote === null
      ? null
      : { from: utf16Offset(text, quote.from), to: utf16Offset(text, quote.to) };
  const units = unitsOf(text, format);
  const blocks: Block[] = [];
  let i = 0;
  while (i < units.length) {
    const unit = units[i]!;
    if (unit.kind === 'heading' && format === 'markdown') {
      blocks.push({
        kind: 'heading',
        level: unit.level ?? 1,
        pieces: headingPieces(text, unit, mark),
      });
      i += 1;
      continue;
    }
    if (unit.kind === 'item') {
      const items: Piece[][] = [];
      while (i < units.length && units[i]!.kind === 'item') {
        items.push(itemPieces(text, units[i]!, mark));
        i += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    if (unit.kind === 'row' || unit.kind === 'code') {
      // Rows and code lines are kept as set, newlines and all.
      const kind = unit.kind === 'row' ? 'table' : 'code';
      let j = i;
      while (j + 1 < units.length && units[j + 1]!.kind === unit.kind) j += 1;
      blocks.push({ kind, pieces: merge(cut(text, unit.start, units[j]!.end, mark, asSet)) });
      i = j + 1;
      continue;
    }
    // Sentences (and, outside markdown, short lines the chunker took for
    // headings) up to a blank line or another kind of unit: one paragraph.
    const pieces: Piece[] = [];
    let j = i;
    for (;;) {
      const current = units[j]!;
      pieces.push(...cut(text, current.start, current.end, mark, reflow));
      const next = units[j + 1];
      const prose = (u: Unit) =>
        u.kind === 'sentence' || (u.kind === 'heading' && format !== 'markdown');
      if (
        next === undefined ||
        !prose(next) ||
        BLANK_LINE.test(text.slice(current.end, next.start))
      )
        break;
      pieces.push(gap(current, next, mark));
      j += 1;
    }
    blocks.push({ kind: 'paragraph', pieces: merge(pieces) });
    i = j + 1;
  }
  return blocks;
}

/** The format a document's passages are read in. PDF text has no markup. */
export function passageFormat(mime: string): PassageFormat {
  return mime === 'text/markdown' ? 'markdown' : 'text';
}

/**
 * The section a quote sits in: the last heading of the passage that opens
 * before the quote, else the deepest heading the passage started under. A
 * passage often runs across a heading, so the chunk's own `headingPath` (the
 * section it STARTED in) can name the wrong one. Null when nothing heads it.
 */
export function quoteSection(
  chunk: Pick<ChunkView, 'text' | 'headingPath'>,
  format: PassageFormat,
  /** Where the quote starts, in code points of the chunk's text. */
  at: number,
): string | null {
  let section = chunk.headingPath.at(-1) ?? null;
  if (format !== 'markdown') return section;
  const start = utf16Offset(chunk.text, at);
  for (const unit of unitsOf(chunk.text, 'markdown')) {
    if (unit.start > start) break;
    if (unit.kind === 'heading' && unit.title !== undefined) section = unit.title;
  }
  return section;
}
