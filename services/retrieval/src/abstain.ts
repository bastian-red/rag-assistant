/**
 * When to answer "Not found in your documents" without calling the chat
 * model (SPECS section 1).
 *
 * - Nothing matched at all (an empty library, or a text-mode query whose
 *   words appear nowhere): `no_candidates`.
 * - The query was embedded and no candidate comes within `minSimilarity`:
 *   `below_threshold`. The similarity is the only absolute signal here; see
 *   `options.ts` for why the fused score is not one.
 * - In text mode there is no similarity, so any match answers.
 *
 * Nothing packed (every source over the budget) is `no_candidates` too: the
 * model would be asked with no sources, which the answer rules forbid.
 */
import type { RankedCandidate } from './candidate';
import type { RetrievalMode } from './options';

export type AbstainReason = 'no_candidates' | 'below_threshold';

export interface Verdict {
  readonly abstain: boolean;
  readonly reason: AbstainReason | null;
  /** The best cosine similarity among the candidates; null when none was computed. */
  readonly bestSimilarity: number | null;
}

export function decide(
  ranked: readonly RankedCandidate[],
  packedCount: number,
  mode: RetrievalMode,
  minSimilarity: number,
): Verdict {
  const similarities = ranked.map((c) => c.similarity).filter((s): s is number => s !== null);
  const bestSimilarity = similarities.length === 0 ? null : Math.max(...similarities);
  if (ranked.length === 0 || packedCount === 0) {
    return { abstain: true, reason: 'no_candidates', bestSimilarity };
  }
  if (mode !== 'text' && (bestSimilarity === null || bestSimilarity < minSimilarity)) {
    return { abstain: true, reason: 'below_threshold', bestSimilarity };
  }
  return { abstain: false, reason: null, bestSimilarity };
}
