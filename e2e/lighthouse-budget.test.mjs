/**
 * The budget arithmetic, without a browser: the median run is the median, a
 * miss names the audits that cost the points, and each budget's edge falls on
 * the side the budget says ("LCP < 2.0 s", so 2000 ms fails), and SEO, which
 * a noindex page fails on purpose, never fails a page.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BUDGET, judge, medianRun } from './lighthouse-budget.mjs';

function lhr({
  perf = 1,
  a11y = 1,
  bp = 1,
  seo = 1,
  lcp = 1000,
  cls = 0,
  tbt = 0,
  lost = [],
} = {}) {
  const audits = {
    'largest-contentful-paint': { id: 'largest-contentful-paint', score: 1, numericValue: lcp },
    'cumulative-layout-shift': { id: 'cumulative-layout-shift', score: 1, numericValue: cls },
    'total-blocking-time': {
      id: 'total-blocking-time',
      score: tbt > 200 ? 0.3 : 1,
      numericValue: tbt,
      displayValue: `${tbt} ms`,
    },
  };
  for (const id of lost) audits[id] = { id, score: 0 };
  const refs = (ids) => ids.map((id) => ({ id, weight: 1 }));
  return {
    categories: {
      performance: {
        score: perf,
        auditRefs: refs(['total-blocking-time', 'largest-contentful-paint']),
      },
      accessibility: { score: a11y, auditRefs: refs(lost) },
      'best-practices': { score: bp, auditRefs: [] },
      seo: { score: seo, auditRefs: [] },
    },
    audits,
  };
}

test('the median run is the middle performance score, whatever the order', () => {
  assert.equal(medianRun([lhr({ perf: 0.9 }), lhr({ perf: 0.99 }), lhr({ perf: 0.95 })]), 2);
  assert.equal(medianRun([lhr({ perf: 0.95 }), lhr({ perf: 0.9 }), lhr({ perf: 0.99 })]), 0);
  assert.equal(medianRun([lhr({ perf: 0.8 })]), 0);
  assert.throws(() => medianRun([]));
});

test('a page inside every budget passes', () => {
  assert.deepEqual(judge(lhr({ perf: 0.85, lcp: 1999, cls: 0.049 })).failures, []);
});

test('each budget fails on its own edge', () => {
  assert.equal(judge(lhr({ lcp: BUDGET.lcpMs })).failures.length, 1);
  assert.equal(judge(lhr({ cls: BUDGET.cls })).failures.length, 1);
  assert.equal(judge(lhr({ perf: 0.84 })).failures.length, 1);
  assert.equal(judge(lhr({ a11y: 0.99 })).failures.length, 1);
  assert.equal(judge(lhr({ bp: 0.96 })).failures.length, 1);
});

test('a noindex page is not failed for its SEO score', () => {
  assert.deepEqual(judge(lhr({ seo: 0.58 })).failures, []);
  assert.equal('seo' in BUDGET, false);
});

test('a miss names what cost the points', () => {
  const [perf] = judge(lhr({ perf: 0.79, tbt: 890 })).failures;
  assert.equal(perf, 'performance 79 < 85: total-blocking-time (890 ms)');
  const [a11y] = judge(lhr({ a11y: 0.9, lost: ['color-contrast'] })).failures;
  assert.equal(a11y, 'accessibility 90 < 100: color-contrast');
});
