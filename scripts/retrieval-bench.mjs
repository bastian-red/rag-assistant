#!/usr/bin/env node
/**
 * SPECS #8: retrieval p95 < 150 ms over 5,000 chunks.
 *
 * Writes two people's libraries of 5,000 chunks each (a realistic
 * multi-tenant table: the owner filter has another person's rows to skip),
 * embedded with the fake's hash embedding, then times `retrieve()` end to end
 * (query embedding, both searches, fusion, packing) over 200 questions after
 * 20 warm-up ones. Hash embeddings take microseconds in process, so the time
 * measured is retrieval's own, not the model server's; the real model's
 * query embedding is reported by the eval lane instead.
 *
 * Prints the plan Postgres chose for the vector query (EXPLAIN of exactly
 * the SQL `vectorSearch` runs, under its settings), so "the HNSW index
 * answered it" is read, not assumed.
 *
 * Refuses the development database: it writes 10,000 rows. Run against the
 * integration database (scripts/integration.sh does) or one of your own:
 *
 *   DATABASE_URL=postgresql://rag:rag@localhost:5445/rag_it node scripts/retrieval-bench.mjs
 *
 * Options: --chunks N (per person, default 5000), --queries N (200),
 * --budget-ms N (150), --json (one JSON line on stdout instead of the table),
 * --explain (also print EXPLAIN (ANALYZE, BUFFERS) of both searches).
 * Exit 1 when p95 is at or over the budget. The bench people are deleted
 * afterwards, whatever happens (the cascade takes their chunks).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'services', 'retrieval', 'package.json'));
const { createPrismaClient, Prisma } = require('@rag/db');
const { fakeDigest, hashEmbedding } = require('@rag/llm');
const { embeddingSpace } = require('@rag/shared');
const retrieval = require('./dist/index.js');

const { values: args } = parseArgs({
  options: {
    chunks: { type: 'string', default: '5000' },
    queries: { type: 'string', default: '200' },
    'budget-ms': { type: 'string', default: '150' },
    json: { type: 'boolean', default: false },
    explain: { type: 'boolean', default: false },
  },
});
const CHUNKS = Number(args.chunks);
const QUERIES = Number(args.queries);
const BUDGET_MS = Number(args['budget-ms']);
const WARMUP = 20;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('retrieval-bench: DATABASE_URL is not set.');
  process.exit(2);
}
const dbName = new URL(url).pathname.replace(/^\//u, '');
if (dbName === 'rag') {
  console.error(
    'retrieval-bench: refusing the development database "rag" (it writes 10,000 rows). Use rag_it.',
  );
  process.exit(2);
}

/** mulberry32: a seeded generator, so every run benches the same library. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(4417);
const SYLLABLES = [
  'ka',
  'lo',
  'ven',
  'tri',
  'mo',
  'sel',
  'dar',
  'ni',
  'pe',
  'qua',
  'ru',
  'sto',
  'ul',
  'bre',
  'fin',
  'gha',
];
const VOCABULARY = Array.from({ length: 2_000 }, () => {
  const n = 2 + Math.floor(random() * 3);
  return Array.from({ length: n }, () => SYLLABLES[Math.floor(random() * SYLLABLES.length)]).join(
    '',
  );
});
// Zipf-like: a few words are common, most are rare, as in prose.
const word = () => VOCABULARY[Math.floor(VOCABULARY.length * random() ** 2.2)];
const sentence = (n) => `${Array.from({ length: n }, word).join(' ')}.`;
const passage = () =>
  Array.from({ length: 6 + Math.floor(random() * 6) }, () =>
    sentence(8 + Math.floor(random() * 8)),
  ).join(' ');

const SPACE = embeddingSpace('qwen3-embedding:0.6b', fakeDigest('qwen3-embedding:0.6b'));
const prisma = createPrismaClient({ url });
const people = [];

async function person(label) {
  const user = await prisma.user.create({
    data: {
      email: `bench-${label}-${randomUUID()}@test.invalid`,
      name: `Bench ${label}`,
      passwordHash: 'not-a-real-hash',
    },
  });
  people.push(user.id);
  const collection = await prisma.collection.create({ data: { ownerId: user.id, name: 'Bench' } });
  return { id: user.id, collectionId: collection.id };
}

/** `count` chunks over documents of 50 chunks each, READY, in SPACE. */
async function library(owner, count) {
  const PER_DOC = 50;
  for (let d = 0; d * PER_DOC < count; d += 1) {
    const doc = await prisma.document.create({
      data: {
        ownerId: owner.id,
        collectionId: owner.collectionId,
        title: `Bench document ${String(d + 1)}`,
        filename: `bench-${String(d + 1)}.md`,
        mime: 'text/markdown',
        bytes: 1,
        sha256: randomBytes(32).toString('hex'),
        status: 'READY',
      },
    });
    const n = Math.min(PER_DOC, count - d * PER_DOC);
    let at = 0;
    const rows = Array.from({ length: n }, (_, ord) => {
      const text = passage();
      const length = Array.from(text).length;
      const row = Prisma.sql`(
        ${`c${randomBytes(12).toString('hex')}`}, ${owner.id}, ${doc.id}, ${ord}, ${text},
        NULL::int, NULL::int, '[]'::jsonb, ${at}, ${at + length}, ARRAY[]::text[], ${Math.ceil(length / 4)},
        ${retrieval.vectorLiteral(hashEmbedding(text))}::halfvec, ${SPACE}
      )`;
      at += length + 2;
      return row;
    });
    await prisma.$executeRaw`
      INSERT INTO "chunks" (
        "id", "owner_id", "document_id", "ord", "text", "page_start", "page_end", "page_starts",
        "char_start", "char_end", "heading_path", "tokens", "embedding", "embedding_model"
      ) VALUES ${Prisma.join(rows)}`;
  }
}

