#!/usr/bin/env node
/**
 * One Node version, everywhere it is named.
 *
 *   node scripts/node-pin.mjs              check the repo
 *   node scripts/node-pin.mjs --self-test  run this file's own cases
 *
 * .nvmrc is the source. Every other place that picks a Node must agree with it:
 *
 *   .npmrc use-node-version      what every `pnpm` command runs on locally
 *   infra/Dockerfile.* FROM node what the images run on
 *   .github/workflows/*.yml      setup-node reads .nvmrc, never a literal
 *   package.json engines.node    admits the pinned version
 *
 * Why a gate: the repo ran Node 20 for months after its end of life because
 * the version lived in nine places and nothing said they had to move together.
 * A Dockerfile left on 20 would pass every local lane and ship the old runtime.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+$/u;

/** `FROM node:<tag>` lines: the tags, in order. */
export function dockerNodeTags(text) {
  return [...text.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?node:(\S+)/gimu)].map((m) => m[1]);
}

/** Every setup-node step's `with:` keys, as {versionFile, version}. */
export function setupNodeSteps(text) {
  const steps = [];
  const lines = text.split(/\r?\n/u);
  for (const [i, line] of lines.entries()) {
    if (!/uses:\s*actions\/setup-node@/u.test(line)) continue;
    const indent = line.search(/\S/u);
    const step = { line: i + 1, versionFile: null, version: null };
    for (const next of lines.slice(i + 1)) {
      const at = next.search(/\S/u);
      if (at !== -1 && at <= indent) break;
      const file = /^\s*node-version-file:\s*['"]?([^'"\s#]+)/u.exec(next);
      const literal = /^\s*node-version:\s*['"]?([^'"\s#]+)/u.exec(next);
      if (file) step.versionFile = file[1];
      if (literal) step.version = literal[1];
    }
    steps.push(step);
  }
  return steps;
}

/** `>=a.b.c <d` style ranges only: what this repo writes. */
export function satisfies(version, range) {
  const parse = (v) => v.split('.').map(Number);
  const cmp = (a, b) => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i += 1)
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  return range
    .trim()
    .split(/\s+/u)
    .every((part) => {
      const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/u.exec(part);
      if (!m) return false;
      const c = cmp(version, m[2]);
      switch (m[1] ?? '=') {
        case '>=':
          return c >= 0;
        case '<=':
          return c <= 0;
        case '>':
          return c > 0;
        case '<':
          return c < 0;
        default:
          return c === 0;
      }
    });
}

/** The findings for one repo snapshot: {nvmrc, npmrc, dockerfiles{}, workflows{}, engines}. */
export function check(repo) {
  const problems = [];
  const pin = (repo.nvmrc ?? '').trim();
  if (!VERSION.test(pin)) {
    problems.push(`.nvmrc must hold one exact version (a.b.c), found "${pin}"`);
    return problems;
  }
  const npm = /^\s*use-node-version\s*=\s*(\S+)/mu.exec(repo.npmrc ?? '');
  if (!npm) problems.push('.npmrc has no use-node-version');
  else if (npm[1] !== pin) problems.push(`.npmrc use-node-version ${npm[1]} != .nvmrc ${pin}`);

  for (const [file, text] of Object.entries(repo.dockerfiles)) {
    const tags = dockerNodeTags(text);
    if (tags.length === 0) problems.push(`${file}: no FROM node:<tag>`);
    for (const tag of tags) {
      if (tag.split('-')[0] !== pin) problems.push(`${file}: FROM node:${tag} != .nvmrc ${pin}`);
    }
  }
  for (const [file, text] of Object.entries(repo.workflows)) {
    for (const step of setupNodeSteps(text)) {
      if (step.version !== null) {
        problems.push(
          `${file}:${step.line}: setup-node names node-version ${step.version}; use node-version-file: .nvmrc`,
        );
      } else if (step.versionFile !== '.nvmrc') {
        problems.push(`${file}:${step.line}: setup-node must read node-version-file: .nvmrc`);
      }
    }
  }
  if (typeof repo.engines !== 'string') problems.push('package.json has no engines.node');
  else if (!satisfies(pin, repo.engines)) {
    problems.push(`package.json engines.node "${repo.engines}" does not admit ${pin}`);
  }
  return problems;
}

function readRepo(root) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const tryRead = (p) => {
    try {
      return read(p);
    } catch {
      return null;
    }
  };
  const inDir = (dir, keep) =>
    Object.fromEntries(
      readdirSync(join(root, dir))
        .filter(keep)
        .map((f) => [`${dir}/${f}`, read(`${dir}/${f}`)]),
    );
  return {
    nvmrc: tryRead('.nvmrc'),
    npmrc: tryRead('.npmrc'),
    dockerfiles: inDir('infra', (f) => f.startsWith('Dockerfile')),
    workflows: inDir('.github/workflows', (f) => /\.ya?ml$/u.test(f)),
    engines: JSON.parse(read('package.json')).engines?.node,
  };
}

