/**
 * From a finished answer to stored citations: which sentence of each cited
 * source the answer leaned on, as an exact span of the chunk.
 *
 * The answer is in canonical form (what createMarkerStream emits), so a
 * marker is always `[S<n>]`. Answers are split into claims with the same unit
 * reader the chunker uses: sentences, list items and table rows, so a bullet
 * list is one claim per bullet rather than one run-on sentence. A marker that
 * opens a claim ("... is due. [S1] Next ...") belongs to the claim before it.
 *
 * The quote is the source unit (sentence, item, row) sharing the most
 * distinct content words with the claims that cite the source; on a tie, the
 * earlier one; when nothing is shared, the source's first unit. Its page is
 * the page the quote starts on, read from the chunk's `pageStarts`. It is lexical
 * on purpose: deterministic, explainable, and the eval (build step 8) measures
 * how often it lands on a gold span.
 */
import { codePointOffsets, unitsOf } from '@rag/chunker';

export interface PageStart {
  readonly page: number;
  readonly at: number;
}

/**
 * One stored chunk inside a source that retrieval merged from neighbours
 * (consecutive chunks of one document whose spans overlap or touch). The
 * source's text is the exact document text over their union, and each part
 * says where its chunk begins in it.
 */
export interface PackedPart {
  readonly chunkId: string;
  /** Code points from the start of the source's text to the chunk's first. */
  readonly at: number;
  /** The chunk's length in code points (`char_end - char_start`). */
  readonly length: number;
  readonly page: number | null;
  readonly pageStarts?: readonly PageStart[];
}

/** One source in the packed context, labelled `[S<marker>]` in the prompt. */
export interface PackedSource {
  readonly marker: number;
  readonly chunkId: string;
  readonly documentTitle: string;
  /** The chunk's first page; null for markdown and text. */
  readonly page: number | null;
  /** Later pages inside the chunk (the chunker's `pageStarts`); omit for one page. */
  readonly pageStarts?: readonly PageStart[];
  /** The chunk's text, exactly as stored (or the merged parts' union). */
  readonly text: string;
  /**
   * Set when the source is several neighbouring chunks merged: a quote is
   * then stored against the part it starts in, with offsets in that chunk.
   * `chunkId`, `page` and `pageStarts` above describe the first part.
   */
  readonly parts?: readonly PackedPart[];
}

/**
 * The chunk a quote [start, end) of a source belongs to, and the quote in
 * that chunk's own offsets. A quote is a whole unit, and retrieval only
 * merges chunks that begin and end on unit boundaries, so it fits one part;
 * when it does not (a unit the merged text reads differently), it is cut at
 * the end of the part it starts in, so the stored span is always the chunk's.
 */
export function partOf(
  source: PackedSource,
  start: number,
  end: number,
): { part: PackedPart; start: number; end: number } {
  const parts: readonly PackedPart[] = source.parts ?? [
    {
      chunkId: source.chunkId,
      at: 0,
      length: [...source.text].length,
      page: source.page,
      ...(source.pageStarts === undefined ? {} : { pageStarts: source.pageStarts }),
    },
  ];
  const holding = parts.filter((p) => p.at <= start && start < p.at + p.length);
  const part =
    holding.find((p) => end <= p.at + p.length) ?? holding.at(-1) ?? parts.at(-1) ?? parts[0]!;
  const from = Math.min(Math.max(start - part.at, 0), Math.max(part.length - 1, 0));
  return { part, start: from, end: Math.max(Math.min(end - part.at, part.length), from + 1) };
}

/** What a `citations` row stores. Offsets are code points within the chunk. */
export interface ResolvedCitation {
  readonly marker: number;
  readonly chunkId: string;
  readonly documentTitle: string;
  readonly page: number | null;
  readonly quote: string;
  readonly quoteStart: number;
  readonly quoteEnd: number;
}

export interface Claim {
  /** The claim without its markers, trimmed. */
  readonly text: string;
  /** Labels cited by it, in written order, without repeats. */
  readonly markers: readonly number[];
}

