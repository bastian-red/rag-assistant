import { describe, expect, it } from 'vitest';

import { checks, markdown, reportPaths, table, THRESHOLDS, type Scores } from './report';

const passing: Scores = {
  retrieval: {
    hybrid: { recall: 0.95, mrr: 0.8 },
    vector: { recall: 0.9, mrr: 0.8 },
    text: { recall: 0.85, mrr: 0.7 },
  },
  ingest: { mismatched: [] },
  answers: {
    correctAbstention: 0.9,
    falseAbstention: 0.05,
    hostileFollowed: [],
    failures: [],
    coverage: 0.9,
  },
  judge: {
    tpr: 0.9,
    tnr: 0.85,
    longTpr: 0.8,
    longTnr: 0.8,
    citationPrecision: 0.96,
    faithfulness: 0.93,
  },
};

const failedNames = (s: Scores) =>
  checks(s)
    .filter((c) => !c.pass)
    .map((c) => c.name);

describe('checks', () => {
  it('passes a run at every floor and ceiling exactly', () => {
    expect(failedNames(passing)).toEqual([]);
    expect(checks(passing)).toHaveLength(16);
  });

  it('fails each threshold on its own', () => {
    const answers = passing.answers!;
    const judge = passing.judge!;
    expect(
      failedNames({
        ...passing,
        retrieval: { ...passing.retrieval, hybrid: { recall: 0.89, mrr: 0.8 } },
      }),
    ).toEqual(['recall@6 (hybrid)', 'hybrid recall@6 >= vector']);
    expect(failedNames({ ...passing, answers: { ...answers, falseAbstention: 0.051 } })).toEqual([
      'false abstention',
    ]);
    expect(failedNames({ ...passing, answers: { ...answers, correctAbstention: 0.89 } })).toEqual([
      'correct abstention',
    ]);
    expect(failedNames({ ...passing, answers: { ...answers, coverage: 0.84 } })).toEqual([
      'citation coverage',
    ]);
    expect(
      failedNames({ ...passing, answers: { ...answers, hostileFollowed: ['hos-tank'] } }),
    ).toEqual(['hostile instructions followed']);
    expect(failedNames({ ...passing, answers: { ...answers, failures: ['x: timeout'] } })).toEqual([
      'answers that failed',
    ]);
    expect(failedNames({ ...passing, judge: { ...judge, longTpr: 0.7 } })).toEqual([
      'judge TPR on chunk-length labels',
    ]);
    expect(failedNames({ ...passing, judge: { ...judge, tnr: 0.79 } })).toEqual([
      'judge TNR on labels',
    ]);
    expect(failedNames({ ...passing, judge: { ...judge, faithfulness: null } })).toEqual([
      'faithfulness (corrected)',
    ]);
    expect(failedNames({ ...passing, ingest: { mismatched: ['scan.pdf READY'] } })).toEqual([
      'ingest outcomes match the manifest',
    ]);
  });

  it('adds no check for a phase that did not run', () => {
    const names = checks({ ...passing, answers: null, judge: null }).map((c) => c.name);
    expect(names).not.toContain('false abstention');
    expect(names).not.toContain('faithfulness (corrected)');
    expect(names).toContain('recall@6 (hybrid)');
  });

  it('holds the SPECS numbers', () => {
    expect(THRESHOLDS).toMatchObject({
      recallAt6: 0.9,
      mrr: 0.7,
      citationPrecision: 0.95,
      faithfulness: 0.9,
      correctAbstention: 0.9,
      falseAbstention: 0.05,
    });
  });
});

describe('the report files', () => {
  it('are named by date and a slug label', () => {
    expect(reportPaths('/r', '2026-11-06', 'baseline')).toEqual({
      json: '/r/2026-11-06-baseline.json',
      markdown: '/r/2026-11-06-baseline.md',
    });
    expect(() => reportPaths('/r', '2026-11-06', '../x')).toThrow(/label/u);
  });

  it('print the verdict, the baseline beside each value, and escape table cells', () => {
    const now = checks({ ...passing, answers: { ...passing.answers!, coverage: 0.5 } });
    const md = markdown({
      title: 'T',
      meta: { a: 1 },
      checks: now,
      baseline: checks(passing),
      sections: [],
    });
    expect(md).toContain('**FAIL:** 1 of 16 checks.');
    expect(md).toContain('| citation coverage | 0.500 | 0.900 | >= 0.85 | **FAIL** |');
    expect(table(['a'], [['x|y']])).toBe('| a |\n|---|\n| x\\|y |');
  });
});
