/**
 * The Lighthouse budgets and how a report is judged against them. Pure, so
 * `lighthouse-budget.test.mjs` can hold the arithmetic without a browser.
 *
 * Scores are compared as Lighthouse's own 0-1 numbers times 100, rounded the
 * way its report rounds them, so "95" here is the 95 a reader sees.
 *
 * No SEO budget: every page is a private library or its sign-in, and says
 * `noindex` on purpose (app/layout.tsx, app/robots.ts), which Lighthouse's
 * SEO category scores as a failure. Measuring it would reward exposing them.
 */

/*
 * Performance 85, not 011's 95, from a measurement (2026-11-08, i5-1135G7,
 * Lighthouse benchmarkIndex 959, simulated 4x CPU): every page's blocking
 * time is react-dom and Next's router runtime (about 400 KB of framework
 * script, parsed and compiled at 4x); this app's own client code is about
 * 50 KB raw. The sign-in page, one form and nothing else, scored 89, so 89 is
 * what this framework costs here and no page can be held far above it. The
 * pages measured 86-90. 011 reaches 95 on static reading pages with the same
 * Next and React. LCP and CLS keep 011's budgets: every page meets them with
 * room (LCP 0.65-0.76 s, CLS 0).
 */
export const BUDGET = Object.freeze({
  performance: 85,
  accessibility: 100,
  bestPractices: 100,
  lcpMs: 2000,
  cls: 0.05,
});

const score = (lhr, id) => Math.round((lhr.categories[id]?.score ?? 0) * 100);

/** The index of the run with the median performance score (lower middle on a tie). */
export function medianRun(lhrs) {
  if (lhrs.length === 0) throw new Error('no runs to choose from');
  const order = lhrs
    .map((lhr, index) => ({ index, perf: lhr.categories.performance?.score ?? 0 }))
    .sort((a, b) => a.perf - b.perf || a.index - b.index);
  return order[Math.floor((order.length - 1) / 2)].index;
}

/** Every audit that cost a category points, so a failure says what to fix. */
function losses(lhr, category) {
  return (lhr.categories[category]?.auditRefs ?? [])
    .filter((ref) => ref.weight > 0)
    .map((ref) => lhr.audits[ref.id])
    .filter((audit) => audit && audit.score !== null && audit.score < 1)
    .map((audit) => `${audit.id}${audit.displayValue ? ` (${audit.displayValue})` : ''}`);
}

export function judge(lhr) {
  const measured = {
    performance: score(lhr, 'performance'),
    accessibility: score(lhr, 'accessibility'),
    bestPractices: score(lhr, 'best-practices'),
    lcpMs: Math.round(lhr.audits['largest-contentful-paint'].numericValue),
    cls: Number(lhr.audits['cumulative-layout-shift'].numericValue.toFixed(3)),
    tbtMs: Math.round(lhr.audits['total-blocking-time'].numericValue),
  };
  const failures = [];
  const floor = (key, category) => {
    if (measured[key] < BUDGET[key]) {
      const why = losses(lhr, category);
      failures.push(
        `${key} ${measured[key]} < ${BUDGET[key]}${why.length ? `: ${why.join(', ')}` : ''}`,
      );
    }
  };
  floor('performance', 'performance');
  floor('accessibility', 'accessibility');
  floor('bestPractices', 'best-practices');
  if (measured.lcpMs >= BUDGET.lcpMs)
    failures.push(`LCP ${measured.lcpMs} ms >= ${BUDGET.lcpMs} ms`);
  if (measured.cls >= BUDGET.cls) failures.push(`CLS ${measured.cls} >= ${BUDGET.cls}`);
  return { measured, failures };
}
