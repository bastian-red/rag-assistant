/**
 * Candidates built from real chunker output, for the unit tests: the spans,
 * overlaps and section gaps are the chunker's, not hand-typed.
 */
import { chunkDocument } from '@rag/chunker';

import type { RankedCandidate } from './candidate';

const sentence = (section: number, n: number) =>
  `In section ${String(section)}, valve ${String(n)} opens when the pressure passes ${String(n)} bar and closes below it. `;

/** Markdown with `sections` sections, each long enough to split into overlapping chunks. */
export function longDocument(sections = 2, sentences = 45): string {
  return Array.from(
    { length: sections },
    (_, s) =>
      `## Section ${String(s + 1)}\n\n${Array.from({ length: sentences }, (_, n) => sentence(s + 1, n + 1)).join('')}\n`,
  ).join('\n');
}

export function candidatesOf(
  text: string,
  documentId = 'doc-a',
  title = 'Valves',
): { text: string; candidates: RankedCandidate[] } {
  const doc = chunkDocument({ format: 'markdown', text });
  return {
    text: doc.text,
    candidates: doc.chunks.map((chunk) => ({
      id: `${documentId}-${String(chunk.ord)}`,
      documentId,
      documentTitle: title,
      ord: chunk.ord,
      text: chunk.text,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      pageStarts: chunk.pageStarts,
      headingPath: chunk.headingPath,
      tokens: chunk.tokens,
      vectorRank: null,
      textRank: null,
      similarity: 0.5,
      lexical: null,
      fused: 0,
    })),
  };
}

/** The candidates in this order, with fused scores falling so the order is the rank. */
export function inRank(candidates: readonly RankedCandidate[]): RankedCandidate[] {
  return candidates.map((c, i) => ({ ...c, fused: 1 / (60 + i + 1), vectorRank: i + 1 }));
}
