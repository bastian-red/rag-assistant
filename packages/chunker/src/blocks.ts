/**
 * A document as an ordered list of units: the pieces the packer never cuts
 * when it can avoid it.
 *
 * A unit is a heading, a sentence of a paragraph, a list item, a table row or
 * a line of a fenced code block. Every non-whitespace character of the text
 * belongs to exactly one unit, so a chunk built from whole units is always a
 * span of the source, and the text between two units is only whitespace.
 *
 * Markdown is read structurally (ATX headings, fences, tables, lists).
 * Plain text and PDF text have no markup, so a heading is recognised by
 * shape: a one-line block of at most eight words with a letter in it and no
 * sentence punctuation at the end, 80 characters at most. A running page header ("Page 3") passes
 * that test too; it costs a wrong entry in a heading path, never lost text.
 */
import { sentenceSpans, trimSpan } from './sentences';

export type Format = 'markdown' | 'text';

export type UnitKind = 'heading' | 'sentence' | 'item' | 'row' | 'code';

/** A unit as UTF-16 offsets [start, end) into the normalised text. */
export interface Unit {
  readonly kind: UnitKind;
  readonly start: number;
  readonly end: number;
  /** Headings only: 1 for `#` (and every plain-text heading) to 6. */
  readonly level?: number;
  /** Headings only: the heading's words, without the markup. */
  readonly title?: string;
}

interface Line {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const TABLE = /^\s*\|/u;
const LIST = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/u;

const MAX_HEADING_WORDS = 8;
/** A plain-text heading is short; a long one-line block is a sentence. */
const MAX_TEXT_HEADING_CHARS = 80;
/** A markdown heading longer than this is a paragraph someone marked up. */
export const MAX_HEADING_CHARS = 120;

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const part of text.split('\n')) {
    lines.push({ text: part, start, end: start + part.length });
    start += part.length + 1;
  }
  return lines;
}

const blank = (line: Line) => line.text.trim() === '';

function atx(line: Line): { level: number; title: string } | null {
  const match = ATX.exec(line.text);
  if (match === null || match[2]!.trim() === '' || match[2]!.length > MAX_HEADING_CHARS)
    return null;
  return { level: match[1]!.length, title: match[2]!.trim() };
}

/** Whether a one-line plain-text block reads as a heading. */
export function looksLikeHeading(line: string): boolean {
  const words = line.trim().split(/\s+/u);
  return (
    words.length <= MAX_HEADING_WORDS &&
    line.trim().length <= MAX_TEXT_HEADING_CHARS &&
    /\p{L}/u.test(line) &&
    !/[.!?:;,]$/u.test(line.trim()) &&
    !LIST.test(line)
  );
}

export function unitsOf(text: string, format: Format): Unit[] {
  const markdown = format === 'markdown';
  const lines = linesOf(text);
  const units: Unit[] = [];

  /** A line that starts a block of its own, ending any paragraph or item. */
  const startsBlock = (line: Line) =>
    LIST.test(line.text) ||
    (markdown && (atx(line) !== null || FENCE.test(line.text) || TABLE.test(line.text)));

  const push = (kind: UnitKind, start: number, end: number) => {
    const span = trimSpan(text, start, end);
    if (span !== null) units.push({ kind, ...span });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }

    const fence = markdown ? FENCE.exec(line.text) : null;
    if (fence !== null) {
      // Up to and including the closing fence, or to the end of the text.
      const marker = fence[1]!;
      const closes = new RegExp(
        `^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`,
        'u',
      );
      push('code', line.start, line.end);
      i += 1;
      while (i < lines.length) {
        const inner = lines[i]!;
        push('code', inner.start, inner.end);
        i += 1;
        if (closes.test(inner.text)) break;
      }
      continue;
    }

    const heading = markdown ? atx(line) : null;
    if (heading !== null) {
      const span = trimSpan(text, line.start, line.end)!;
      units.push({ kind: 'heading', ...span, ...heading });
      i += 1;
      continue;
    }

    if (markdown && TABLE.test(line.text)) {
      push('row', line.start, line.end);
      i += 1;
      continue;
    }

    // A list item, or a paragraph: everything up to a blank line or a block.
    let j = i + 1;
    while (j < lines.length && !blank(lines[j]!) && !startsBlock(lines[j]!)) j += 1;
    const start = line.start;
    const end = lines[j - 1]!.end;
    if (LIST.test(line.text)) {
      push('item', start, end);
    } else if (!markdown && j === i + 1 && looksLikeHeading(line.text)) {
      const span = trimSpan(text, start, end)!;
      units.push({ kind: 'heading', ...span, level: 1, title: line.text.trim() });
    } else {
      for (const span of sentenceSpans(text, start, end)) units.push({ kind: 'sentence', ...span });
    }
    i = j;
  }
  return units;
}
