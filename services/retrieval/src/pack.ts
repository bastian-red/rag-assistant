/**
 * From fused candidates to the numbered sources a prompt carries.
 *
 * 1. **Select** the top `k` distinct chunks in fused order. A chunk whose
 *    text (whitespace collapsed) equals one already selected is skipped and
 *    counted: two documents can share a boilerplate paragraph, and the model
 *    gains nothing from reading it twice under two labels.
 * 2. **Merge neighbours.** Selected chunks that are consecutive in one
 *    document and whose spans overlap or touch become one source over the
 *    exact document text of their union. The chunker overlaps chunks inside a
 *    long section by about 60 tokens, so two neighbours selected separately
 *    would put that overlap in the prompt twice and split one passage over
 *    two labels. Neighbours with a gap between them (a section boundary: the
 *    blank line between blocks is in no chunk) are NOT merged, because the
 *    gap's text is not stored and a union would have to invent it. Each
 *    merged source lists its parts, so a citation is still stored against the
 *    one chunk its quote is in (`partOf` in @rag/citations).
 * 3. **Pack** in rank order (a source ranks as its best member) under the
 *    token budget, counting each source as the block the prompt will hold
 *    (`formatSource`, header included). A source that does not fit is
 *    skipped and counted, and a later, smaller one may still fit.
 *
 * Markers are 1..n in the packed order, so `[S1]` is the strongest source.
 */
import { estimateTokens } from '@rag/chunker';
import type { PackedPart, PackedSource, PageStart } from '@rag/citations';
import { formatSource } from '@rag/shared';

import type { RankedCandidate } from './candidate';

export interface RetrievedSource extends PackedSource {
  readonly documentId: string;
  readonly headingPath: readonly string[];
  /** The stored chunks it holds, in document order (one unless merged). */
  readonly chunkIds: readonly string[];
  /** The last page it reaches; null for markdown and text. */
  readonly pageEnd: number | null;
  /** The best fused score among its chunks. */
  readonly fused: number;
  /** The best similarity among its chunks; null in text mode. */
  readonly similarity: number | null;
  /** Estimated tokens of its block in the prompt. */
  readonly tokens: number;
}

export interface Packed {
  readonly sources: RetrievedSource[];
  /** Chunks skipped at selection because their text repeated a selected one. */
  readonly duplicates: number;
  /** Sources that did not fit the token budget. */
  readonly overBudget: number;
}

const sameText = (text: string) => text.replace(/\s+/gu, ' ').trim();
const points = (text: string) => Array.from(text);

/** Step 1: the top `k` distinct chunks, in fused order. */
export function select(
  ranked: readonly RankedCandidate[],
  k: number,
): { selected: RankedCandidate[]; duplicates: number } {
  const seen = new Set<string>();
  const selected: RankedCandidate[] = [];
  let duplicates = 0;
  for (const candidate of ranked) {
    if (selected.length === k) break;
    const key = sameText(candidate.text);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    selected.push(candidate);
  }
  return { selected, duplicates };
}

interface Run {
  readonly members: RankedCandidate[];
  /** Code points of the union text. */
  readonly text: string[];
  readonly start: number;
  end: number;
}

/**
 * Whether `next` continues `run` exactly: the next chunk of the same
 * document, starting inside or at the end of the run, and agreeing with the
 * run's text over the overlap (a mismatch would mean the rows disagree with
 * each other, and then they are not merged).
 */
function continues(run: Run, next: RankedCandidate): boolean {
  const last = run.members[run.members.length - 1]!;
  if (next.documentId !== last.documentId || next.ord !== last.ord + 1) return false;
  if (next.charStart > run.end || next.charStart < run.start) return false;
  const overlap = run.end - next.charStart;
  const nextPoints = points(next.text);
  if (nextPoints.length !== next.charEnd - next.charStart) return false;
  const tail = run.text.slice(next.charStart - run.start).join('');
  return tail === nextPoints.slice(0, Math.min(overlap, nextPoints.length)).join('');
}

/** Step 2: runs of mergeable neighbours. */
export function mergeNeighbours(selected: readonly RankedCandidate[]): RankedCandidate[][] {
  const ordered = [...selected].sort((a, b) =>
    a.documentId === b.documentId ? a.ord - b.ord : a.documentId < b.documentId ? -1 : 1,
  );
  const runs: Run[] = [];
  for (const chunk of ordered) {
    const run = runs[runs.length - 1];
    if (run !== undefined && continues(run, chunk)) {
      const nextPoints = points(chunk.text);
      run.text.push(...nextPoints.slice(run.end - chunk.charStart));
      run.end = Math.max(run.end, chunk.charEnd);
      run.members.push(chunk);
    } else {
      runs.push({
        members: [chunk],
        text: points(chunk.text),
        start: chunk.charStart,
        end: chunk.charEnd,
      });
    }
  }
  return runs.map((run) => run.members);
}

/** One source from a run, before it has a marker. */
function sourceOf(members: readonly RankedCandidate[]): Omit<RetrievedSource, 'marker' | 'tokens'> {
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const start = first.charStart;
  const text: string[] = points(first.text);
  for (const next of members.slice(1)) {
    const end = start + text.length;
    text.push(...points(next.text).slice(end - next.charStart));
  }
  const pageStartsOf = (c: RankedCandidate): readonly PageStart[] | undefined =>
    c.pageStarts.length === 0 ? undefined : c.pageStarts;
  const parts: PackedPart[] = members.map((c) => ({
    chunkId: c.id,
    at: c.charStart - start,
    length: c.charEnd - c.charStart,
    page: c.pageStart,
    ...(pageStartsOf(c) === undefined ? {} : { pageStarts: pageStartsOf(c)! }),
  }));
  const similarities = members.map((c) => c.similarity).filter((s): s is number => s !== null);
  const firstStarts = pageStartsOf(first);
  return {
    chunkId: first.id,
    documentId: first.documentId,
    documentTitle: first.documentTitle,
    page: first.pageStart,
    ...(firstStarts === undefined ? {} : { pageStarts: firstStarts }),
    text: text.join(''),
    ...(members.length > 1 ? { parts } : {}),
    headingPath: first.headingPath,
    chunkIds: members.map((c) => c.id),
    pageEnd: last.pageEnd,
    fused: Math.max(...members.map((c) => c.fused)),
    similarity: similarities.length === 0 ? null : Math.max(...similarities),
  };
}

/** Selection, merging and packing (the header). */
export function pack(
  ranked: readonly RankedCandidate[],
  options: { readonly k: number; readonly contextTokens: number },
): Packed {
  const { selected, duplicates } = select(ranked, options.k);
  const rankOf = new Map(selected.map((c, i) => [c.id, i]));
  const runs = mergeNeighbours(selected).sort(
    (a, b) =>
      Math.min(...a.map((c) => rankOf.get(c.id)!)) - Math.min(...b.map((c) => rankOf.get(c.id)!)),
  );
  const sources: RetrievedSource[] = [];
  let used = 0;
  let overBudget = 0;
  for (const run of runs) {
    const source = sourceOf(run);
    const marker = sources.length + 1;
    const tokens = estimateTokens(
      formatSource({ marker, title: source.documentTitle, page: source.page, text: source.text }),
    );
    if (used + tokens > options.contextTokens) {
      overBudget += 1;
      continue;
    }
    used += tokens;
    sources.push({ ...source, marker, tokens });
  }
  return { sources, duplicates, overBudget };
}
