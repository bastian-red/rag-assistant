/**
 * The question set (`questions.jsonl`), one JSON object per line.
 *
 * - `answerable`: one gold quote that answers it.
 * - `multihop`: two or more quotes, all needed.
 * - `unanswerable`: no quote; the corpus does not hold the answer, often
 *   while holding something close (the Constitution without its amendments,
 *   the Panama Canal but not Suez, the garage notice that is only a scan).
 * - `hostile`: answerable from the hostile document, and `forbidden` lists
 *   what the answer must never contain (the injected instruction's words).
 *
 * A quote names its file and the words as they appear there. It is located
 * in the text ingest stores (`documentText`) with every run of whitespace
 * matched by any run, because a PDF breaks lines where the page did; it must
 * occur exactly once, so a gold span is never a guess between two places.
 *
 * Every question is in `dev` or `test` by a hash of its id: tuning reads dev,
 * the thresholds are reported on both, and no number is tuned on the
 * questions it is then judged by.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { codePointOffsets } from '@rag/chunker';
import { z } from 'zod';

import { EVALS_ROOT } from './corpus';

export const QUESTION_KINDS = ['answerable', 'multihop', 'unanswerable', 'hostile'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

const quoteSchema = z.object({ file: z.string().min(1), quote: z.string().min(8) }).strict();

export const questionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    kind: z.enum(QUESTION_KINDS),
    question: z.string().min(8),
    gold: z.array(quoteSchema),
    forbidden: z.array(z.string().min(3)).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const want = { answerable: [1, 1], multihop: [2, 5], unanswerable: [0, 0], hostile: [1, 1] }[
      q.kind
    ];
    if (q.gold.length < want[0]! || q.gold.length > want[1]!) {
      ctx.addIssue({
        code: 'custom',
        message: `${q.kind} needs ${String(want[0])}-${String(want[1])} gold quotes`,
      });
    }
    if ((q.kind === 'hostile') !== (q.forbidden !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'forbidden is for hostile questions, and only them',
      });
    }
  });

export type Question = z.infer<typeof questionSchema>;
export type Split = 'dev' | 'test';

/** By the first byte of sha256(id): stable, and blind to the question's wording. */
export function splitOf(id: string): Split {
  return createHash('sha256').update(id).digest()[0]! % 2 === 0 ? 'dev' : 'test';
}

export function parseQuestions(text: string): Question[] {
  const questions: Question[] = [];
  const ids = new Set<string>();
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const q = questionSchema.parse(JSON.parse(line));
    if (ids.has(q.id)) throw new Error(`questions.jsonl:${String(index + 1)}: ${q.id} twice`);
    ids.add(q.id);
    questions.push(q);
  }
  return questions;
}

export function loadQuestions(path = join(EVALS_ROOT, 'questions.jsonl')): Question[] {
  return parseQuestions(readFileSync(path, 'utf8'));
}

/** A gold span: the document and the code-point range of the quote in its stored text. */
export interface GoldSpan {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Where `quote` sits in `text`, as code points, with whitespace runs matched
 * loosely. Throws unless it occurs exactly once.
 */
export function locate(text: string, quote: string, label = quote): { start: number; end: number } {
  const words = quote.trim().split(/\s+/u).map(escape);
  const pattern = new RegExp(words.join('\\s+'), 'gu');
  const hits = [...text.matchAll(pattern)];
  if (hits.length !== 1) {
    throw new Error(`gold quote found ${String(hits.length)} times, needs exactly 1: "${label}"`);
  }
  const hit = hits[0]!;
  const points = codePointOffsets(text);
  return { start: points(hit.index), end: points(hit.index + hit[0].length) };
}

/** Every question's gold spans, located in the stored texts (`file` -> text). */
export function goldSpans(
  questions: readonly Question[],
  texts: ReadonlyMap<string, string | null>,
): Map<string, GoldSpan[]> {
  const spans = new Map<string, GoldSpan[]>();
  for (const q of questions) {
    spans.set(
      q.id,
      q.gold.map(({ file, quote }) => {
        const text = texts.get(file);
        if (text === undefined) throw new Error(`${q.id}: no corpus file ${file}`);
        if (text === null)
          throw new Error(`${q.id}: ${file} is refused by ingest, so it holds no answer`);
        return { file, ...locate(text, quote, `${q.id}: ${quote}`) };
      }),
    );
  }
  return spans;
}
