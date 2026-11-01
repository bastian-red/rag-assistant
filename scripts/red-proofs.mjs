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

/**
 * name, file, exact text, its broken replacement, and the suite that must go
 * red; `freshDatabase` for a proof that edits a migration (see databaseUrl).
 */
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
  // --- the library: ownership, error classification, the seed ---------------
  {
    name: 'collections listed without the owner filter',
    file: 'apps/api/src/collections/collections.service.ts',
    from: '        where: { ownerId },\n        select: { id: true, name: true },',
    to: '        select: { id: true, name: true },',
    suite: ['integration', 'collections'],
  },
  {
    name: 'a raw query failure read as its Prisma code, not its SQLSTATE',
    file: 'packages/db/src/errors.ts',
    from: "if (code === PRISMA_RAW_QUERY_FAILED && typeof meta?.code === 'string') return meta.code;",
    to: '',
    suite: ['unit', '@rag/db'],
  },
  {
    name: 'a raw unique violation matched by name only',
    file: 'packages/db/src/errors.ts',
    from: '.meta?.target ?? keyColumns(error);',
    to: '.meta?.target;',
    suite: ['unit', '@rag/db'],
  },
  {
    name: 'document counts fold a reading state away',
    file: 'packages/shared/src/contracts/library.ts',
    from: "export const IN_PROGRESS_STATUSES: readonly DocumentStatus[] = ['QUEUED', 'PARSING', 'EMBEDDING'];",
    to: "export const IN_PROGRESS_STATUSES: readonly DocumentStatus[] = ['QUEUED', 'PARSING'];",
    suite: ['unit', '@rag/shared'],
  },
  {
    name: 'a zero count printed as data',
    file: 'apps/web/lib/library.ts',
    from: "  if (counts.total === 0) return { total: 'No documents yet', detail: null };\n",
    to: '',
    suite: ['unit', '@rag/web'],
  },
  // --- the web app is private by default -----------------------------------
  {
    name: 'web proxy protects only the pages it lists',
    file: 'apps/web/lib/sign-in-gate.ts',
    from: '  if (isPublicPath(pathname)) return null;\n',
    to: '  if (!/^\\/(library|chat)/u.test(pathname)) return null;\n',
    suite: ['unit', '@rag/web'],
  },
  // --- chunking: spans, sentences, sizes -----------------------------------
  {
    name: 'chunk offsets stored in UTF-16 units, not code points',
    file: 'packages/chunker/src/chunk.ts',
    from: '      charStart: points(start),\n      charEnd: points(end),\n',
    to: '      charStart: start,\n      charEnd: end,\n',
    suite: ['unit', '@rag/chunker'],
  },
  {
    name: 'astral-plane check made Unicode-aware, so it never matches',
    file: 'packages/chunker/src/offsets.ts',
    from: '  if (!/[\\' + 'uD800-\\' + 'uDBFF]/.test(text)) return (utf16) => utf16;',
    to: '  if (!/[\\' + 'uD800-\\' + 'uDBFF]/u.test(text)) return (utf16) => utf16;',
    suite: ['unit', '@rag/chunker'],
  },
  {
    name: 'sentence breaks after Dr. and initials',
    file: 'packages/chunker/src/sentences.ts',
    from: '    if (endsInAbbreviation(segment) && from + segment.length < end) continue;\n',
    to: '',
    suite: ['unit', '@rag/chunker'],
  },
  {
    name: 'overlap bounded by the target instead of the overlap budget',
    file: 'packages/chunker/src/chunk.ts',
    from: 'tokens + piece.tokens > options.overlapTokens',
    to: 'tokens + piece.tokens > options.targetTokens',
    suite: ['unit', '@rag/chunker'],
  },
  {
    name: 'a chunk may end on the heading of the next section',
    file: 'packages/chunker/src/chunk.ts',
    from: "    while (keep > carried && current[keep - 1]!.kind === 'heading') keep -= 1;\n",
    to: '',
    suite: ['unit', '@rag/chunker'],
  },
  {
    name: 'normalise composes before removing invisibles',
    file: 'packages/chunker/src/normalise.ts',
    from: "    .replace(SPACES, ' ')\n    .replace(INVISIBLE, '')\n    .replace(CONTROL, '')\n    .normalize('NFC')\n",
    to: "    .normalize('NFC')\n    .replace(SPACES, ' ')\n    .replace(INVISIBLE, '')\n    .replace(CONTROL, '')\n",
    suite: ['unit', '@rag/chunker'],
  },
  {
    name: 'token estimate undercounts digits',
    file: 'packages/chunker/src/tokens.ts',
    from: '  digit: 1.3,',
    to: '  digit: 0.25,',
    suite: ['unit', '@rag/chunker'],
  },
  // --- citations: markers from a stream, spans in a chunk -------------------
  {
    name: 'a marker split across stream tokens is not held',
    file: 'packages/citations/src/markers.ts',
    from: "  if (i === rest.length) return final ? { kind: 'text' } : { kind: 'hold' };",
    to: "  if (i === rest.length) return { kind: 'text' };",
    suite: ['unit', '@rag/citations'],
  },
  {
    name: 'a label naming no packed source is kept',
    file: 'packages/citations/src/markers.ts',
    from: '      const keep = verdict.labels.filter((n) => valid.has(n));',
    to: '      const keep = verdict.labels;',
    suite: ['unit', '@rag/citations'],
  },
  {
    name: 'a marker opening a sentence is credited to that sentence',
    file: 'packages/citations/src/resolve.ts',
    from: '    if (lead !== undefined && claims.length > 0) {',
    to: '    if (lead !== undefined && claims.length < 0) {',
    suite: ['unit', '@rag/citations'],
  },
  {
    name: 'quote offsets stored in UTF-16 units, not code points',
    file: 'packages/citations/src/resolve.ts',
    from: '    const quoteStart = points(best.start);',
    to: '    const quoteStart = best.start;',
    suite: ['unit', '@rag/citations'],
  },
  {
    name: 'a quote is given the chunk first page instead of its own',
    file: 'packages/citations/src/resolve.ts',
    from: '      page,\n',
    to: '      page: source.page,\n',
    suite: ['unit', '@rag/citations'],
  },
  {
    name: 'page starts may stop short of the chunk last page',
    file: 'packages/db/prisma/migrations/20261101230000_chunk_page_starts/migration.sql',
    from: '         OR (s.last AND s.page <> page_end)\n',
    to: '',
    suite: ['integration', 'library'],
    freshDatabase: 'rag_proof',
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

/**
 * A migration proof needs a database that has never seen the migration:
 * `migrate deploy` skips an applied migration whose file changed, and
 * db-drift.mjs refuses it, so against rag_it the proof would go red for that
 * reason and prove nothing about the SQL. Such a proof names a throwaway
 * database, dropped before and after (only names starting rag_proof).
 */
function databaseUrl(name) {
  const env = existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '';
  const base =
    process.env.DATABASE_URL ??
    /^DATABASE_URL=(.+)$/mu.exec(env)?.[1]?.trim() ??
    'postgresql://rag:rag@localhost:5445/rag?schema=public';
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function dropDatabase(name) {
  if (!/^rag_proof[a-z_]*$/u.test(name)) throw new Error(`refusing to drop ${name}`);
  const script = `
    const { PrismaClient } = require('./generated/client');
    const url = new URL(process.env.TARGET);
    url.pathname = '/postgres';
    const admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    admin.$executeRawUnsafe('DROP DATABASE IF EXISTS "${name}" WITH (FORCE)').finally(() => admin.$disconnect());`;
  const result = spawnSync('pnpm', ['--filter', '@rag/db', 'exec', 'node', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TARGET: databaseUrl(name) },
  });
  if (result.status !== 0) throw new Error(`could not drop ${name}: ${result.stderr}`);
}

function run(suite, proof) {
  const [lane, arg] = suite;
  const env = { ...process.env };
  if (proof.freshDatabase !== undefined) {
    dropDatabase(proof.freshDatabase);
    env.INTEGRATION_DATABASE_URL = databaseUrl(proof.freshDatabase);
  }
  const options = { cwd: ROOT, encoding: 'utf8', env };
  const result =
    lane === 'unit'
      ? spawnSync('pnpm', ['--filter', arg ?? '@rag/api', 'exec', 'vitest', 'run'], options)
      : spawnSync('./scripts/integration.sh', [arg], options);
  return {
    status: result.status,
    tail: `${result.stdout}${result.stderr}`
      .split('\n')
      .filter((l) => /×|\bFAIL\b|error TS|db-drift:/u.test(l))
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
    const { status, tail } = run(proof.suite, proof);
    const verdict = status === 0 ? 'STAYED GREEN' : 'red';
    console.log(verdict);
    for (const line of tail) console.log(`    ${line.trim()}`);
    results.push({ name: proof.name, verdict });
  } finally {
    restore();
    restore = null;
    if (proof.freshDatabase !== undefined) dropDatabase(proof.freshDatabase);
  }
}

const bad = results.filter((r) => r.verdict !== 'red');
console.log(
  `\nred-proofs: ${String(results.length - bad.length)}/${String(results.length)} went red`,
);
for (const r of bad) console.log(`  ${r.verdict}: ${r.name}`);
process.exit(bad.length === 0 ? 0 : 1);
