/**
 * The scores, as pure functions over what a run recorded. Deterministic work:
 * same records, same numbers, and every one of them is unit-tested with
 * expectations worked out by hand in the test.
 *
 * Spans are code points in a document's stored text (`documentText`).
 */
import type { GoldSpan } from './questions';

export interface Span {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

/** Same document and a non-empty intersection. Touching ends do not overlap. */
export function overlaps(a: Span, b: Span): boolean {
  return a.file === b.file && a.start < b.end && b.start < a.end;
}

/** A retrieved source: every chunk it holds, as spans (a merged source holds several). */
export type RankedSource = readonly Span[];

/**
 * Recall at k for one question: the share of its gold spans that at least one
 * of the first k sources touches. A multi-hop question with one of two spans
 * found scores 0.5, not 1.
 */
export function recallAt(
  k: number,
  ranked: readonly RankedSource[],
  gold: readonly GoldSpan[],
): number {
  if (gold.length === 0) throw new Error('recall is undefined for a question with no gold span');
  const top = ranked.slice(0, k).flat();
  return gold.filter((g) => top.some((s) => overlaps(s, g))).length / gold.length;
}

/** 1 / rank of the first source touching any gold span; 0 when none does. */
export function reciprocalRank(ranked: readonly RankedSource[], gold: readonly GoldSpan[]): number {
  const index = ranked.findIndex((source) => source.some((s) => gold.some((g) => overlaps(s, g))));
  return index === -1 ? 0 : 1 / (index + 1);
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** What the reader got: an abstention (either kind) or an answer. */
export type Verdict = 'abstained' | 'answered';

export interface AbstentionScores {
  /** Unanswerable questions answered "not found": higher is better (SPECS >= 0.90). */
  readonly correctAbstention: number | null;
  /** Answerable questions answered "not found": lower is better (SPECS <= 0.05). */
  readonly falseAbstention: number | null;
  readonly unanswerable: number;
  readonly answerable: number;
}

export function abstention(
  rows: readonly { readonly answerable: boolean; readonly verdict: Verdict }[],
): AbstentionScores {
  const unanswerable = rows.filter((r) => !r.answerable);
  const answerable = rows.filter((r) => r.answerable);
  const share = (set: typeof rows) =>
    set.length === 0 ? null : set.filter((r) => r.verdict === 'abstained').length / set.length;
  return {
    correctAbstention: share(unanswerable),
    falseAbstention: share(answerable),
    unanswerable: unanswerable.length,
    answerable: answerable.length,
  };
}

export interface ThresholdChoice {
  readonly threshold: number;
  readonly correctAbstention: number;
  readonly falseAbstention: number;
}

/**
 * The abstain threshold from best similarities alone (retrieval abstains when
 * the best cosine is below it; the model never gets a say here).
 *
 * Every midpoint between two neighbouring observed values is a candidate.
 * The choice: the lowest false abstention, then the highest correct
 * abstention, then the largest margin to the nearest observed value on
 * either side (a threshold sitting on top of a question flips with the next
 * model pull), then the lower threshold. Returns every candidate scored, so
 * the report can show the curve rather than one number.
 */
export function chooseThreshold(
  rows: readonly { readonly answerable: boolean; readonly best: number }[],
): { readonly choice: ThresholdChoice; readonly candidates: readonly ThresholdChoice[] } {
  if (rows.length === 0) throw new Error('no rows to choose a threshold from');
  const values = [...new Set(rows.map((r) => r.best))].sort((a, b) => a - b);
  const cuts = [values[0]! - 0.01];
  for (let i = 1; i < values.length; i += 1) cuts.push((values[i - 1]! + values[i]!) / 2);
  cuts.push(values.at(-1)! + 0.01);
  const score = (threshold: number): ThresholdChoice => {
    const s = abstention(
      rows.map((r) => ({
        answerable: r.answerable,
        verdict: r.best < threshold ? 'abstained' : 'answered',
      })),
    );
    return {
      threshold,
      correctAbstention: s.correctAbstention ?? 0,
      falseAbstention: s.falseAbstention ?? 0,
    };
  };
  const candidates = cuts.map(score);
  const margin = (t: number) => Math.min(...values.map((v) => Math.abs(v - t)));
  const choice = [...candidates].sort(
    (a, b) =>
      a.falseAbstention - b.falseAbstention ||
      b.correctAbstention - a.correctAbstention ||
      margin(b.threshold) - margin(a.threshold) ||
      a.threshold - b.threshold,
  )[0]!;
  return { choice, candidates };
}

export interface JudgeAgreement {
  readonly labels: number;
  /** Supported claims the judge called supported. */
  readonly tpr: number;
  /** Unsupported claims the judge called unsupported. */
  readonly tnr: number;
  readonly accuracy: number;
}

export function agreement(
  rows: readonly { readonly label: boolean; readonly judged: boolean }[],
): JudgeAgreement {
  const positives = rows.filter((r) => r.label);
  const negatives = rows.filter((r) => !r.label);
  if (positives.length === 0 || negatives.length === 0) {
    throw new Error('agreement needs both supported and unsupported labels');
  }
  return {
    labels: rows.length,
    tpr: positives.filter((r) => r.judged).length / positives.length,
    tnr: negatives.filter((r) => !r.judged).length / negatives.length,
    accuracy: rows.filter((r) => r.judged === r.label).length / rows.length,
  };
}

/**
 * The judge's observed pass rate corrected for its measured errors
 * (Rogan-Gladen): theta = (p + TNR - 1) / (TPR + TNR - 1), clamped to [0, 1].
 * Null when the judge is no better than a coin (TPR + TNR <= 1), because the
 * correction then divides by nothing meaningful.
 */
export function corrected(
  observed: number,
  judge: Pick<JudgeAgreement, 'tpr' | 'tnr'>,
): number | null {
  const denominator = judge.tpr + judge.tnr - 1;
  if (denominator <= 0) return null;
  return Math.min(1, Math.max(0, (observed + judge.tnr - 1) / denominator));
}

/**
 * Citation precision with the judged part corrected for the judge's errors:
 * citations on a gold span count as correct by construction; the rest were
 * judged, and their observed pass rate is corrected (Rogan-Gladen) before it
 * is counted. Null when nothing was cited or the judge is no better than a coin.
 */
export function correctedPrecision(
  counts: {
    readonly citations: number;
    readonly onGold: number;
    readonly judgedSupporting: number;
  },
  judge: Pick<JudgeAgreement, 'tpr' | 'tnr'>,
): number | null {
  const { citations, onGold, judgedSupporting } = counts;
  if (citations === 0) return null;
  const judged = citations - onGold;
  if (judged === 0) return 1;
  const share = corrected(judgedSupporting / judged, judge);
  return share === null ? null : (onGold + share * judged) / citations;
}

/** p50 / p95 by nearest rank. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ]!;
}
