#!/usr/bin/env node
/**
 * Pre-commit gate. Seven checks, all mandatory, none skippable with --no-verify
 * without also skipping the others:
 *
 *   1. gitleaks protect --staged  — secret detection is deterministic work, so it
 *      is a tool, not a judgement call. A finding aborts the commit.
 *   2. env-contract.mjs           — turbo runs in strict env mode, so a variable
 *      the code reads but turbo.json does not declare is silently undefined at
 *      runtime. Free, instant, and it runs before the tests because it explains
 *      a whole class of failures the tests would only show as a symptom.
 *   3. invisible-chars.mjs        — a character you cannot see is a bug you cannot
 *      review. Same reasoning: it turns an unreadable test failure into a named
 *      line and column.
 *   4. self-import.mjs            — a package importing itself by name resolves
 *      to its own dist/, which works on any machine that has built once and
 *      fails on a clean checkout. Only CI would see it otherwise.
 *   4b. node-pin.mjs              — one Node version in .nvmrc, .npmrc, every
 *      Dockerfile stage, every setup-node step and engines; a stage left behind
 *      would ship the old runtime past every local lane.
 *   4c. wait-for-api --self-test  — `pnpm dev` holds Next until the API answers;
 *      a wait that returns at once brings back the 500 on the first page.
 *   5. frozen lockfile           — CI installs with --frozen-lockfile, so a
 *      package.json the lockfile does not match fails every CI job at install.
 *   5b. eslint                    — the same config CI's quality job runs.
 *   6. pnpm test                  — the gate lane only (fast, no network, no DB).
 *
 * Integration, load and E2E are deliberately NOT here: they need Postgres,
 * Redis, a model server, running processes and browsers. Running them on every commit
 * would make committing take minutes. CI runs them.
 */
import { spawnSync } from 'node:child_process';

const steps = [
  {
    name: 'gitleaks (staged secret scan)',
    cmd: 'gitleaks',
    args: ['protect', '--staged', '--no-banner', '--redact', '--config', '.gitleaks.toml'],
    // gitleaks is installed per-machine, not via pnpm. Missing binary is a hard
    // failure: silently skipping the secret scan is exactly the outcome we are
    // guarding against.
    required: true,
  },
  {
    // The scanner before the scan. It has been wrong once already (it read the
    // words `env.NAME` out of a comment explaining itself), and a gate nobody
    // tests is a gate that can only be discovered to be broken by the outage it
    // was supposed to prevent.
    name: 'environment contract self-test',
    cmd: 'node',
    args: ['scripts/env-contract.mjs', '--self-test'],
    required: true,
  },
  {
    name: 'environment contract',
    cmd: 'node',
    args: ['scripts/env-contract.mjs'],
    required: true,
  },
  {
    name: 'invisible characters (self-test)',
    cmd: 'node',
    args: ['scripts/invisible-chars.mjs', '--self-test'],
    required: true,
  },
  {
    name: 'invisible characters',
    cmd: 'node',
    args: ['scripts/invisible-chars.mjs'],
    required: true,
  },
  {
    name: 'node pin (self-test)',
    cmd: 'node',
    args: ['scripts/node-pin.mjs', '--self-test'],
    required: true,
  },
  {
    name: 'node pin',
    cmd: 'node',
    args: ['scripts/node-pin.mjs'],
    required: true,
  },
  {
    name: 'wait-for-api (self-test)',
    cmd: 'node',
    args: ['scripts/wait-for-api.mjs', '--self-test'],
    required: true,
  },
  {
    name: 'self-imports (self-test)',
    cmd: 'node',
    args: ['scripts/self-import.mjs', '--self-test'],
    required: true,
  },
  {
    name: 'self-imports',
    cmd: 'node',
    args: ['scripts/self-import.mjs'],
    required: true,
  },
  {
    // CI installs with --frozen-lockfile; a local install never is. A version
    // pin changed after the last install (e2fad2f) passed every local lane and
    // failed all eight CI jobs at install. About 2 s, and nothing is written.
    name: 'lockfile matches every package.json (as CI installs)',
    cmd: 'pnpm',
    args: ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts'],
    required: true,
  },
  {
    // The same check CI's quality job runs. Without it a change can pass every
    // local lane and go red on CI for formatting alone (009 did, 2026-10-28).
    name: 'prettier (format check, same globs as CI)',
    cmd: 'pnpm',
    args: ['exec', 'prettier', '--check', '--log-level', 'warn', '**/*.{ts,tsx,js,cjs,mjs,json}'],
    required: true,
  },
  {
    // CI's quality job runs ESLint too. Without it here, a console.log in the
    // API went green on every local lane and red on CI (283cd32). Cached, so
    // an unchanged tree checks in about 4 s.
    name: 'eslint (same config as CI)',
    cmd: 'pnpm',
    args: ['exec', 'eslint', '--cache', '--cache-location', 'node_modules/.cache/eslint/', '.'],
    required: true,
  },
  {
    name: 'gate tests',
    cmd: 'pnpm',
    args: ['run', 'test'],
    required: true,
  },
];

for (const step of steps) {
  process.stdout.write(`\n▶ ${step.name}\n`);
  const res = spawnSync(step.cmd, step.args, { stdio: 'inherit', shell: false });

  if (res.error && res.error.code === 'ENOENT') {
    process.stderr.write(
      `\n✖ ${step.name}: '${step.cmd}' is not installed or not on PATH.\n` +
        `  Install it and retry. Do not bypass this hook with --no-verify.\n`,
    );
    process.exit(1);
  }
  if (res.status !== 0) {
    process.stderr.write(`\n✖ ${step.name} failed. Commit aborted.\n`);
    process.exit(res.status ?? 1);
  }
}

process.stdout.write('\n✔ pre-commit checks passed\n');
