/**
 * Reciprocal rank fusion (Cormack, Clarke and Buettcher, SIGIR 2009):
 *
 *     fused(d) = sum over the lists L that hold d of 1 / (rrfK + rank_L(d))
 *
 * with 1-based ranks. Only ranks enter it, never the raw scores, which is the
 * point: a cosine similarity and a `ts_rank` live on unrelated scales, and
 * RRF needs no calibration between them. It is also why the abstain rule
 * reads the similarity, not this score (see `options.ts`).
 *
 * Ties are broken so the order is total and repeatable: the better of the
 * two ranks, then the vector rank, then the chunk id.
 */
import type { CandidateChunk, RankedCandidate } from './candidate';

export interface VectorHit {
  readonly chunk: CandidateChunk;
  readonly similarity: number;
}

export interface TextHit {
  readonly chunk: CandidateChunk;
  readonly lexical: number;
  /** Computed in the same query when the query was embedded. */
  readonly similarity: number | null;
}

export function fuse(
  vector: readonly VectorHit[],
  text: readonly TextHit[],
  rrfK: number,
): RankedCandidate[] {
  const byId = new Map<
    string,
    {
      chunk: CandidateChunk;
      vectorRank: number | null;
      textRank: number | null;
      similarity: number | null;
      lexical: number | null;
    }
  >();
  vector.forEach((hit, index) => {
    if (byId.has(hit.chunk.id)) return; // a list never repeats a chunk; first wins if it did
    byId.set(hit.chunk.id, {
      chunk: hit.chunk,
      vectorRank: index + 1,
      textRank: null,
      similarity: hit.similarity,
      lexical: null,
    });
  });
  text.forEach((hit, index) => {
    const seen = byId.get(hit.chunk.id);
    if (seen !== undefined) {
      if (seen.textRank === null) {
        seen.textRank = index + 1;
        seen.lexical = hit.lexical;
      }
      return;
    }
    byId.set(hit.chunk.id, {
      chunk: hit.chunk,
      vectorRank: null,
      textRank: index + 1,
      similarity: hit.similarity,
      lexical: hit.lexical,
    });
  });

  const score = (rank: number | null) => (rank === null ? 0 : 1 / (rrfK + rank));
  const ranked: RankedCandidate[] = [...byId.values()].map((entry) => ({
    ...entry.chunk,
    vectorRank: entry.vectorRank,
    textRank: entry.textRank,
    similarity: entry.similarity,
    lexical: entry.lexical,
    fused: score(entry.vectorRank) + score(entry.textRank),
  }));
  const best = (c: RankedCandidate) => Math.min(c.vectorRank ?? Infinity, c.textRank ?? Infinity);
  return ranked.sort(
    (a, b) =>
      b.fused - a.fused ||
      best(a) - best(b) ||
      (a.vectorRank ?? Infinity) - (b.vectorRank ?? Infinity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
