/**
 * What the two searches return per chunk, and what fusion adds to it.
 */
import type { PageStart } from '@rag/citations';

/** One stored chunk, as both searches select it. Offsets are code points. */
export interface CandidateChunk {
  readonly id: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly ord: number;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly pageStarts: readonly PageStart[];
  readonly headingPath: readonly string[];
  readonly tokens: number;
}

/** A chunk after fusion. Ranks are 1-based; null where that list missed it. */
export interface RankedCandidate extends CandidateChunk {
  readonly vectorRank: number | null;
  readonly textRank: number | null;
  /** Cosine similarity to the query; null when the query was not embedded (text mode). */
  readonly similarity: number | null;
  /** `ts_rank` of the full-text match; null when it did not match. */
  readonly lexical: number | null;
  /** The reciprocal rank fusion score. */
  readonly fused: number;
}
