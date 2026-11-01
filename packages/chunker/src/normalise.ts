/**
 * The one text every offset refers to.
 *
 * A chunk's span, a citation's quote and the viewer's highlight are all
 * offsets into the NORMALISED text of a document, so normalisation runs
 * exactly once, here, and is idempotent (`normalise(normalise(x)) ===
 * normalise(x)`, property-tested). What it does, in order:
 *
 *  1. drops a leading byte-order mark;
 *  2. turns CRLF and lone CR into LF;
 *  3. turns tabs and the Unicode spaces (no-break, thin, ideographic...) into
 *     a plain space;
 *  4. drops what renders as nothing: soft hyphens, zero-width characters,
 *     and every control character except the newline;
 *  5. composes to NFC, so "é" is one code point however it was typed. This
 *     runs AFTER step 4: an "e", a zero-width space and a combining accent
 *     only compose once the space is gone, and composing first would leave a
 *     text that a second pass changes (normalise would not be idempotent);
 *  6. strips spaces at the end of each line;
 *  7. collapses three or more newlines into one blank line;
 *  8. trims blank lines at both ends.
 *
 * Runs of spaces inside a line are kept: a table aligned with spaces is still
 * aligned, and the text stays recognisably the file the reader uploaded.
 */

const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/gu;
// C0 except \n, DEL, C1.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu;
const SPACES = /[\t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu;

export function normalise(raw: string): string {
  return raw
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(SPACES, ' ')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .normalize('NFC')
    .replace(/ +$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+|\n+$/gu, '');
}

/** One page's place in the joined text, as UTF-16 offsets [start, end). */
export interface PageSpan {
  /** 1-based. */
  readonly page: number;
  readonly start: number;
  readonly end: number;
}

export interface PagedText {
  readonly text: string;
  readonly pages: readonly PageSpan[];
}

/** What separates two pages in the joined text: a blank line. */
export const PAGE_BREAK = '\n\n';

/**
 * Normalise each page of a PDF and join them with a blank line, recording
 * where each page sits. An empty page (a scan, a blank sheet) keeps its
 * number with an empty span, so page numbers after it stay right.
 */
export function assemblePages(pages: readonly string[]): PagedText {
  const spans: PageSpan[] = [];
  let text = '';
  pages.forEach((raw, index) => {
    const body = normalise(raw);
    if (body !== '' && text !== '') text += PAGE_BREAK;
    const start = text.length;
    text += body;
    spans.push({ page: index + 1, start, end: text.length });
  });
  return { text, pages: spans };
}

/**
 * The page holding UTF-16 offset `at`, or null for text with no pages.
 *
 * Asked only about a character of a chunk, never the whitespace of a page
 * break, so the answer is the last page starting at or before `at`. An empty
 * page starts exactly where the next page's text does (it adds nothing to the
 * text), so taking the LAST such page skips it.
 */
export function pageAt(pages: readonly PageSpan[], at: number): number | null {
  if (pages.length === 0) return null;
  let found: number | null = null;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid]!.start <= at) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found === null ? pages[0]!.page : pages[found]!.page;
}
