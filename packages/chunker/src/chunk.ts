/**
 * Units packed into retrieval chunks.
 *
 * The rules, each held by a property test in chunk.test.ts:
 *
 *  - A chunk is a span of the normalised text: `text` is exactly the source
 *    between `charStart` and `charEnd`, which are CODE POINT offsets (what
 *    Postgres `char_length` and `substring` count; see offsets.ts).
 *  - Chunks are built from whole units, so a chunk starts and ends on a
 *    sentence, item, row or line boundary. Only a unit larger than the target
 *    is cut, to the room left in the chunk, at whitespace, and a single word
 *    larger than that between code points.
 *  - A chunk aims at `targetTokens` and never exceeds `maxTokens`.
 *  - Consecutive chunks inside a section share up to `overlapTokens` of
 *    whole units, so a fact that straddles a boundary is whole in one of
 *    them. There is no overlap across a heading: the new section starts clean.
 *  - A heading opens a new chunk once the current one holds `minTokens`, and
 *    a chunk never ends on a heading (the heading moves forward to the text
 *    it heads). When heading and first unit together exceed `maxTokens`, the
 *    unit is cut rather than the heading left alone; only headings that by
 *    themselves leave under MIN_CUT_TOKENS of room become a chunk alone.
 *  - A trailing chunk under `minTokens` is folded into the one before it when
 *    the result still fits `maxTokens`.
 *  - Joined and with the overlap removed, the chunks are the source: what
 *    lies between two chunks is only whitespace.
 */
import { unitsOf, type Format, type Unit } from './blocks';
import { assemblePages, normalise, pageAt, type PageSpan } from './normalise';
import { codePointOffsets } from './offsets';
import { TokenMeter, estimateTokens } from './tokens';

export interface ChunkOptions {
  readonly targetTokens: number;
  readonly maxTokens: number;
  readonly overlapTokens: number;
  readonly minTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = Object.freeze({
  targetTokens: 400,
  maxTokens: 512,
  overlapTokens: 60,
  minTokens: 100,
});

export type ChunkInput =
  | { readonly format: Format; readonly text: string }
  | { readonly format: 'pdf'; readonly pages: readonly string[] };

export interface Chunk {
  /** Position in the document, from 0, gap-free. */
  readonly ord: number;
  readonly text: string;
  /** [charStart, charEnd) in code points of `ChunkedDocument.text`. */
  readonly charStart: number;
  readonly charEnd: number;
  /** 1-based page range; null for markdown and text. */
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  /**
   * Where each later page begins inside the chunk, as code-point offsets from
   * the chunk's start; empty for a chunk on one page and for markdown and
   * text. A quote at offset q is on the last page starting at or before q, or
   * on `pageStart`.
   */
  readonly pageStarts: readonly { readonly page: number; readonly at: number }[];
  /**
   * The headings the chunk's first body unit sits under, outermost first. A
   * chunk opening with "# Guide" then "## Setup" is filed under both.
   */
  readonly headingPath: readonly string[];
  /** `estimateTokens(text)`. */
  readonly tokens: number;
}

export interface ChunkedDocument {
  /** The normalised text every offset refers to. */
  readonly text: string;
  /** Page count for a PDF; null otherwise. */
  readonly pageCount: number | null;
  readonly chunks: readonly Chunk[];
}

interface Piece {
  readonly kind: Unit['kind'];
  readonly start: number;
  readonly end: number;
  readonly tokens: number;
  readonly path: readonly string[];
}

function checkOptions(o: ChunkOptions): void {
  const whole = [o.targetTokens, o.maxTokens, o.overlapTokens, o.minTokens];
  if (!whole.every((n) => Number.isInteger(n) && n >= 0) || o.targetTokens < MIN_CUT_TOKENS) {
    throw new RangeError(
      `chunk options must be whole numbers, with a target of at least ${MIN_CUT_TOKENS}`,
    );
  }
  if (o.targetTokens > o.maxTokens) throw new RangeError('targetTokens must not exceed maxTokens');
  if (o.overlapTokens >= o.targetTokens)
    throw new RangeError('overlapTokens must be under targetTokens');
  if (o.minTokens > o.targetTokens) throw new RangeError('minTokens must not exceed targetTokens');
}

/**
 * The first piece of `text[from, end)` that fits `limit` tokens: up to the
 * last whitespace that fits, or mid-word (between code points) when one word
 * alone is over the limit. Trimmed; null when only whitespace is left.
 */
export function firstPiece(
  text: string,
  from: number,
  end: number,
  limit: number,
): { start: number; end: number } | null {
  let start = from;
  while (start < end && /\s/u.test(text[start]!)) start += 1;
  if (start >= end) return null;
  const meter = new TokenMeter();
  let at = start;
  let lastSpace = -1;
  let cut = end;
  while (at < end) {
    const character = String.fromCodePoint(text.codePointAt(at)!);
    if (/\s/u.test(character)) lastSpace = at;
    meter.add(character);
    if (meter.tokens > limit) {
      cut = lastSpace > start ? lastSpace : at;
      // A single code point over the limit cannot be cut; it goes alone.
      if (cut === start) cut = start + character.length;
      break;
    }
    at += character.length;
  }
  while (cut > start && /\s/u.test(text[cut - 1]!)) cut -= 1;
  return { start, end: cut };
}

/** All of `text[start, end)` as pieces of at most `limit` tokens (see firstPiece). */
export function splitSpan(
  text: string,
  start: number,
  end: number,
  limit: number,
): { start: number; end: number }[] {
  const pieces: { start: number; end: number }[] = [];
  for (let piece = firstPiece(text, start, end, limit); piece !== null;) {
    pieces.push(piece);
    piece = firstPiece(text, piece.end, end, limit);
  }
  return pieces;
}

/**
 * Units with their token cost and the headings they sit under. A "heading"
 * over the target is not one anybody navigates by: it is packed as body text
 * and kept out of the heading path.
 */
function piecesOf(text: string, units: readonly Unit[], options: ChunkOptions): Piece[] {
  const stack: { level: number; title: string }[] = [];
  return units.map((unit) => {
    const tokens = estimateTokens(text.slice(unit.start, unit.end));
    const heading = unit.kind === 'heading' && tokens <= options.targetTokens;
    if (heading) {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= unit.level!) stack.pop();
      stack.push({ level: unit.level!, title: unit.title! });
    }
    const kind = unit.kind === 'heading' && !heading ? 'sentence' : unit.kind;
    return { kind, start: unit.start, end: unit.end, tokens, path: stack.map((h) => h.title) };
  });
}

