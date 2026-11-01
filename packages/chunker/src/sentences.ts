/**
 * Sentence boundaries, from ICU.
 *
 * `Intl.Segmenter` is the standard library's sentence breaker (Unicode
 * UAX #29). Node's ICU ships it without abbreviation suppressions, so it
 * breaks after "Dr." in "Dr. Smith"; the break is removed when the segment
 * ends in a known abbreviation, which is the same suppression list approach
 * ICU itself uses where it has the data. Everything else ("e.g.", "1.5 bar",
 * "8 p.m.") ICU already handles.
 */

/** A trimmed span of the input, as UTF-16 offsets [start, end). */
export interface Span {
  readonly start: number;
  readonly end: number;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Titles and short forms that are followed by a capitalised word mid-sentence. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'ft',
  'no',
  'nos',
  'vs',
  'fig',
  'figs',
  'vol',
  'p',
  'pp',
  'ch',
  'sec',
  'approx',
  'dept',
  'est',
  'inc',
  'ltd',
  'co',
  'corp',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

/** Whether `segment` ends in an abbreviation (or a single initial, as in "P. Adeyemi"). */
function endsInAbbreviation(segment: string): boolean {
  const last = /(?:^|[\s(])([\p{L}]+)\.\s*$/u.exec(segment)?.[1];
  if (last === undefined) return false;
  return ABBREVIATIONS.has(last.toLowerCase()) || (last.length === 1 && /\p{Lu}/u.test(last));
}

/** Trim a span to its first and last non-whitespace character; null when blank. */
export function trimSpan(text: string, start: number, end: number): Span | null {
  let s = start;
  let e = end;
  while (s < e && /\s/u.test(text[s]!)) s += 1;
  while (e > s && /\s/u.test(text[e - 1]!)) e -= 1;
  return s < e ? { start: s, end: e } : null;
}

/** The sentences of `text[start, end)`, trimmed, in order. */
export function sentenceSpans(text: string, start = 0, end = text.length): Span[] {
  const spans: Span[] = [];
  let open: number | null = null;
  // UAX #29 ends a sentence at every line feed, and PDFs and wrapped markdown
  // break lines mid-sentence. A same-length copy with spaces keeps offsets.
  const flat = text.slice(start, end).replace(/\n/gu, ' ');
  for (const { segment, index } of segmenter.segment(flat)) {
    const from = start + index;
    open ??= from;
    if (endsInAbbreviation(segment) && from + segment.length < end) continue;
    const span = trimSpan(text, open, from + segment.length);
    if (span !== null) spans.push(span);
    open = null;
  }
  if (open !== null) {
    const span = trimSpan(text, open, end);
    if (span !== null) spans.push(span);
  }
  return spans;
}