const GOOD = {
  nvmrc: '24.22.2\n',
  npmrc: '# comment\nuse-node-version=24.22.2\n',
  dockerfiles: {
    'infra/Dockerfile.api':
      'FROM node:24.22.2-bookworm-slim AS base\nFROM node:24.22.2-bookworm-slim\n',
  },
  workflows: {
    'ci.yml':
      'jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n          cache: pnpm\n      - run: x\n',
  },
  engines: '>=24.22.2 <25',
};
const SELF_TESTS = [
  ['the repo as it should be', GOOD, 0],
  ['.npmrc on another version', { ...GOOD, npmrc: 'use-node-version=24.21.0' }, 1],
  ['.npmrc without the pin', { ...GOOD, npmrc: '' }, 1],
  [
    'a Dockerfile stage left on 20',
    { ...GOOD, dockerfiles: { d: 'FROM node:24.22.2-slim\nFROM node:20-bookworm-slim\n' } },
    1,
  ],
  ['a floating major tag', { ...GOOD, dockerfiles: { d: 'FROM node:24-bookworm-slim\n' } }, 1],
  ['a Dockerfile with no node base', { ...GOOD, dockerfiles: { d: 'FROM debian:12\n' } }, 1],
  [
    'a workflow with a literal version',
    {
      ...GOOD,
      workflows: {
        w: '    - uses: actions/setup-node@v4\n      with:\n        node-version: 20\n',
      },
    },
    1,
  ],
  [
    'a workflow reading another file',
    {
      ...GOOD,
      workflows: {
        w: '    - uses: actions/setup-node@v4\n      with:\n        node-version-file: package.json\n',
      },
    },
    1,
  ],
  [
    'a later step does not lend its keys to an earlier setup-node',
    {
      ...GOOD,
      workflows: {
        w: '    - uses: actions/setup-node@v4\n    - uses: other@v1\n      with:\n        node-version-file: .nvmrc\n',
      },
    },
    1,
  ],
  ['engines that exclude the pin', { ...GOOD, engines: '>=20 <24' }, 1],
  ['no engines', { ...GOOD, engines: undefined }, 1],
  ['a .nvmrc that is a range', { ...GOOD, nvmrc: 'lts/*' }, 1],
];

function selfTest() {
  let failed = 0;
  for (const [name, repo, expected] of SELF_TESTS) {
    const got = check(repo).length;
    if (got !== expected) {
      failed += 1;
      process.stderr.write(
        `FAIL ${name}: ${String(got)} problem(s), expected ${String(expected)}\n`,
      );
    }
  }
  if (!satisfies('24.22.2', '>=24.22.2 <25') || satisfies('25.0.0', '>=24.22.2 <25')) {
    failed += 1;
    process.stderr.write('FAIL satisfies() bounds\n');
  }
  if (failed > 0) {
    process.stderr.write(`\nNode pin self-test: ${String(failed)} case(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`Node pin self-test: ${String(SELF_TESTS.length + 1)} cases pass.\n`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  if (process.argv.includes('--self-test')) selfTest();
  else {
    const repo = readRepo(process.cwd());
    const problems = check(repo);
    if (problems.length > 0) {
      for (const p of problems) process.stderr.write(`node-pin: ${p}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `Node pin: ${repo.nvmrc.trim()} in .nvmrc, .npmrc, ${String(Object.keys(repo.dockerfiles).length)} Dockerfiles, ${String(Object.keys(repo.workflows).length)} workflow(s), engines.\n`,
    );
  }
}
