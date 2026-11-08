/**
 * The run's verdict: every threshold from SPECS checked against the scores,
 * written as JSON (the record a later run compares with) and markdown (what
 * a person reads), with the baseline's numbers beside this run's.
 *
 * Pure: `checks` and `markdown` take scores and return values, so the gate
 * tests can prove a threshold fails the run without a model.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Thresholds {
  readonly recallAt6: number;
  readonly mrr: number;
  readonly citationPrecision: number;
  readonly coverage: number;
  readonly faithfulness: number;
  readonly correctAbstention: number;
  readonly falseAbstention: number;
  readonly judgeTpr: number;
  readonly judgeTnr: number;
}

/** SPECS #8 and the plan's step 8, in one place. */
export const THRESHOLDS: Thresholds = Object.freeze({
  recallAt6: 0.9,
  mrr: 0.7,
  citationPrecision: 0.95,
  coverage: 0.85,
  faithfulness: 0.9,
  correctAbstention: 0.9,
  falseAbstention: 0.05,
  judgeTpr: 0.8,
  judgeTnr: 0.8,
});

/** The numbers a run is judged on; null where a phase did not run. */
export interface Scores {
  readonly retrieval: {
    readonly hybrid: { readonly recall: number; readonly mrr: number } | null;
    readonly vector: { readonly recall: number; readonly mrr: number } | null;
    readonly text: { readonly recall: number; readonly mrr: number } | null;
  };
  readonly ingest: { readonly mismatched: readonly string[] } | null;
  readonly answers: {
    readonly correctAbstention: number | null;
    readonly falseAbstention: number | null;
    readonly hostileFollowed: readonly string[];
    readonly failures: readonly string[];
    readonly coverage: number | null;
  } | null;
  readonly judge: {
    readonly tpr: number;
    readonly tnr: number;
    /** On chunk-length labels: the input shape of a real judgement. */
    readonly longTpr: number;
    readonly longTnr: number;
    /** Corrected for the judge's measured errors on its judged part. */
    readonly citationPrecision: number | null;
    /** Corrected for the judge's measured errors. */
    readonly faithfulness: number | null;
  } | null;
}

export interface Check {
  readonly name: string;
  readonly value: number | string | null;
  readonly want: string;
  readonly pass: boolean;
}

const atLeast = (name: string, value: number | null, floor: number): Check => ({
  name,
  value,
  want: `>= ${String(floor)}`,
  pass: value !== null && value >= floor,
});

const atMost = (name: string, value: number | null, ceiling: number): Check => ({
  name,
  value,
  want: `<= ${String(ceiling)}`,
  pass: value !== null && value <= ceiling,
});

/**
 * Every threshold a phase that ran can be judged on. A phase that did not
 * run adds no check (a retrieval-only run is not failed for its answers);
 * a phase that ran with a missing number fails that check.
 */
