/**
 * One eval run: the phases, each a function of what the previous ones
 * recorded, so a phase can be re-scored without re-running the model.
 *
 *   1. ingest     the corpus into this chunk size's library (setup.ts)
 *   2. retrieval  every question in hybrid, vector and text mode, with
 *                 abstention off so recall measures ranking alone; the best
 *                 similarity of each hybrid run feeds the threshold choice
 *   3. sweep      (optional) k, the RRF constant and the pack budget, hybrid
 *   4. answers    every question through @rag/answer, the API's own run, on
 *                 the real chat model at temperature 0
 *   5. judge      validated on the labels first, then each answer's claims
 *                 against the sources it cites, and each citation that does
 *                 not land on a gold span against the passage it names
 *
 * Every model call is timed, and progress (percent, rate, ETA) is computed
 * here from counts, appended to /tmp/rag-eval/progress.log and printed.
 */
import { answer, PROMPT_VERSION, type AnswerOutcome } from '@rag/answer';
import { claimsOf, coverage as coverageOf, stripMarkers } from '@rag/citations';
import {
  retrieve,
  retrievalOptions,
  type Retrieval,
  type RetrievalDeps,
  type RetrievalOptions,
} from '@rag/retrieval';
import { NOT_FOUND_ANSWER, type LlmClient } from '@rag/shared';

import { progress } from './progress';
import { isLong, JUDGE_VERSION, judgeMessages, parseVerdicts, type Label } from './judge';
import {
  abstention,
  agreement,
  chooseThreshold,
  corrected,
  correctedPrecision,
  mean,
  percentile,
  recallAt,
  reciprocalRank,
  overlaps,
  type JudgeAgreement,
  type RankedSource,
  type Verdict,
} from './metrics';
import { splitOf, type GoldSpan, type Question } from './questions';
import type { Library } from './setup';

const answerable = (q: Question) => q.kind !== 'unanswerable';

/** The chunks of a retrieved source as spans of their file. */
function spansOf(library: Library, chunkIds: readonly string[]): RankedSource {
  return chunkIds.map((id) => {
    const chunk = library.chunks.get(id);
    if (chunk === undefined) throw new Error(`retrieved chunk ${id} is not in the library`);
    return chunk;
  });
}

// --- retrieval ------------------------------------------------------------------

export interface RetrievalRow {
  readonly id: string;
  readonly kind: Question['kind'];
  readonly split: 'dev' | 'test';
  readonly mode: RetrievalOptions['mode'];
  readonly best: number | null;
  readonly recall: number | null;
  readonly rr: number | null;
  readonly sources: number;
  readonly ms: number;
}

export interface RetrievalScores {
  readonly mode: RetrievalOptions['mode'];
  readonly options: Partial<RetrievalOptions>;
  readonly recall: number;
  readonly mrr: number;
  readonly questions: number;
  readonly p95Ms: number | null;
}

export async function runRetrieval(
  deps: RetrievalDeps,
  library: Library,
  questions: readonly Question[],
  gold: ReadonlyMap<string, GoldSpan[]>,
  options: Partial<RetrievalOptions>,
  modes: readonly RetrievalOptions['mode'][] = ['hybrid', 'vector', 'text'],
  title = 'eval retrieval',
): Promise<{ rows: RetrievalRow[]; scores: RetrievalScores[] }> {
  const rows: RetrievalRow[] = [];
  const tick = progress(title);
  const total = questions.length * modes.length;
  for (const mode of modes) {
    // Abstention off: recall is about ranking, and an abstention would read
    // as "nothing retrieved". The threshold is chosen from `best` instead.
    const run = retrievalOptions({ ...options, mode, minSimilarity: -1 });
    for (const q of questions) {
      const r = await retrieve(deps, { ownerId: library.ownerId, query: q.question }, run);
      const ranked = r.sources.map((s) => spansOf(library, s.chunkIds));
      const spans = gold.get(q.id) ?? [];
      rows.push({
        id: q.id,
        kind: q.kind,
        split: splitOf(q.id),
        mode,
        best: r.bestSimilarity,
        recall: spans.length === 0 ? null : recallAt(run.k, ranked, spans),
        rr: spans.length === 0 ? null : reciprocalRank(ranked, spans),
        sources: r.sources.length,
        ms: Math.round(r.timings.totalMs),
      });
      if (rows.length % 16 === 0 || rows.length === total) tick(rows.length, total, mode);
    }
  }
  const scores = modes.map((mode): RetrievalScores => {
    const of = rows.filter((r) => r.mode === mode && r.recall !== null);
    return {
      mode,
      options,
      recall: mean(of.map((r) => r.recall!))!,
      mrr: mean(of.map((r) => r.rr!))!,
      questions: of.length,
      p95Ms: percentile(
        rows.filter((r) => r.mode === mode).map((r) => r.ms),
        95,
      ),
    };
  });
  return { rows, scores };
}

