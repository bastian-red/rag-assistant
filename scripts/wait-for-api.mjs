#!/usr/bin/env node
/**
 * Hold the web dev server until the API answers.
 *
 * `pnpm dev` starts api and web in parallel. Next is ready in about
 * 2 s; `nest start --watch` compiles first and listens after about 12 s. Every
 * public page reads the content API, so a page opened in that window (a
 * browser left open on localhost:3600 reconnects at once) rendered a 500 with
 * "content API unreachable", and the dev overlay kept it on screen after the
 * API came up. Holding `next dev` until the API answers means the web port
 * does not open until a page can render.
 *
 * Any HTTP answer from /health counts, even a 503: the API is listening, and
 * a broken dependency is /health's to report, not this script's.
 *
 * Fail open: after the timeout it warns and lets Next start anyway, so a dead
 * API shows up as the page's own error naming the API, not as a web server
 * that never starts.
 *
 *   node scripts/wait-for-api.mjs              (apps/web "dev" runs this first)
 *   node scripts/wait-for-api.mjs --self-test
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/** Same default as apps/web/lib/config.ts. */
const DEFAULT_BASE_URL = 'http://localhost:4600';
const TIMEOUT_MS = 120_000;
const INTERVAL_MS = 250;

/** Resolves true once `url` answers HTTP at all, false after `timeoutMs`. */
export async function waitForHttp(url, { timeoutMs = TIMEOUT_MS, intervalMs = INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      return true;
    } catch {
      // Not listening yet (ECONNREFUSED) or not answering: try again.
    }
    if (Date.now() + intervalMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function selfTest() {
  const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const failures = [];

  // 1. A server that starts listening 600 ms after the wait begins, and answers 503.
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const late = createServer((_, res) => res.writeHead(503).end());
  setTimeout(() => late.listen(port, '127.0.0.1'), 600);
  const started = Date.now();
  const up = await waitForHttp(`http://127.0.0.1:${String(port)}/health`, { timeoutMs: 5_000 });
  const waited = Date.now() - started;
  late.close();
  if (!up) failures.push('a server that comes up late (and answers 503) was never seen');
  if (waited < 500)
    failures.push(`returned after ${String(waited)} ms, before the server listened`);

  // 2. Nothing ever listens: false, after the timeout and not long after it.
  const empty = createServer();
  const deadPort = await listen(empty);
  await new Promise((resolve) => empty.close(resolve));
  const t0 = Date.now();
  const never = await waitForHttp(`http://127.0.0.1:${String(deadPort)}/health`, {
    timeoutMs: 700,
  });
  const gave = Date.now() - t0;
  if (never) failures.push('a port nobody listens on was reported as up');
  if (gave < 400 || gave > 2_000) failures.push(`gave up after ${String(gave)} ms, want about 700`);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`wait-for-api self-test FAILED: ${failure}`);
    process.exit(1);
  }
  console.log('wait-for-api self-test: 2 cases pass.');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--self-test')) {
    await selfTest();
  } else {
    const base = process.env.API_BASE_URL ?? DEFAULT_BASE_URL;
    const url = `${base}/health`;
    const started = Date.now();
    console.log(`[web] waiting for the API at ${base} before starting Next`);
    if (await waitForHttp(url)) {
      console.log(`[web] the API answered after ${String(Date.now() - started)} ms`);
    } else {
      console.warn(
        `[web] the API at ${base} did not answer within ${String(TIMEOUT_MS / 1000)} s. ` +
          'Starting Next anyway; public pages will fail until it does (check the api task above).',
      );
    }
  }
}