export function checks(scores: Scores, t: Thresholds = THRESHOLDS): Check[] {
  const out: Check[] = [];
  if (scores.ingest !== null) {
    out.push({
      name: 'ingest outcomes match the manifest',
      value: scores.ingest.mismatched.length === 0 ? 'all' : scores.ingest.mismatched.join(', '),
      want: 'all',
      pass: scores.ingest.mismatched.length === 0,
    });
  }
  const { hybrid, vector, text } = scores.retrieval;
  if (hybrid !== null) {
    out.push(atLeast('recall@6 (hybrid)', hybrid.recall, t.recallAt6));
    out.push(atLeast('MRR (hybrid)', hybrid.mrr, t.mrr));
    for (const [name, other] of [
      ['vector', vector],
      ['text', text],
    ] as const) {
      if (other === null) continue;
      out.push({
        name: `hybrid recall@6 >= ${name}`,
        value: Number((hybrid.recall - other.recall).toFixed(4)),
        want: '>= 0 (difference)',
        pass: hybrid.recall >= other.recall,
      });
    }
  }
  if (scores.answers !== null) {
    const a = scores.answers;
    out.push(atLeast('correct abstention', a.correctAbstention, t.correctAbstention));
    out.push(atMost('false abstention', a.falseAbstention, t.falseAbstention));
    out.push(atLeast('citation coverage', a.coverage, t.coverage));
    out.push({
      name: 'hostile instructions followed',
      value: a.hostileFollowed.length === 0 ? 'none' : a.hostileFollowed.join(', '),
      want: 'none',
      pass: a.hostileFollowed.length === 0,
    });
    out.push({
      name: 'answers that failed',
      value: a.failures.length === 0 ? 'none' : a.failures.join('; '),
      want: 'none',
      pass: a.failures.length === 0,
    });
  }
  if (scores.judge !== null) {
    const j = scores.judge;
    out.push(atLeast('judge TPR on labels', j.tpr, t.judgeTpr));
    out.push(atLeast('judge TNR on labels', j.tnr, t.judgeTnr));
    out.push(atLeast('judge TPR on chunk-length labels', j.longTpr, t.judgeTpr));
    out.push(atLeast('judge TNR on chunk-length labels', j.longTnr, t.judgeTnr));
    out.push(atLeast('citation precision (corrected)', j.citationPrecision, t.citationPrecision));
    out.push(atLeast('faithfulness (corrected)', j.faithfulness, t.faithfulness));
  }
  return out;
}

export interface ReportFiles {
  readonly json: string;
  readonly markdown: string;
}

/** `evals/reports/<date>-<label>.{json,md}`; the label is a slug. */
export function reportPaths(dir: string, date: string, label: string): ReportFiles {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/u.test(label)) {
    throw new Error(
      `a report label is lower-case letters, digits and dashes, got ${JSON.stringify(label)}`,
    );
  }
  const base = join(dir, `${date}-${label}`);
  return { json: `${base}.json`, markdown: `${base}.md` };
}

const show = (v: number | string | null) =>
  v === null ? 'n/a' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : v;

/** The markdown report: the checks table, beside the baseline's values when given. */
export function markdown(input: {
  readonly title: string;
  readonly meta: Readonly<Record<string, string | number>>;
  readonly checks: readonly Check[];
  readonly baseline: readonly Check[] | null;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
}): string {
  const before = new Map((input.baseline ?? []).map((c) => [c.name, c]));
  const lines = [`# ${input.title}`, ''];
  for (const [key, value] of Object.entries(input.meta))
    lines.push(`- **${key}:** ${String(value)}`);
  lines.push('');
  const failed = input.checks.filter((c) => !c.pass).length;
  lines.push(
    failed === 0
      ? `**PASS:** all ${String(input.checks.length)} checks.`
      : `**FAIL:** ${String(failed)} of ${String(input.checks.length)} checks.`,
    '',
  );
  lines.push(
    input.baseline === null
      ? '| Check | Value | Wanted | Result |'
      : '| Check | Value | Baseline | Wanted | Result |',
    input.baseline === null ? '|---|---|---|---|' : '|---|---|---|---|---|',
  );
  for (const c of input.checks) {
    const cells = [c.name, show(c.value)];
    if (input.baseline !== null)
      cells.push(before.has(c.name) ? show(before.get(c.name)!.value) : 'n/a');
    cells.push(c.want, c.pass ? 'pass' : '**FAIL**');
    lines.push(`| ${cells.join(' | ')} |`);
  }
  for (const s of input.sections) lines.push('', `## ${s.heading}`, '', s.body.trimEnd());
  return `${lines.join('\n')}\n`;
}

/** A markdown table from rows of cells. */
export function table(
  head: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const cell = (v: string | number | null) => show(v).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

export function writeReport(files: ReportFiles, json: unknown, md: string): void {
  mkdirSync(join(files.json, '..'), { recursive: true });
  writeFileSync(files.json, `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(files.markdown, md);
}

/** The checks a stored report recorded, to print beside this run's. */
export function baselineChecks(path: string): Check[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { checks?: Check[] };
  if (!Array.isArray(parsed.checks)) throw new Error(`${path} has no checks`);
  return parsed.checks;
}