/** The abstain threshold, chosen on dev from hybrid best similarities, scored on both splits. */
export function calibrate(rows: readonly RetrievalRow[], current: number) {
  const hybrid = rows.filter((r) => r.mode === 'hybrid' && r.best !== null);
  const toRow = (r: RetrievalRow) => ({ answerable: r.kind !== 'unanswerable', best: r.best! });
  const dev = hybrid.filter((r) => r.split === 'dev').map(toRow);
  const { choice, candidates } = chooseThreshold(dev);
  const at = (threshold: number, split: 'dev' | 'test' | 'all') =>
    abstention(
      hybrid
        .filter((r) => split === 'all' || r.split === split)
        .map((r) => ({
          answerable: r.kind !== 'unanswerable',
          verdict: (r.best! < threshold ? 'abstained' : 'answered') as Verdict,
        })),
    );
  const sorted = (kind: 'answerable' | 'unanswerable') =>
    hybrid
      .filter((r) => (r.kind === 'unanswerable') === (kind === 'unanswerable'))
      .map((r) => ({ id: r.id, best: Number(r.best!.toFixed(3)) }))
      .sort((a, b) => a.best - b.best);
  return {
    chosen: Number(choice.threshold.toFixed(3)),
    current,
    chosenScores: {
      dev: at(choice.threshold, 'dev'),
      test: at(choice.threshold, 'test'),
      all: at(choice.threshold, 'all'),
    },
    currentScores: { dev: at(current, 'dev'), test: at(current, 'test'), all: at(current, 'all') },
    candidates: candidates.length,
    lowestAnswerable: sorted('answerable').slice(0, 5),
    highestUnanswerable: sorted('unanswerable').reverse().slice(0, 5),
  };
}

// --- answers --------------------------------------------------------------------

export interface AnswerRow {
  readonly id: string;
  readonly kind: Question['kind'];
  readonly split: 'dev' | 'test';
  readonly status: AnswerOutcome['status'];
  readonly verdict: Verdict;
  /** Why it abstained: retrieval (below the threshold) or the model's own "not found". */
  readonly abstainedBy: 'retrieval' | 'model' | null;
  readonly bestSimilarity: number | null;
  readonly content: string;
  readonly sources: number;
  readonly citations: number;
  readonly dropped: number;
  readonly claims: number;
  readonly citedClaims: number;
  readonly forbiddenHit: string | null;
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
  readonly firstTokenMs: number | null;
  readonly totalMs: number;
  readonly failure: string | null;
  /** For the judge: each claim with the markers it cites. */
  readonly claimList: readonly { text: string; markers: readonly number[] }[];
  /** For the judge and precision: each packed source, by marker. */
  readonly packed: readonly { marker: number; text: string; spans: RankedSource }[];
}

export async function runAnswers(
  llm: Pick<LlmClient, 'chat'>,
  deps: RetrievalDeps,
  library: Library,
  questions: readonly Question[],
  options: Partial<RetrievalOptions>,
): Promise<AnswerRow[]> {
  const rows: AnswerRow[] = [];
  const tick = progress('eval answers');
  const run = retrievalOptions(options);
  for (const q of questions) {
    const outcome = await answer(
      {
        chat: llm.chat,
        retrieve: (question: string): Promise<Retrieval> =>
          retrieve(deps, { ownerId: library.ownerId, query: question }, run),
      },
      { question: q.question, history: [] },
      { temperature: 0 },
    );
    const plain = stripMarkers(outcome.content).trim();
    const modelAbstained = !outcome.abstained && plain === NOT_FOUND_ANSWER;
    const cov = outcome.abstained || modelAbstained ? null : coverageOf(outcome.content);
    const lower = outcome.content.toLowerCase();
    rows.push({
      id: q.id,
      kind: q.kind,
      split: splitOf(q.id),
      status: outcome.status,
      verdict: outcome.abstained || modelAbstained ? 'abstained' : 'answered',
      abstainedBy: outcome.abstained ? 'retrieval' : modelAbstained ? 'model' : null,
      bestSimilarity: outcome.retrieval?.bestSimilarity ?? null,
      content: outcome.content,
      sources: outcome.retrieval?.sources.length ?? 0,
      citations: outcome.citations.length,
      dropped: outcome.dropped.length,
      claims: cov?.claims ?? 0,
      citedClaims: cov?.cited ?? 0,
      forbiddenHit: (q.forbidden ?? []).find((f) => lower.includes(f.toLowerCase())) ?? null,
      promptTokens: outcome.usage?.promptTokens ?? null,
      outputTokens: outcome.usage?.outputTokens ?? null,
      firstTokenMs: outcome.timings.firstTokenMs,
      totalMs: Math.round(outcome.timings.totalMs),
      failure: outcome.failure?.code ?? null,
      claimList: claimsOf(outcome.content).filter(
        (c) => (c.text.match(/[\p{L}\p{Nd}]+/gu) ?? []).length >= 4,
      ),
      packed: (outcome.retrieval?.sources ?? []).map((s) => ({
        marker: s.marker,
        text: s.text,
        spans: spansOf(library, s.chunkIds),
      })),
    });
    tick(
      rows.length,
      questions.length,
      `${q.id} ${rows.at(-1)!.verdict} in ${String(Math.round(outcome.timings.totalMs / 1000))} s`,
    );
  }
  return rows;
}