const sum = (pieces: readonly Piece[]) => pieces.reduce((total, piece) => total + piece.tokens, 0);

/**
 * The smallest room a cut piece is made for. One code point costs at most 4
 * tokens (a non-ASCII digit: (1.3 + 1.65) x 1.2, rounded up), so a cut into at
 * least this much room always fits and always makes progress.
 */
export const MIN_CUT_TOKENS = 8;

/**
 * Pack units into groups of pieces. The sum of a group's piece tokens bounds
 * the chunk's own estimate from above (the estimate is additive over
 * whitespace-separated text and each piece is rounded up), so keeping the sum
 * within the limits keeps the chunk within them.
 *
 * A unit over the target is cut while packing, to the room the current chunk
 * has left, so a heading keeps the start of a long paragraph beside it and a
 * chunk that has room is filled before a new one starts.
 */
function pack(text: string, units: readonly Piece[], options: ChunkOptions): Piece[][] {
  const groups: Piece[][] = [];
  let current: Piece[] = [];
  /** How many of `current`'s leading pieces are overlap from the last group. */
  let carried = 0;

  const onlyHeadings = () => current.every((p) => p.kind === 'heading');
  /** Headings with no text under them yet may stretch to the maximum. */
  const limit = () => (onlyHeadings() ? options.maxTokens : options.targetTokens);
  const room = () => limit() - sum(current);

  /** Emit `current`; start the next group with overlap, or with moved headings. */
  const flush = (overlap: boolean) => {
    // A chunk never ends on a heading: trailing headings move forward.
    let keep = current.length;
    while (keep > carried && current[keep - 1]!.kind === 'heading') keep -= 1;
    const body = current.slice(0, keep);
    const moved = current.slice(keep);
    const emitted = keep > carried;
    if (emitted) groups.push(body);
    current = moved;
    carried = 0;
    // No overlap into a new section, and never the whole of the last chunk.
    if (!overlap || !emitted || moved.length > 0) return;
    const tail: Piece[] = [];
    let tokens = 0;
    for (let k = body.length - 1; k >= 1; k -= 1) {
      const piece = body[k]!;
      if (piece.kind === 'heading' || tokens + piece.tokens > options.overlapTokens) break;
      tail.unshift(piece);
      tokens += piece.tokens;
    }
    current = tail;
    carried = tail.length;
  };

  /** Make at least `needed` tokens of room, in the least destructive order. */
  const makeRoom = (needed: number) => {
    if (current.length === 0 || room() >= needed) return;
    if (current.length > carried && !onlyHeadings()) flush(true);
    if (room() >= needed) return;
    if (carried > 0) {
      // The overlap leaves no room for what comes next: drop it.
      current = current.slice(carried);
      carried = 0;
    }
    if (current.length > 0 && room() < needed) {
      // Only headings, and the text will not fit beside them even at the maximum.
      groups.push(current);
      current = [];
    }
  };

  for (const unit of units) {
    if (unit.kind === 'heading') {
      // A new section starts clean: overlap from the last one is dropped...
      if (current.length === carried) {
        current = [];
        carried = 0;
      }
      // ...and it opens a new chunk once the current one has enough text.
      if (sum(current.slice(carried).filter((p) => p.kind !== 'heading')) >= options.minTokens) {
        flush(false);
      }
    }
    // A unit that fits a chunk goes in whole, unless it would leave a heading
    // alone: a chunk of nothing but a heading retrieves nothing, so the text
    // beside it is cut to fit instead.
    const besideHeadings = current.length > 0 && onlyHeadings() && unit.kind !== 'heading';
    if (unit.tokens <= options.targetTokens && !(besideHeadings && unit.tokens > room())) {
      makeRoom(unit.tokens);
      current.push(unit);
      continue;
    }
    // Too big for any chunk: cut it to the room there is, piece by piece.
    let from = unit.start;
    while (from < unit.end) {
      // Beside lone headings any cut that fits will do; elsewhere a sliver
      // under minTokens is not worth a chunk's tail, so start a new one.
      const alone = current.length > 0 && onlyHeadings();
      makeRoom(alone ? MIN_CUT_TOKENS : Math.max(options.minTokens, MIN_CUT_TOKENS));
      const span = firstPiece(text, from, unit.end, Math.max(room(), MIN_CUT_TOKENS));
      if (span === null) break;
      current.push({ ...unit, ...span, tokens: estimateTokens(text.slice(span.start, span.end)) });
      from = span.end;
    }
  }
  if (current.length > carried) groups.push(current);

  // Fold a small last chunk into the one before it. Overlap pieces are the
  // same objects as the previous chunk's tail, so they are not counted twice.
  if (groups.length >= 2) {
    const last = groups[groups.length - 1]!;
    const before = groups[groups.length - 2]!;
    const fresh = last.filter((piece) => !before.includes(piece));
    if (sum(last) < options.minTokens && sum(before) + sum(fresh) <= options.maxTokens) {
      groups.splice(groups.length - 2, 2, [...before, ...fresh]);
    }
  }
  return groups;
}

