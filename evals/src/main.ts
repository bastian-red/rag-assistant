/**
 * The eval lane's entry point. Run through `pnpm evals` (scripts/evals.sh),
 * which builds, points DATABASE_URL at rag_eval and refuses the fake model.
 *
 *   node dist/main.js --label baseline
 *   node dist/main.js --phases retrieval,sweep --chunks 400:60,250:40
 *   node dist/main.js --phases retrieval,answers --limit 8 --no-fail
 *
 * Phases: retrieval (always), sweep, answers, judge (needs answers).
 * Exit 0 when every check passes, 1 when one fails, 2 on a usage error.
 */
import { parseArgs } from 'node:util';

import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from '@rag/chunker';
import { createPrismaClient } from '@rag/db';
import { createLlm, createOllama, fakeDigest } from '@rag/llm';
import { cachedSpace, RETRIEVAL_DEFAULTS, type RetrievalOptions } from '@rag/retrieval';
import { embeddingSpace } from '@rag/shared';

import { documentText, EVALS_ROOT, loadManifest } from './corpus';
import { JUDGE_VERSION, loadLabels } from './judge';
import { goldSpans, loadQuestions } from './questions';
import {
  baselineChecks,
  checks,
  markdown,
  reportPaths,
  table,
  writeReport,
  type Scores,
} from './report';
import {
  answerScores,
  calibrate,
  judgeAnswers,
  runAnswers,
  runRetrieval,
  validateJudge,
  type RetrievalScores,
} from './run';
import { PROGRESS_LOG } from './progress';
import { library, ownerEmail } from './setup';

const PHASES = ['retrieval', 'sweep', 'answers', 'judge'] as const;
type Phase = (typeof PHASES)[number];

function usage(message: string): never {
  console.error(`evals: ${message}`);
  process.exit(2);
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '')
    usage(`${name} must be set (scripts/evals.sh loads .env)`);
  return value;
}

