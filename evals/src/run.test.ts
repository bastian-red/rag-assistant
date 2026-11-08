import { describe, expect, it } from 'vitest';

import { splitOf } from './questions';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatEvent, ChatMessage } from '@rag/shared';

import { LONG_PASSAGE_CHARS, type Label } from './judge';
import { answerScores, calibrate, validateJudge, type AnswerRow, type RetrievalRow } from './run';

// Ids whose split is known, found by splitOf rather than assumed.
const ids = (split: 'dev' | 'test', n: number) => {
  const out: string[] = [];
  for (let i = 0; out.length < n; i += 1)
    if (splitOf(`q${String(i)}`) === split) out.push(`q${String(i)}`);
  return out;
};

const row = (id: string, kind: RetrievalRow['kind'], best: number): RetrievalRow => ({
  id,
  kind,
  split: splitOf(id),
  mode: 'hybrid',
  best,
  recall: null,
  rr: null,
  sources: 6,
  ms: 10,
});

describe('calibrate', () => {
  it('chooses on dev only and scores the choice on test', () => {
    const [d1, d2, d3, d4] = ids('dev', 4);
    const [t1, t2] = ids('test', 2);
    const rows = [
      row(d1!, 'unanswerable', 0.3),
      row(d2!, 'unanswerable', 0.4),
      row(d3!, 'answerable', 0.6),
      row(d4!, 'answerable', 0.7),
      // A test answerable question under the dev cut: it must not move the
      // choice, and it must show as false abstention on test.
      row(t1!, 'answerable', 0.45),
      row(t2!, 'unanswerable', 0.2),
      { ...row(d1!, 'answerable', 0.1), mode: 'vector' as const },
    ];
    const c = calibrate(rows, 0.43);
    expect(c.chosen).toBe(0.5); // midpoint of 0.4 and 0.6
    expect(c.chosenScores.dev).toMatchObject({ correctAbstention: 1, falseAbstention: 0 });
    expect(c.chosenScores.test).toMatchObject({ correctAbstention: 1, falseAbstention: 1 });
    expect(c.currentScores.dev).toMatchObject({ correctAbstention: 1, falseAbstention: 0 });
    expect(c.lowestAnswerable[0]).toEqual({ id: t1, best: 0.45 });
  });
});

const answerRow = (over: Partial<AnswerRow>): AnswerRow => ({
  id: 'a',
  kind: 'answerable',
  split: 'dev',
  status: 'DONE',
  verdict: 'answered',
  abstainedBy: null,
  bestSimilarity: 0.6,
  content: '',
  sources: 3,
  citations: 1,
  dropped: 0,
  claims: 1,
  citedClaims: 1,
  forbiddenHit: null,
  promptTokens: 100,
  outputTokens: 10,
  firstTokenMs: 1000,
  totalMs: 2000,
  failure: null,
  claimList: [],
  packed: [],
  ...over,
});

describe('answerScores', () => {
  it('counts both kinds of abstention, hostile hits and failures', () => {
    const s = answerScores([
      answerRow({ id: 'u1', kind: 'unanswerable', verdict: 'abstained', abstainedBy: 'model' }),
      answerRow({
        id: 'u2',
        kind: 'unanswerable',
        verdict: 'abstained',
        abstainedBy: 'retrieval',
        firstTokenMs: null,
      }),
      answerRow({ id: 'u3', kind: 'unanswerable' }),
      answerRow({ id: 'h1', kind: 'hostile', forbiddenHit: 'example.net' }),
      answerRow({ id: 'f1', status: 'FAILED', failure: 'timeout' }),
    ]);
    expect(s.abstention.all).toMatchObject({ correctAbstention: 2 / 3, falseAbstention: 0 });
    expect(s.abstention.byModel).toEqual(['u1']);
    expect(s.abstention.byRetrieval).toEqual(['u2']);
    expect(s.hostile).toEqual({ questions: 1, followed: ['h1'], answered: 1 });
    expect(s.failures).toEqual(['f1: timeout']);
  });
});

describe('validateJudge', () => {
  const label = (id: string, supported: boolean, long: boolean): Label => ({
    id,
    file: 'a.md',
    passage: long ? 'x'.repeat(LONG_PASSAGE_CHARS) : 'A short passage.',
    claim: `claim ${id}`,
    supported,
    how: supported ? 'paraphrase' : 'number',
  });
  // Right on short passages, "supported" on every long one.
  const labels = [
    label('l01', true, false),
    label('l02', false, false),
    label('l03', true, true),
    label('l04', false, true),
  ];
  const chat = async function* (messages: readonly ChatMessage[]): AsyncGenerator<ChatEvent> {
    const user = messages[1]!.content;
    const truth = labels.find((l) => user.includes(l.claim))!;
    const said = user.includes('x'.repeat(LONG_PASSAGE_CHARS)) ? true : truth.supported;
    yield { type: 'token', text: `{"verdicts":[{"claim":1,"supported":${String(said)}}]}` };
  };

  it('measures chunk-length labels apart, so a judge weak on long passages shows it', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'rag-eval-')), 'progress.log');
    const result = await validateJudge({ chat }, labels, log);
    expect(result.agreement).toMatchObject({ labels: 4, tpr: 1, tnr: 0.5 });
    expect(result.long).toMatchObject({ labels: 2, tpr: 1, tnr: 0 });
    expect(result.misses).toEqual(['l04 (number)']);
  });
});