const CANONICAL = /\[S(\d{1,3})\]/gu;
const LEADING = /^(?:\[S\d{1,3}\]\s*)+/u;
const WORD = /[\p{L}\p{Nd}]+(?:[.,]\p{Nd}+)*/gu;
const STOP = new Set(
  'a an and are as at be been but by can do does for from had has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was we were what when where which who will with you your'.split(
    ' ',
  ),
);

const labels = (text: string) => [...text.matchAll(CANONICAL)].map((m) => Number(m[1]));
const unique = (values: readonly number[]) => values.filter((v, i) => values.indexOf(v) === i);

/** Remove canonical markers and the space before each. */
export function stripMarkers(text: string): string {
  return text.replace(/[ \t]*\[S\d{1,3}\]/gu, '');
}

/** The distinct content words of a text, lower-cased. */
export function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const [word] of text.normalize('NFC').toLowerCase().matchAll(WORD)) {
    if (!STOP.has(word) && (word.length > 1 || /\p{Nd}/u.test(word))) words.add(word);
  }
  return words;
}

/** The answer as claims, with a marker that opens a claim moved to the one before. */
export function claimsOf(answer: string): Claim[] {
  const claims: { text: string; markers: number[] }[] = [];
  for (const unit of unitsOf(answer, 'markdown')) {
    if (unit.kind === 'heading' || unit.kind === 'code') continue;
    let body = answer.slice(unit.start, unit.end);
    const lead = LEADING.exec(body)?.[0];
    if (lead !== undefined && claims.length > 0) {
      claims[claims.length - 1]!.markers.push(...labels(lead));
      body = body.slice(lead.length);
    }
    const text = stripMarkers(body).trim();
    if (text === '' && claims.length > 0) {
      claims[claims.length - 1]!.markers.push(...labels(body));
      continue;
    }
    claims.push({ text, markers: labels(body) });
  }
  return claims.map((claim) => ({ text: claim.text, markers: unique(claim.markers) }));
}

export interface Coverage {
  /** Claims of four or more words: the ones that should carry a source. */
  readonly claims: number;
  /** Of those, the ones with at least one marker. */
  readonly cited: number;
  /** cited / claims; null for an answer with no claims. */
  readonly ratio: number | null;
}

/** How much of the answer is sourced (SPECS: every factual sentence is). */
export function coverage(answer: string): Coverage {
  const claims = claimsOf(answer).filter((c) => (c.text.match(WORD) ?? []).length >= 4);
  const cited = claims.filter((c) => c.markers.length > 0).length;
  return {
    claims: claims.length,
    cited,
    ratio: claims.length === 0 ? null : cited / claims.length,
  };
}

export function resolveCitations(
  answer: string,
  sources: readonly PackedSource[],
): ResolvedCitation[] {
  const claims = claimsOf(answer);
  const order = unique(claims.flatMap((c) => c.markers));
  const byMarker = new Map(sources.map((s) => [s.marker, s]));
  const out: ResolvedCitation[] = [];
  for (const marker of order) {
    const source = byMarker.get(marker);
    if (source === undefined) continue;
    const said = new Set<string>();
    for (const claim of claims) {
      if (claim.markers.includes(marker)) for (const w of contentWords(claim.text)) said.add(w);
    }
    const units = unitsOf(source.text, 'markdown');
    const candidates = units.filter((u) => u.kind !== 'heading');
    const pool = candidates.length > 0 ? candidates : units;
    if (pool.length === 0) continue;
    let best = pool[0]!;
    let bestScore = 0;
    for (const unit of pool) {
      let score = 0;
      for (const w of contentWords(source.text.slice(unit.start, unit.end)))
        if (said.has(w)) score += 1;
      if (score > bestScore) {
        best = unit;
        bestScore = score;
      }
    }
    const points = codePointOffsets(source.text);
    const located = partOf(source, points(best.start), points(best.end));
    const { part } = located;
    // The page the quote itself starts on, not the chunk's first page.
    const page =
      (part.pageStarts ?? []).filter((s) => s.at <= located.start).at(-1)?.page ?? part.page;
    const sourcePoints = [...source.text];
    out.push({
      marker,
      chunkId: part.chunkId,
      documentTitle: source.documentTitle,
      page,
      quote: sourcePoints.slice(part.at + located.start, part.at + located.end).join(''),
      quoteStart: located.start,
      quoteEnd: located.end,
    });
  }
  return out;
}