// --- the judge ------------------------------------------------------------------

async function ask(llm: Pick<LlmClient, 'chat'>, passages: string[], claims: string[]) {
  let reply = '';
  const started = performance.now();
  for await (const event of llm.chat(judgeMessages(passages, claims), {
    temperature: 0,
    maxTokens: 64 + 24 * claims.length,
  })) {
    if (event.type === 'token') reply += event.text;
  }
  return { verdicts: parseVerdicts(reply, claims.length), ms: performance.now() - started };
}

export async function validateJudge(
  llm: Pick<LlmClient, 'chat'>,
  labels: readonly Label[],
  log?: string,
): Promise<{
  agreement: JudgeAgreement;
  /** On chunk-length labels only: what corrects the run's judgements. */
  long: JudgeAgreement;
  unparsed: number;
  misses: string[];
}> {
  const rows: { label: boolean; judged: boolean; long: boolean }[] = [];
  const misses: string[] = [];
  let unparsed = 0;
  const tick = progress('eval judge labels', log);
  for (const label of labels) {
    const { verdicts } = await ask(llm, [label.passage], [label.claim]);
    // An unreadable reply counts against the judge: it is a judgement the run could not use.
    const judged = verdicts === null ? !label.supported : verdicts[0]!;
    if (verdicts === null) unparsed += 1;
    if (judged !== label.supported) misses.push(`${label.id} (${label.how})`);
    rows.push({ label: label.supported, judged, long: isLong(label) });
    tick(rows.length, labels.length);
  }
  return {
    agreement: agreement(rows),
    long: agreement(rows.filter((r) => r.long)),
    unparsed,
    misses,
  };
}

export interface Judged {
  readonly faithfulness: {
    observed: number | null;
    corrected: number | null;
    claims: number;
    supported: number;
  };
  readonly precision: {
    /** Corrected for the judge's errors on the judged part (see correctedPrecision). */
    value: number | null;
    /** Uncorrected: (onGold + judgedSupporting) / citations. */
    observed: number | null;
    citations: number;
    onGold: number;
    judgedSupporting: number;
    /** Each citation neither on a gold span nor judged supporting, with what it cited. */
    imprecise: { id: string; marker: number; claim: string; source: string }[];
  };
  readonly coverage: { value: number | null; claims: number; cited: number };
  readonly unparsed: number;
  readonly perQuestion: { id: string; supported: number; claims: number; unsupported: string[] }[];
}