const quantile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
const round = (ms) => Math.round(ms * 10) / 10;

let exitCode = 0;
try {
  const setupStarted = performance.now();
  const asker = await person('asker');
  const other = await person('other');
  await library(asker, CHUNKS);
  await library(other, CHUNKS);
  await prisma.$executeRawUnsafe('ANALYZE "chunks"');
  await prisma.$executeRawUnsafe('ANALYZE "documents"');
  const setupMs = performance.now() - setupStarted;

  const deps = {
    prisma,
    embed: async (texts) => texts.map((t) => hashEmbedding(t)),
    embeddingSpace: async () => SPACE,
  };
  const question = () => `${Array.from({ length: 3 + Math.floor(random() * 6) }, word).join(' ')}?`;

  for (let i = 0; i < WARMUP; i += 1)
    await retrieval.retrieve(deps, { ownerId: asker.id, query: question() });
  const total = [];
  const search = [];
  let sources = 0;
  for (let i = 0; i < QUERIES; i += 1) {
    const r = await retrieval.retrieve(
      deps,
      { ownerId: asker.id, query: question() },
      { minSimilarity: -1 },
    );
    total.push(r.timings.totalMs);
    search.push(r.timings.searchMs);
    sources += r.sources.length;
  }
  total.sort((a, b) => a - b);
  search.sort((a, b) => a - b);

  // Each search alone, on fresh questions: where the time goes.
  const scope = { ownerId: asker.id, space: SPACE, collectionId: null };
  const parts = { vector: [], text: [], stale: [] };
  const D = retrieval.RETRIEVAL_DEFAULTS;
  for (let i = 0; i < Math.min(QUERIES, 50); i += 1) {
    const q = question();
    const v = hashEmbedding(q);
    let t = performance.now();
    await retrieval.vectorSearch(prisma, scope, v, D.vectorK, D.efSearch);
    parts.vector.push(performance.now() - t);
    t = performance.now();
    await retrieval.textSearch(prisma, scope, q, v, D.textK);
    parts.text.push(performance.now() - t);
    t = performance.now();
    await retrieval.staleDocuments(prisma, scope);
    parts.stale.push(performance.now() - t);
  }
  const p95Of = (list) =>
    round(
      quantile(
        [...list].sort((a, b) => a - b),
        0.95,
      ),
    );

  const plan = await retrieval.vectorSearchPlan(
    prisma,
    { ownerId: asker.id, space: SPACE, collectionId: null },
    hashEmbedding(question()),
    retrieval.RETRIEVAL_DEFAULTS.vectorK,
    retrieval.RETRIEVAL_DEFAULTS.efSearch,
  );
  const hnsw = plan.includes('chunks_embedding_hnsw_idx');
  if (args.explain) {
    const q = question();
    const v = hashEmbedding(q);
    const hide = (text) => text.replace(/'\[[^\]]*\]'/gu, "'[...]'");
    console.log('--- vector search, EXPLAIN (ANALYZE, BUFFERS)');
    console.log(
      hide(
        await retrieval.vectorSearchPlan(prisma, scope, v, D.vectorK, D.efSearch, {
          analyze: true,
        }),
      ),
    );
    console.log('--- text search, EXPLAIN (ANALYZE, BUFFERS)');
    console.log(hide(await retrieval.textSearchPlan(prisma, scope, q, v, D.textK)));
  }
  const report = {
    chunksPerPerson: CHUNKS,
    tableChunks: CHUNKS * 2,
    queries: QUERIES,
    setupSeconds: round(setupMs / 1000),
    totalMs: {
      p50: round(quantile(total, 0.5)),
      p95: round(quantile(total, 0.95)),
      p99: round(quantile(total, 0.99)),
      max: round(total.at(-1)),
    },
    searchMs: { p50: round(quantile(search, 0.5)), p95: round(quantile(search, 0.95)) },
    aloneP95Ms: { vector: p95Of(parts.vector), text: p95Of(parts.text), stale: p95Of(parts.stale) },
    meanSources: round(sources / QUERIES),
    vectorPlanUsesHnsw: hnsw,
    budgetMs: BUDGET_MS,
    pass: quantile(total, 0.95) < BUDGET_MS,
  };
  if (args.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(
      `retrieval-bench: ${String(QUERIES)} questions over ${String(CHUNKS)} chunks (${String(CHUNKS * 2)} in the table), library written in ${String(report.setupSeconds)} s`,
    );
    console.log(
      `  retrieve()  p50 ${String(report.totalMs.p50)} ms   p95 ${String(report.totalMs.p95)} ms   p99 ${String(report.totalMs.p99)} ms   max ${String(report.totalMs.max)} ms`,
    );
    console.log(
      `  searches    p50 ${String(report.searchMs.p50)} ms   p95 ${String(report.searchMs.p95)} ms`,
    );
    console.log(
      `  alone, p95: vector ${String(report.aloneP95Ms.vector)} ms   text ${String(report.aloneP95Ms.text)} ms   stale count ${String(report.aloneP95Ms.stale)} ms`,
    );
    console.log(`  sources per question: ${String(report.meanSources)}`);
    console.log(
      `  vector plan: ${hnsw ? 'HNSW index (chunks_embedding_hnsw_idx)' : 'NOT the HNSW index'}`,
    );
    // The query vector is 1024 numbers; print the plan without it.
    for (const line of plan.split('\n'))
      console.log(`    ${line.replace(/'\[[^\]]*\]'/gu, "'[...]'")}`);
    console.log(
      report.pass
        ? `  PASS: p95 under ${String(BUDGET_MS)} ms`
        : `  FAIL: p95 ${String(report.totalMs.p95)} ms is not under ${String(BUDGET_MS)} ms`,
    );
  }
  if (!report.pass) exitCode = 1;
} catch (error) {
  console.error('retrieval-bench:', error);
  exitCode = 1;
} finally {
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await prisma.$disconnect();
}
process.exit(exitCode);
