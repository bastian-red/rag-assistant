#!/usr/bin/env node
/**
 * Red proofs for the guarantees this repo claims: break each one in the source, run the
 * suite that claims to hold it, and require that suite to FAIL. A check that
 * has never failed is a check whose meaning nobody knows.
 *
 *   node scripts/red-proofs.mjs            # every proof
 *   node scripts/red-proofs.mjs budget     # proofs whose name matches
 *   node scripts/red-proofs.mjs model health     # proofs matching any of them
 *
 * Each mutation must match its file exactly once (so a refactor that moves
 * the line fails here loudly instead of "proving" nothing), and the original
 * file is restored afterwards, also on Ctrl-C. A hard kill (SIGKILL, a closed
 * terminal) cannot run that restore, so the original is also written next to
 * the file as `<file>.red-proof-orig` before it is broken, and the next run
 * puts any leftover back before doing anything else (a killed run in a sibling
 * project once left a guard deleted). The integration proofs need the
 * datastores up, like `./scripts/integration.sh`, which they call.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** name, file, exact text, its broken replacement, and the suite that must go red. */
const PROOFS = [
  // --- the API's guards and budgets ----------------------------------------
  {
    name: 'session guard lets every route through',
    file: 'apps/api/src/common/session.guard.ts',
    from: 'if (isPublic === true) return true;',
    to: 'return true;',
    suite: ['integration', 'auth'],
  },
  {
    name: 'auth budget applied to every route',
    file: 'apps/api/src/common/throttle.ts',
    from: "      skipIf: (context) => budgetOf(context) !== 'auth',\n",
    to: '',
    suite: ['integration', 'auth'],
  },
  {
    name: 'anonymous rate-limit key holds the address in the clear',
    file: 'apps/api/src/common/throttle.ts',
    from: "return `ip:${addressHash(secret, request.ip ?? 'unknown')}`;",
    to: "return `ip:${request.ip ?? 'unknown'}`;",
    suite: ['unit'],
  },
  // --- the model server: reachable is not the same as ready ----------------
  {
    name: 'health reports ready with a model missing',
    file: 'apps/api/src/health/health.service.ts',
    from: 'missing.length === 0',
    to: 'missing.length >= 0',
    suite: ['integration', 'health'],
  },
  {
    name: 'model client reads a non-Ollama 200 as a model list',
    file: 'services/llm/src/ollama.ts',
    from: '    if (!parsed.success) {\n',
    to: '    if (!parsed.success && false) {\n',
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'an untagged model name is not resolved to :latest',
    file: 'packages/shared/src/contracts/llm.ts',
    from: "return name.includes(':') ? trimmed : `${trimmed}:latest`;",
    to: 'return trimmed;',
    suite: ['unit', '@rag/shared'],
  },
  // --- the web app is private by default -----------------------------------
  {
    name: 'web proxy protects only the pages it lists',
    file: 'apps/web/lib/sign-in-gate.ts',
    from: '  if (isPublicPath(pathname)) return null;\n',
    to: '  if (!/^\\/(library|chat)/u.test(pathname)) return null;\n',
    suite: ['unit', '@rag/web'],
  },
];

const filters = process.argv.slice(2);
const chosen = PROOFS.filter(
  (p) => filters.length === 0 || filters.some((filter) => p.name.includes(filter)),
);
if (chosen.length === 0) {
  console.error(`red-proofs: no proof matches ${filters.map((f) => `"${f}"`).join(' or ')}`);
  process.exit(2);
}

function run(suite) {
  const [lane, arg] = suite;
  const options = { cwd: ROOT, encoding: 'utf8' };
  const result =
    lane === 'unit'
      ? spawnSync('pnpm', ['--filter', arg ?? '@rag/api', 'exec', 'vitest', 'run'], options)
      : spawnSync('./scripts/integration.sh', [arg], options);
  return {
    status: result.status,
    tail: `${result.stdout}${result.stderr}`
      .split('\n')
      .filter((l) => /×|FAIL|error TS/u.test(l))
      .slice(0, 3),
  };
}

const BACKUP = '.red-proof-orig';
for (const file of new Set(PROOFS.map((p) => p.file))) {
  const path = join(ROOT, file);
  if (existsSync(path + BACKUP)) {
    renameSync(path + BACKUP, path);
    console.log(`red-proofs: restored ${file} from a run that was killed mid-proof`);
  }
}

let restore = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restore?.();
    process.exit(130);
  });
}

const results = [];
for (const proof of chosen) {
  const path = join(ROOT, proof.file);
  const original = readFileSync(path, 'utf8');
  const edits = [proof, ...(proof.also === undefined ? [] : [proof.also])];
  const counts = edits.map((edit) => original.split(edit.from).length - 1);
  if (counts.some((count) => count !== 1)) {
    results.push({ name: proof.name, verdict: `MOVED (matches ${counts.join('/')} times)` });
    continue;
  }
  writeFileSync(path + BACKUP, original);
  restore = () => renameSync(path + BACKUP, path);
  try {
    writeFileSync(
      path,
      edits.reduce((text, edit) => text.replace(edit.from, edit.to), original),
    );
    process.stdout.write(`red-proofs: ${proof.name} ... `);
    const { status, tail } = run(proof.suite);
    const verdict = status === 0 ? 'STAYED GREEN' : 'red';
    console.log(verdict);
    for (const line of tail) console.log(`    ${line.trim()}`);
    results.push({ name: proof.name, verdict });
  } finally {
    restore();
    restore = null;
  }
}

const bad = results.filter((r) => r.verdict !== 'red');
console.log(
  `\nred-proofs: ${String(results.length - bad.length)}/${String(results.length)} went red`,
);
for (const r of bad) console.log(`  ${r.verdict}: ${r.name}`);
process.exit(bad.length === 0 ? 0 : 1);