export async function judgeAnswers(
  llm: Pick<LlmClient, 'chat'>,
  rows: readonly AnswerRow[],
  gold: ReadonlyMap<string, GoldSpan[]>,
  judge: JudgeAgreement,
): Promise<Judged> {
  const answered = rows.filter((r) => r.verdict === 'answered' && r.status === 'DONE');
  const tick = progress('eval judge answers');
  let claims = 0;
  let supported = 0;
  let citations = 0;
  let onGold = 0;
  let judgedSupporting = 0;
  const imprecise: Judged['precision']['imprecise'] = [];
  let unparsed = 0;
  const perQuestion: Judged['perQuestion'] = [];
  for (const [index, row] of answered.entries()) {
    const spans = gold.get(row.id) ?? [];
    const byMarker = new Map(row.packed.map((p) => [p.marker, p]));
    // Faithfulness: every claim against the sources the answer cites (all
    // packed sources when it cites none, so an uncited answer is still read).
    const cited = [...new Set(row.claimList.flatMap((c) => c.markers))].filter((m) =>
      byMarker.has(m),
    );
    const passages = (cited.length > 0 ? cited.map((m) => byMarker.get(m)!) : row.packed).map(
      (p) => p.text,
    );
    const unsupported: string[] = [];
    let mine = 0;
    if (row.claimList.length > 0) {
      const { verdicts } = await ask(
        llm,
        passages,
        row.claimList.map((c) => c.text),
      );
      if (verdicts === null) unparsed += 1;
      row.claimList.forEach((c, i) => {
        const ok = verdicts?.[i] ?? false;
        if (ok) mine += 1;
        else unsupported.push(c.text);
      });
    }
    claims += row.claimList.length;
    supported += mine;
    perQuestion.push({ id: row.id, supported: mine, claims: row.claimList.length, unsupported });

    // Precision: each (claim, marker) pair. On a gold span, it supports by
    // construction; otherwise the judge reads that one passage.
    for (const claim of row.claimList) {
      for (const marker of claim.markers) {
        const source = byMarker.get(marker);
        if (source === undefined) continue;
        citations += 1;
        if (source.spans.some((s) => spans.some((g) => overlaps(s, g)))) {
          onGold += 1;
          continue;
        }
        const { verdicts } = await ask(llm, [source.text], [claim.text]);
        if (verdicts === null) unparsed += 1;
        if (verdicts?.[0] === true) judgedSupporting += 1;
        else imprecise.push({ id: row.id, marker, claim: claim.text, source: source.text });
      }
    }
    tick(index + 1, answered.length, row.id);
  }
  const observed = claims === 0 ? null : supported / claims;
  const allClaims = rows.reduce((n, r) => n + r.claims, 0);
  const allCited = rows.reduce((n, r) => n + r.citedClaims, 0);
  return {
    faithfulness: {
      observed,
      corrected: observed === null ? null : corrected(observed, judge),
      claims,
      supported,
    },
    precision: {
      value: correctedPrecision({ citations, onGold, judgedSupporting }, judge),
      observed: citations === 0 ? null : (onGold + judgedSupporting) / citations,
      citations,
      onGold,
      judgedSupporting,
      imprecise,
    },
    coverage: {
      value: allClaims === 0 ? null : allCited / allClaims,
      claims: allClaims,
      cited: allCited,
    },
    unparsed,
    perQuestion,
  };
}

export function answerScores(rows: readonly AnswerRow[]) {
  const score = (subset: readonly AnswerRow[]) =>
    abstention(subset.map((r) => ({ answerable: r.kind !== 'unanswerable', verdict: r.verdict })));
  const hostile = rows.filter((r) => r.kind === 'hostile');
  return {
    abstention: {
      all: score(rows),
      dev: score(rows.filter((r) => r.split === 'dev')),
      test: score(rows.filter((r) => r.split === 'test')),
      byModel: rows.filter((r) => r.abstainedBy === 'model').map((r) => r.id),
      byRetrieval: rows.filter((r) => r.abstainedBy === 'retrieval').map((r) => r.id),
    },
    hostile: {
      questions: hostile.length,
      followed: hostile.filter((r) => r.forbiddenHit !== null).map((r) => r.id),
      answered: hostile.filter((r) => r.verdict === 'answered').length,
    },
    failures: rows
      .filter((r) => r.status !== 'DONE')
      .map((r) => `${r.id}: ${r.failure ?? r.status}`),
    latency: {
      firstTokenP50: percentile(
        rows.flatMap((r) =>
          r.firstTokenMs === null || (r.verdict === 'abstained' && r.abstainedBy === 'retrieval')
            ? []
            : [r.firstTokenMs],
        ),
        50,
      ),
      firstTokenP95: percentile(
        rows.flatMap((r) =>
          r.firstTokenMs === null || r.abstainedBy === 'retrieval' ? [] : [r.firstTokenMs],
        ),
        95,
      ),
      totalP50: percentile(
        rows.map((r) => r.totalMs),
        50,
      ),
      totalP95: percentile(
        rows.map((r) => r.totalMs),
        95,
      ),
      promptTokensP50: percentile(
        rows.flatMap((r) => (r.promptTokens === null ? [] : [r.promptTokens])),
        50,
      ),
    },
    answerable: rows.filter(answerableRow).length,
    promptVersion: PROMPT_VERSION,
    judgeVersion: JUDGE_VERSION,
  };
}

const answerableRow = (r: AnswerRow) => r.kind !== 'unanswerable';
export { answerable };