function chunkConfigs(spec: string): ChunkOptions[] {
  return spec.split(',').map((pair) => {
    const m = /^(\d+):(\d+)$/u.exec(pair.trim());
    if (m === null) usage(`--chunks takes target:overlap pairs, got "${pair}"`);
    return { ...DEFAULT_CHUNK_OPTIONS, targetTokens: Number(m[1]), overlapTokens: Number(m[2]) };
  });
}

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) usage(`--${name} takes a number, got "${value}"`);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      label: { type: 'string', default: 'run' },
      phases: { type: 'string', default: 'retrieval,answers,judge' },
      chunks: { type: 'string' },
      limit: { type: 'string' },
      baseline: { type: 'string' },
      'min-similarity': { type: 'string' },
      'context-tokens': { type: 'string' },
      k: { type: 'string' },
      'rrf-k': { type: 'string' },
      'no-fail': { type: 'boolean', default: false },
      'no-write': { type: 'boolean', default: false },
    },
  });
  const phases = new Set(
    values.phases.split(',').map((p) => {
      if (!(PHASES as readonly string[]).includes(p))
        usage(`unknown phase "${p}" (${PHASES.join(', ')})`);
      return p as Phase;
    }),
  );
  phases.add('retrieval');
  if (phases.has('judge') && !phases.has('answers'))
    usage('the judge phase reads the answers phase');

  const options: Partial<RetrievalOptions> = Object.fromEntries(
    Object.entries({
      minSimilarity: number(values['min-similarity'], 'min-similarity'),
      contextTokens: number(values['context-tokens'], 'context-tokens'),
      k: number(values.k, 'k'),
      rrfK: number(values['rrf-k'], 'rrf-k'),
    }).filter(([, v]) => v !== undefined),
  );
  const configs = chunkConfigs(
    values.chunks ??
      `${String(DEFAULT_CHUNK_OPTIONS.targetTokens)}:${String(DEFAULT_CHUNK_OPTIONS.overlapTokens)}`,
  );
  const limit = number(values.limit, 'limit');

  const ollamaUrl = env('OLLAMA_URL');
  const chatModel = env('CHAT_MODEL');
  const embedModel = env('EMBED_MODEL');
  const judgeModel = process.env.EVAL_JUDGE_MODEL || chatModel;
  const uploadDir = env('UPLOAD_DIR');
  const started = Date.now();

  // A CPU-only model server takes up to ~3 min for a first token on a full
  // pack (scripts/model-bench.mjs); the eval waits for it rather than score
  // a timeout as a failed answer. The API keeps its own 180 s.
  const ollama = createOllama({ baseUrl: ollamaUrl, chat: { firstTokenTimeoutMs: 600_000 } });
  const llm = createLlm({ baseUrl: ollamaUrl, chatModel, embedModel }, ollama);
  const judgeLlm = createLlm({ baseUrl: ollamaUrl, chatModel: judgeModel, embedModel }, ollama);
  const space = cachedSpace(() => llm.embeddingSpace());
  const spaceNow = await space();
  if (spaceNow === embeddingSpace(embedModel, fakeDigest(embedModel))) {
    usage(`${ollamaUrl} is the fake model server: the eval lane measures the real models`);
  }

  const corpus = loadManifest();
  let questions = loadQuestions();
  if (limit !== undefined) {
    // An even spread over the kinds, so a short run still sees each.
    const kinds = [...new Set(questions.map((q) => q.kind))];
    const per = Math.max(1, Math.floor(limit / kinds.length));
    questions = kinds.flatMap((kind) => questions.filter((q) => q.kind === kind).slice(0, per));
  }
  const texts = new Map<string, string | null>();
  for (const doc of corpus) texts.set(doc.file, await documentText(doc));
  const gold = goldSpans(questions, texts);

  const prisma = createPrismaClient();
  try {
    const deps = { prisma, embed: (t: readonly string[]) => llm.embed(t), embeddingSpace: space };
    const libraries = [];
    for (const chunkOptions of configs) {
      console.info(`evals: library ${ownerEmail(chunkOptions)}`);
      libraries.push(
        await library(
          { ...deps, uploadDir, log: (line) => console.info(line) },
          corpus,
          chunkOptions,
        ),
      );
    }
    const primary = libraries[0]!;

    // Retrieval, every chunk configuration, every mode.
    const retrievals = [];
    for (const lib of libraries) {
      const run = await runRetrieval(
        deps,
        lib,
        questions,
        gold,
        options,
        undefined,
        `eval retrieval t${String(lib.chunkOptions.targetTokens)}`,
      );
      retrievals.push({ chunkOptions: lib.chunkOptions, ...run });
    }
    const main = retrievals[0]!;
    const threshold = calibrate(
      main.rows,
      options.minSimilarity ?? RETRIEVAL_DEFAULTS.minSimilarity,
    );

    // The sweep: hybrid only, one knob at a time from the defaults.
    const sweep: RetrievalScores[] = [];
    if (phases.has('sweep')) {
      const grid: Partial<RetrievalOptions>[] = [
        ...[4, 8].map((k) => ({ k })),
        ...[20, 100].map((rrfK) => ({ rrfK })),
        ...[1_600, 2_200].map((contextTokens) => ({ contextTokens })),
      ];
      for (const knob of grid) {
        const run = await runRetrieval(
          deps,
          primary,
          questions,
          gold,
          { ...options, ...knob },
          ['hybrid'],
          `eval sweep ${JSON.stringify(knob)}`,
        );
        sweep.push(run.scores[0]!);
      }
    }

    let answerRows = null;
    let judged = null;
    let judgeCheck = null;
    if (phases.has('answers')) {
      answerRows = await runAnswers(llm, deps, primary, questions, options);
      if (phases.has('judge')) {
        judgeCheck = await validateJudge(judgeLlm, loadLabels());
        // Corrected by the chunk-length measurement: a run's judge reads whole sources.
        judged = await judgeAnswers(judgeLlm, answerRows, gold, judgeCheck.long);
      }
    }
    const answered = answerRows === null ? null : answerScores(answerRows);

    const byMode = (mode: RetrievalOptions['mode']) => {
      const s = main.scores.find((x) => x.mode === mode);
      return s === undefined ? null : { recall: s.recall, mrr: s.mrr };
    };
    const scores: Scores = {
      retrieval: { hybrid: byMode('hybrid'), vector: byMode('vector'), text: byMode('text') },
      ingest: {
        mismatched: primary.outcomes
          .filter((o) => o.status !== o.expected)
          .map((o) => `${o.file} ${o.status}`),
      },
      answers:
        answered === null
          ? null
          : {
              correctAbstention: answered.abstention.all.correctAbstention,
              falseAbstention: answered.abstention.all.falseAbstention,
              hostileFollowed: answered.hostile.followed,
              failures: answered.failures,
              coverage: judged?.coverage.value ?? coverageOnly(answerRows!),
            },
      judge:
        judged === null || judgeCheck === null
          ? null
          : {
              tpr: judgeCheck.agreement.tpr,
              tnr: judgeCheck.agreement.tnr,
              longTpr: judgeCheck.long.tpr,
              longTnr: judgeCheck.long.tnr,
              citationPrecision: judged.precision.value,
              faithfulness: judged.faithfulness.corrected,
            },
    };
    const result = checks(scores);
    const date = new Date().toISOString().slice(0, 10);
    const files = reportPaths(`${EVALS_ROOT}/reports`, date, values.label);
    const baseline = values.baseline === undefined ? null : baselineChecks(values.baseline);
    const effective = { ...RETRIEVAL_DEFAULTS, ...options };
    const meta = {
      date,
      label: values.label,
      'chat model': chatModel,
      'judge model': `${judgeModel} (judge v${String(JUDGE_VERSION)})`,
      'embedding space': spaceNow,
      'prompt version': answered?.promptVersion ?? 'n/a',
      questions: questions.length,
      'retrieval options': JSON.stringify({
        k: effective.k,
        rrfK: effective.rrfK,
        contextTokens: effective.contextTokens,
        minSimilarity: effective.minSimilarity,
      }),
      chunks: configs.map((c) => `${String(c.targetTokens)}/${String(c.overlapTokens)}`).join(', '),
      'wall time': `${String(Math.round((Date.now() - started) / 1000))} s`,
    };

    const sections = [
      {
        heading: 'Retrieval by mode and chunk size',
        body: table(
          ['chunks', 'mode', 'recall@6', 'MRR', 'questions', 'p95 ms'],
          retrievals.flatMap((r) =>
            r.scores.map((s) => [
              `${String(r.chunkOptions.targetTokens)}/${String(r.chunkOptions.overlapTokens)}`,
              s.mode,
              s.recall,
              s.mrr,
              s.questions,
              s.p95Ms,
            ]),
          ),
        ),
      },
      {
        heading: 'Abstain threshold (hybrid best similarity, chosen on dev)',
        body: [
          `Chosen ${String(threshold.chosen)} (current ${String(threshold.current)}) from ${String(threshold.candidates)} candidate cuts.`,
          '',
          table(
            ['threshold', 'split', 'correct abstention', 'false abstention'],
            (['dev', 'test', 'all'] as const).flatMap((split) => [
              [
                threshold.chosen,
                split,
                threshold.chosenScores[split].correctAbstention,
                threshold.chosenScores[split].falseAbstention,
              ],
              [
                threshold.current,
                split,
                threshold.currentScores[split].correctAbstention,
                threshold.currentScores[split].falseAbstention,
              ],
            ]),
          ),
          '',
          `Lowest answerable: ${threshold.lowestAnswerable.map((r) => `${r.id} ${String(r.best)}`).join(', ')}.`,
          `Highest unanswerable: ${threshold.highestUnanswerable.map((r) => `${r.id} ${String(r.best)}`).join(', ')}.`,
        ].join('\n'),
      },
      ...(sweep.length === 0
        ? []
        : [
            {
              heading: 'Sweep (hybrid, one knob from the defaults)',
              body: table(
                ['change', 'recall@6', 'MRR', 'p95 ms'],
                sweep.map((s) => [
                  JSON.stringify(
                    Object.fromEntries(
                      Object.entries(s.options).filter(([k]) => k !== 'minSimilarity'),
                    ),
                  ),
                  s.recall,
                  s.mrr,
                  s.p95Ms,
                ]),
              ),
            },
          ]),
      ...(answered === null
        ? []
        : [
            {
              heading: 'Answers',
              body: [
                `Abstained by retrieval: ${answered.abstention.byRetrieval.join(', ') || 'none'}.`,
                `Abstained by the model: ${answered.abstention.byModel.join(', ') || 'none'}.`,
                `Hostile: ${String(answered.hostile.questions)} asked, ${String(answered.hostile.answered)} answered, followed: ${answered.hostile.followed.join(', ') || 'none'}.`,
                `Latency: first token p50 ${ms(answered.latency.firstTokenP50)}, p95 ${ms(answered.latency.firstTokenP95)}; whole answer p50 ${ms(answered.latency.totalP50)}, p95 ${ms(answered.latency.totalP95)}; prompt p50 ${String(answered.latency.promptTokensP50 ?? 'n/a')} tokens.`,
                '',
                table(
                  ['id', 'kind', 'verdict', 'claims', 'cited', 'citations', 'first token', 'total'],
                  answerRows!.map((r) => [
                    r.id,
                    r.kind,
                    r.abstainedBy === null ? r.verdict : `${r.verdict} (${r.abstainedBy})`,
                    r.claims,
                    r.citedClaims,
                    r.citations,
                    ms(r.firstTokenMs),
                    ms(r.totalMs),
                  ]),
                ),
              ].join('\n'),
            },
          ]),
      ...(judged === null || judgeCheck === null
        ? []
        : [
            {
              heading: 'Judge',
              body: [
                `Labels: TPR ${judgeCheck.agreement.tpr.toFixed(3)}, TNR ${judgeCheck.agreement.tnr.toFixed(3)} on all ${String(judgeCheck.agreement.labels)}; TPR ${judgeCheck.long.tpr.toFixed(3)}, TNR ${judgeCheck.long.tnr.toFixed(3)} on the ${String(judgeCheck.long.labels)} chunk-length ones (these correct the scores below); ${String(judgeCheck.unparsed)} unreadable; missed ${judgeCheck.misses.join(', ') || 'none'}.`,
                `Faithfulness: ${String(judged.faithfulness.supported)} of ${String(judged.faithfulness.claims)} claims supported (observed ${show(judged.faithfulness.observed)}, corrected ${show(judged.faithfulness.corrected)}).`,
                `Citation precision: ${String(judged.precision.onGold)} on a gold span + ${String(judged.precision.judgedSupporting)} judged supporting, of ${String(judged.precision.citations)} (observed ${show(judged.precision.observed)}, corrected ${show(judged.precision.value)}).`,
                `Unreadable judge replies on answers: ${String(judged.unparsed)}.`,
                '',
                'Unsupported claims:',
                '',
                ...judged.perQuestion.flatMap((q) => q.unsupported.map((c) => `- ${q.id}: ${c}`)),
                '',
                'Imprecise citations (the claim, then the start of the source it cited):',
                '',
                ...judged.precision.imprecise.map(
                  (c) =>
                    `- ${c.id} [S${String(c.marker)}]: ${c.claim} | cited: ${c.source.replace(/\s+/gu, ' ').slice(0, 160)}…`,
                ),
              ].join('\n'),
            },
          ]),
    ];

    const md = markdown({
      title: `Eval ${date} ${values.label}`,
      meta,
      checks: result,
      baseline,
      sections,
    });
    if (!values['no-write']) {
      writeReport(
        files,
        {
          meta,
          checks: result,
          scores,
          retrieval: retrievals.map((r) => ({
            chunkOptions: r.chunkOptions,
            scores: r.scores,
            rows: r.rows,
          })),
          threshold,
          sweep,
          ingest: libraries.map((l) => ({
            chunkOptions: l.chunkOptions,
            outcomes: l.outcomes,
            chunks: l.chunks.size,
            ingested: l.ingested,
            ingestMs: l.ingestMs,
          })),
          answers: answerRows?.map(({ packed: _packed, ...rest }) => rest) ?? null,
          answerScores: answered,
          judge: judgeCheck === null ? null : { ...judgeCheck, answers: judged },
        },
        md,
      );
      console.info(`evals: wrote ${files.markdown} and ${files.json}`);
    }
    console.info(md);
    console.info(`evals: progress was logged to ${PROGRESS_LOG}`);
    const failed = result.filter((c) => !c.pass);
    if (failed.length > 0) {
      console.error(
        `evals: ${String(failed.length)} check(s) failed: ${failed.map((c) => c.name).join('; ')}`,
      );
      return values['no-fail'] ? 0 : 1;
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

function coverageOnly(rows: readonly { claims: number; citedClaims: number }[]): number | null {
  const claims = rows.reduce((n, r) => n + r.claims, 0);
  return claims === 0 ? null : rows.reduce((n, r) => n + r.citedClaims, 0) / claims;
}

const ms = (v: number | null) => (v === null ? 'n/a' : `${(v / 1000).toFixed(1)} s`);
const show = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
