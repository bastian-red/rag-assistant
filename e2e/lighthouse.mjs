#!/usr/bin/env node
/**
 * The Lighthouse lane: every kind of page a reader opens, against the budgets
 * in lighthouse-budget.mjs, on Lighthouse's default throttled phone (slow 4G,
 * CPU slowed 4x).
 *
 * Run by scripts/e2e.sh against the production build it starts, before
 * Playwright, so the server is idle. Every page but the sign-in is private,
 * so the lane first makes a reader of its own (`e2e-lighthouse-…@rag.test`,
 * removed by e2e-cleanup.mjs on the next run, like every e2e account): it
 * signs up, uploads a short markdown note, waits for it to be READY and asks
 * one question the fake model answers with a citation. The pages measured
 * then hold real content: a collection with a document, a conversation with
 * a filed slip, its tickets and a cited answer, and the passage it cites.
 *
 * Lighthouse drives the same browser over a debugging port, in its default
 * context (launchPersistentContext), so it carries the reader's session
 * cookie; `disableStorageReset` keeps Lighthouse from clearing it.
 *
 * Each page is measured RUNS times and judged on its median run (by
 * performance score). The median run's HTML report is kept in
 * $LOG_DIR/lighthouse/.
 *
 * Usage: node lighthouse.mjs [baseUrl]   (default $APP_BASE_URL)
 * Exit 1 if any budget is missed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';

import { judge, medianRun } from './lighthouse-budget.mjs';

const BASE = (process.argv[2] ?? process.env.APP_BASE_URL ?? 'http://localhost:3600').replace(
  /\/$/u,
  '',
);
const RUNS = Number(process.env.LIGHTHOUSE_RUNS ?? 3);
const OUT = join(process.env.LOG_DIR ?? '/tmp/rag-e2e', 'lighthouse');
const FAKE = `http://127.0.0.1:${process.env.E2E_FAKE_OLLAMA_PORT ?? '11536'}`;

const NOTE = [
  '# Boiler notes',
  '',
  '## Pressure',
  '',
  'The gauge should read between one and one and a half bar when the system is cold.',
  'Top it up at the filling loop under the boiler if it falls below one bar.',
  '',
  '## Radiators',
  '',
  'Bleed the radiators every autumn with the square key, starting on the ground floor.',
].join('\n');
const QUESTION = 'When should I bleed the radiators with the square key?';
const ANSWER =
  'Bleed the radiators every autumn with the square key, starting on the ground floor [S1].';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function fake(method, body) {
  const response = await fetch(`${FAKE}/__fake/chat`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`lighthouse: the fake model answered ${response.status}`);
}

/** Sign up a reader of the lane's own and give every page real content; returns the paths. */
async function reader(page) {
  const email = `e2e-lighthouse-${Date.now()}@rag.test`;
  await page.goto(`${BASE}/sign-up`);
  await page.getByLabel('Name').fill('E2E lighthouse');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-long-enough');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((url) => url.pathname === '/');

  await page.getByTestId('collection').getByRole('link', { name: 'My documents' }).click();
  await page.waitForURL(/\/collections\//u);
  const collection = new URL(page.url()).pathname;
  await page
    .getByLabel('Choose files, or drop them here')
    .setInputFiles({ name: 'boiler.md', mimeType: 'text/markdown', buffer: Buffer.from(NOTE) });
  await page
    .getByTestId('document-status')
    .filter({ hasText: '✓ Ready to ask about' })
    .waitFor({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Ask this collection' }).click();
  await page.waitForURL(/\/conversations\//u);
  const conversation = new URL(page.url()).pathname;
  await fake('PUT', { answer: ANSWER });
  try {
    await page.getByLabel('Your question').fill(QUESTION);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.locator('[data-testid="turn"][data-status="done"]').waitFor({ timeout: 30_000 });
  } finally {
    await fake('DELETE');
  }
  const passage = await page.getByTestId('citation-chip').first().getAttribute('href');
  if (passage === null) throw new Error('lighthouse: the answer has no citation to open.');
  return { email, collection, conversation, passage };
}

mkdirSync(OUT, { recursive: true });
const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'rag-lighthouse-'));
const context = await chromium.launchPersistentContext(profile, {
  args: [`--remote-debugging-port=${port}`],
});

const summary = [];
let failed = false;

/** Measure one page RUNS times and judge its median run. */
async function measure(page) {
  const url = `${BASE}${page.path}`;
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const result = await lighthouse(url, {
      port,
      output: ['json', 'html'],
      logLevel: 'error',
      // The session cookie is the reader: a storage reset would sign them out.
      disableStorageReset: true,
    });
    if (result === undefined) throw new Error(`Lighthouse returned nothing for ${url}`);
    if (result.lhr.runtimeError) {
      throw new Error(`${url}: ${result.lhr.runtimeError.code} ${result.lhr.runtimeError.message}`);
    }
    // A lost session lands on the sign-in page with a 200: measure that and
    // the lane would pass while measuring nothing it meant to.
    if (new URL(result.lhr.finalDisplayedUrl).pathname !== new URL(url).pathname) {
      throw new Error(`${url} ended at ${result.lhr.finalDisplayedUrl}, not the page meant`);
    }
    runs.push(result);
  }
  const chosen = runs[medianRun(runs.map((run) => run.lhr))];
  writeFileSync(join(OUT, `${page.name}.html`), chosen.report[1]);
  const verdict = judge(chosen.lhr);
  summary.push({ page: page.name, url, ...verdict });
  failed ||= verdict.failures.length > 0;

  const m = verdict.measured;
  console.info(
    `${verdict.failures.length === 0 ? 'ok  ' : 'FAIL'} ${page.name.padEnd(12)} ` +
      `perf ${m.performance} a11y ${m.accessibility} bp ${m.bestPractices} ` +
      `LCP ${m.lcpMs} ms CLS ${m.cls} TBT ${m.tbtMs} ms  (median of ${RUNS})`,
  );
  for (const failure of verdict.failures) console.info(`       ${failure}`);
}

try {
  // Signed out first: the sign-in page is where every visit starts.
  await measure({ name: 'sign-in', path: '/sign-in' });
  const made = await reader(context.pages()[0] ?? (await context.newPage()));
  console.info(`lighthouse: signed in as ${made.email}`);
  await measure({ name: 'library', path: '/' });
  await measure({ name: 'collection', path: made.collection });
  await measure({ name: 'conversation', path: made.conversation });
  await measure({ name: 'passage', path: made.passage });
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.info(`Reports: ${OUT}/{${summary.map((p) => p.page).join(',')}}.html`);
process.exit(failed ? 1 : 0);