export function chunkDocument(
  input: ChunkInput,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkedDocument {
  checkOptions(options);
  let text: string;
  let pages: readonly PageSpan[] = [];
  let format: Format;
  if (input.format === 'pdf') {
    ({ text, pages } = assemblePages(input.pages));
    format = 'text';
  } else {
    text = normalise(input.text);
    format = input.format;
  }

  const points = codePointOffsets(text);
  const groups = pack(text, piecesOf(text, unitsOf(text, format), options), options);
  const chunks = groups.map((group, ord): Chunk => {
    const start = group[0]!.start;
    const end = group[group.length - 1]!.end;
    const body = text.slice(start, end);
    return {
      ord,
      text: body,
      charStart: points(start),
      charEnd: points(end),
      pageStart: pages.length === 0 ? null : pageAt(pages, start),
      pageEnd: pages.length === 0 ? null : pageAt(pages, end - 1),
      pageStarts: pages
        .filter((p) => p.start > start && p.start < end && p.end > p.start)
        .map((p) => ({ page: p.page, at: points(p.start) - points(start) })),
      headingPath: (group.find((piece) => piece.kind !== 'heading') ?? group[0]!).path,
      tokens: estimateTokens(body),
    };
  });
  return { text, pageCount: input.format === 'pdf' ? input.pages.length : null, chunks };
}
