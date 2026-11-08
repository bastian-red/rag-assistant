#!/usr/bin/env node
/**
 * Red proofs for the guarantees this repo claims: break each one in the source, run the
 * suite that claims to hold it, and require that suite to FAIL. A check that
 * has never failed is a check whose meaning nobody knows.
 *
 *   node scripts/red-proofs.mjs            # every proof
 *   node scripts/red-proofs.mjs budget     # proofs whose name matches
 *   node scripts/red-proofs.mjs model health     # proofs matching any of them
 *   node scripts/red-proofs.mjs --check  # every mutation still matches once (gate lane)
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
 * red: ['unit', package], ['e2e', spec file, test-title grep] (Chromium,
 * through scripts/e2e.sh, which rebuilds) or ['integration', API test filter, phase] where
 * phase is one of integration.sh's (db, ingest, retrieval, bench, api);
 * `freshDatabase` for a proof that edits a migration (see databaseUrl).
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
  {
    name: 'sign-up creates an account with no collection',
    file: 'apps/api/src/auth/auth.service.ts',
    from: '          collections: { create: { name: FIRST_COLLECTION_NAME } },\n',
    to: '',
    suite: ['integration', 'auth'],
  },
  {
    name: 'sign-up skips the auth budget',
    file: 'apps/api/src/auth/auth.controller.ts',
    from: "  @Budget('auth')\n  @HttpCode(HttpStatus.CREATED)",
    to: '  @HttpCode(HttpStatus.CREATED)',
    suite: ['integration', 'auth'],
  },
  // --- the web app (step 9) -------------------------------------------------
  {
    // Two paths carry Stop from the browser to the API: the request's signal
    // and the response stream's cancel. Each alone was measured to suffice
    // (breaking one stays green), so the proof breaks both.
    name: 'stop never reaches the API',
    file: 'apps/web/lib/upstream.ts',
    from: "  else request.signal.addEventListener('abort', () => controller.abort(), { once: true });\n",
    to: '',
    also: { from: '    cancel() {\n      abort.abort();\n    },\n', to: '    cancel() {},\n' },
    suite: ['e2e', 'tests/chat.spec.ts', 'Stop keeps'],
  },
  {
    name: 'viewer prints the passage start page, not the quote page',
    file: 'apps/web/lib/passage.ts',
    from: '  for (const start of chunk.pageStarts) if (start.at <= at) page = start.page;\n',
    to: '',
    suite: ['e2e', 'tests/chat.spec.ts', 'SPECS #10'],
  },
  {
    name: 'collection page ignores the live ingest feed',
    file: 'apps/web/components/collection-documents.tsx',
    from: "    source.addEventListener('ingest', ",
    to: "    source.addEventListener('ingest-off', ",
    suite: ['e2e', 'tests/library.spec.ts', 'upload to ready live'],
  },
  {
    name: 'stored chips forget the quote span',
    file: 'apps/web/lib/chat-state.ts',
    from: '  const citation = turn.citations.find((c) => c.marker === marker);',
    to: '  const citation = turn.citations.find(() => false);',
    suite: ['e2e', 'tests/chat.spec.ts', 'conversation is kept'],
  },
  {
    name: 'route handlers redirected to the sign-in page',
    file: 'apps/web/lib/sign-in-gate.ts',
    from: "  return pathname.startsWith('/api/');",
    to: '  return false;',
    suite: ['unit', '@rag/web'],
  },
  // --- the design (step 10, docs/DESIGN.md) ----------------------------------
  {
    name: 'the tickets wait for the first word',
    file: 'apps/web/components/chat.tsx',
    from: '{row === null ? null : <Tickets row={row} live={turn.sources.length > 0} />}',
    to: "{row === null || turn.text === '' ? null : <Tickets row={row} live={turn.sources.length > 0} />}",
    suite: ['e2e', 'tests/desk.spec.ts', 'before the words'],
  },
  {
    name: 'a stored answer loses its cited tickets',
    file: 'apps/web/lib/tickets.ts',
    from: '  if (turn.citations.length > 0) {',
    to: '  if (turn.citations.length < 0) {',
    suite: ['e2e', 'tests/desk.spec.ts', 'before the words'],
  },
  {
    name: 'the tickets drop in under reduced motion',
    file: 'apps/web/app/globals.css',
    from: '@media (prefers-reduced-motion: no-preference) {\n  html {',
    to: '@media all {\n  html {',
    suite: ['e2e', 'tests/desk.spec.ts', 'motion is welcome'],
  },
  {
    name: 'a citation shrinks below a 24 px target',
    file: 'apps/web/app/globals.css',
    from: '  min-inline-size: 1.5rem;\n  block-size: 1.5rem;',
    to: '  min-inline-size: 1rem;\n  block-size: 1rem;',
    suite: ['e2e', 'tests/layout.spec.ts', 'a collection, a conversation and a passage'],
  },
  {
    name: 'the key hint shows on a touch screen',
    file: 'apps/web/app/globals.css',
    from: '@media (pointer: coarse) {',
    to: '@media (pointer: none) {',
    suite: ['e2e', 'tests/layout.spec.ts', 'keys a phone does not have'],
  },
  {
    // The bug the first render had: `.button` comes later and won.
    name: 'the sidebar toggle shows at desktop width',
    file: 'apps/web/app/globals.css',
    from: '.sidenav .sidenav-toggle {\n  display: none;\n}',
    to: '.sidenav-toggle {\n  display: none;\n}',
    suite: ['e2e', 'tests/layout.spec.ts', 'simply there'],
  },
  {
    name: 'a markdown passage shown as its source',
    file: 'apps/web/lib/passage-blocks.ts',
    // Reflow alone is invisible in a browser (a newline renders as a space, and
    // toHaveText collapses whitespace); the unit suite holds it. What a reader
    // sees is markdown read as plain text: "## Tyres" left in, no heading.
    from: "  return mime === 'text/markdown' ? 'markdown' : 'text';",
    to: "  return 'text';",
    suite: ['e2e', 'tests/desk.spec.ts', 'reads as a document'],
  },
  {
    name: "a passage keeps its source's hard line breaks",
    file: 'apps/web/lib/passage-blocks.ts',
    from: "const reflow = (part: string) => part.replace(/[ \\t]*\\n[ \\t]*/gu, ' ');",
    to: 'const reflow = (part: string) => part;',
    suite: ['unit', '@rag/web'],
  },
  {
    name: 'the passage locator repeats the title',
    file: 'apps/web/lib/passage.ts',
    from: '  const titled = section !== null && same(section, title);',
    to: '  const titled = false;',
    suite: ['unit', '@rag/web'],
  },
  {
    name: "the accent drifts to a sibling project's",
    file: 'apps/web/app/globals.css',
    from: '  --accent: #6c529e;',
    to: '  --accent: #86269b;',
    suite: ['unit', '@rag/web'],
  },
  {
    name: 'the chunker reaches a browser bundle through the ticket rows',
    file: 'apps/web/lib/passage.ts',
    from: "import type { ChunkView } from '@rag/shared';",
    to: "import { unitsOf } from '@rag/chunker';\nexport const units = unitsOf;\nimport type { ChunkView } from '@rag/shared';",
    suite: ['unit', '@rag/web'],
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
    from: '    const parsed = tagsSchema.safeParse(body);\n    if (!parsed.success) {\n',
    to: '    const parsed = tagsSchema.safeParse(body);\n    if (!parsed.success && false) {\n',
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
    from: '  if (isPublicPath(pathname) || answersForItself(pathname)) return null;\n',
    to: '  if (!/^\\/(library|chat)/u.test(pathname) || answersForItself(pathname)) return null;\n',
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
    from: '    const located = partOf(source, points(best.start), points(best.end));',
    to: '    const located = partOf(source, best.start, best.end);',
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
    // Every phase: the database suite holds the CHECK, the API suite reads through it.
    suite: ['integration', 'library', ''],
    freshDatabase: 'rag_proof',
  },
  // --- the model client: chat, embeddings, readiness (build step 4) ---------
  {
    name: 'a thinking-only chat build reported as ready',
    file: 'services/llm/src/ollama.ts',
    from: '  if (show.thinking !== undefined && !show.thinking.values.includes(false)) {\n',
    to: '  if (false) {\n',
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'health ignores a model that cannot do its job',
    file: 'apps/api/src/health/health.service.ts',
    from: '      ...problems,\n',
    to: '',
    suite: ['integration', 'health'],
  },
  {
    name: 'reasoning inside <think> reaches the reader',
    file: 'services/llm/src/think.ts',
    from: '        if (this.inside) this.dropped += codePoints(before);\n        else visible += before;\n',
    to: '        visible += before;\n',
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'leaving the stream early leaves the request open',
    file: 'services/llm/src/ndjson.ts',
    from: '    await reader.cancel().catch(() => undefined);\n',
    to: '',
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'tokens already read pass a stop',
    file: 'services/llm/src/ollama.ts',
    from: '          if (controller.signal.aborted) throw abortedBy(controller.signal);\n',
    to: '',
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'no clock on the first token',
    file: 'services/llm/src/ollama.ts',
    from: "    arm(firstTokenTimeoutMs, 'no first token');\n",
    to: '',
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'a slow consumer counted as a silent model',
    file: 'services/llm/src/ollama.ts',
    from: "            clearTimeout(timer);\n            yield { type: 'token', text };\n",
    to: "            yield { type: 'token', text };\n",
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'an embed reply with the wrong vector count accepted',
    file: 'services/llm/src/ollama.ts',
    from: '    if (vectors.length !== input.length) {\n',
    to: '    if (false) {\n',
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'a passage can close its own source fence',
    file: 'packages/shared/src/contracts/sources.ts',
    from: '  return text.replace(ESCAPABLE, (match: string) =>\n',
    to: '  return text.replace(/(?!)/u, (match: string) =>\n',
    suite: ['unit', '@rag/shared'],
  },
  {
    name: 'the fake does not see a closed stream',
    file: 'services/llm/src/fake/server.ts',
    from: '      if (!finished) record.aborted = true;\n',
    to: '',
    suite: ['unit', '@rag/llm'],
  },
  // --- vector spaces: a vector is searched only against its own space -----
  {
    name: 'the embedding space is the configured name, not the server’s digest',
    file: 'services/llm/src/ollama.ts',
    from: "      return embeddingSpace(model, entry.digest ?? '');\n",
    to: '      return normaliseModel(model);\n',
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'the fake hashes the query instruction as content',
    file: 'services/llm/src/fake/embedding.ts',
    from: "text.replace(INSTRUCTION, '').normalize('NFC')",
    to: "text.normalize('NFC')",
    suite: ['unit', '@rag/llm'],
  },
  {
    name: 'the ingest sweep never asks which stored files have a row',
    file: 'services/ingest/src/app.ts',
    from: '    const files = await sweepUploads(config.uploadDir, (owner, shas) =>\n      knownUploads(prisma, owner, shas),\n    );\n',
    to: '    const files = { orphans: 0, partials: 0 };\n',
    suite: ['integration', undefined, 'ingest'],
  },
  {
    name: 'a refused upload leaves its staged file behind',
    file: 'apps/api/src/documents/documents.service.ts',
    from: '      await rm(file.path, { force: true });\n',
    to: '      void file.path;\n',
    suite: ['integration', 'documents'],
  },
  {
    name: 'an upload cut off mid-file is never removed from staging',
    file: 'apps/api/src/documents/upload-storage.ts',
    from: "      if (typeof file.path !== 'string') return done(null);\n",
    to: '      return done(null);\n',
    suite: ['integration', 'documents'],
  },
  {
    name: 'the upload inspector decodes each piece on its own (a cut character reads as invalid)',
    file: 'packages/shared/src/server/sniff.ts',
    from: '      const text = decoder.decode(chunk, { stream });\n',
    to: '      const text = decoder.decode(chunk, { stream: false });\n',
    suite: ['unit', '@rag/shared'],
  },
  {
    name: 'the upload sweep removes files that have a row',
    file: 'packages/shared/src/server/storage.ts',
    from: '      if (live.has(sha)) continue;\n',
    to: '      void live;\n',
    suite: ['unit', '@rag/shared'],
  },
  {
    name: 'chunks embedded in another space are never embedded again',
    file: 'services/ingest/src/reconcile.ts',
    from: '  const stale = space === null ? null : await staleDocuments(prisma, space);\n',
    to: '  const stale = space === null ? null : await staleDocuments(prisma, space).then(() => []);\n',
    suite: ['integration', undefined, 'ingest'],
  },
  {
    name: 'a model swapped mid-document leaves two spaces in one chunk set',
    file: 'services/ingest/src/pipeline.ts',
    from: '  if (after !== space) throw new SpaceChanged(space, after);\n',
    to: '',
    suite: ['integration', undefined, 'ingest'],
  },
  // --- retrieval: scope, fusion, packing, abstention, speed -----------------
  {
    name: 'retrieval searches without the owner filter',
    file: 'services/retrieval/src/search.ts',
    from: '    c."owner_id" = ${scope.ownerId}\n    AND c."embedding_model" = ${scope.space}\n',
    to: '    c."embedding_model" = ${scope.space}\n',
    suite: ['integration', undefined, 'retrieval'],
  },
  {
    name: 'retrieval searches documents that are not READY',
    file: 'services/retrieval/src/search.ts',
    from: '    AND d."status" = \'READY\'\n    ${collection}`;',
    to: '    ${collection}`;',
    suite: ['integration', undefined, 'retrieval'],
  },
  {
    name: 'retrieval searches every vector space',
    file: 'services/retrieval/src/search.ts',
    from: '    AND c."embedding_model" = ${scope.space}\n    AND d.',
    to: '    AND d.',
    suite: ['integration', undefined, 'retrieval'],
  },
  {
    name: 'full text requires every word of the question',
    file: 'services/retrieval/src/search.ts',
    from: "' (&|<->|<[0-9]+>) ', ' | ', 'g'",
    to: "' (&|<->|<[0-9]+>) ', ' & ', 'g'",
    suite: ['integration', undefined, 'retrieval'],
  },
  {
    name: 'the searches run on generic plans',
    file: 'services/retrieval/src/search.ts',
    from: '    await tx.$executeRawUnsafe(`SET LOCAL plan_cache_mode = force_custom_plan`);\n',
    to: '',
    suite: ['integration', undefined, 'bench'],
  },
  {
    name: 'a merged source repeats the overlap',
    file: 'services/retrieval/src/pack.ts',
    from: '    text.push(...points(next.text).slice(end - next.charStart));\n',
    to: '    text.push(...points(next.text));\n',
    suite: ['unit', '@rag/retrieval'],
  },
  {
    name: 'a repeated passage is packed twice',
    file: 'services/retrieval/src/pack.ts',
    from: '    if (seen.has(key)) {\n',
    to: '    if (seen.has(key) && false) {\n',
    suite: ['unit', '@rag/retrieval'],
  },
  {
    name: 'retrieval never abstains',
    file: 'services/retrieval/src/abstain.ts',
    from: 'bestSimilarity < minSimilarity',
    to: 'bestSimilarity < -2',
    suite: ['unit', '@rag/retrieval'],
  },
  {
    name: 'a quote from a merged source is stored against its first chunk',
    file: 'packages/citations/src/resolve.ts',
    from: '      chunkId: part.chunkId,\n',
    to: '      chunkId: source.chunkId,\n',
    suite: ['unit', '@rag/citations'],
  },
  // --- ingestion: one chunk set, refusals not retried, uploads checked ------
  {
    name: 'a re-run appends chunks instead of replacing them',
    file: 'services/ingest/src/store.ts',
    from: '      await tx.$executeRaw`DELETE FROM "chunks" WHERE "document_id" = ${doc.id}`;\n',
    to: '',
    suite: ['integration', undefined, 'ingest'],
  },
  {
    name: 'a PDF with no text layer is read as an empty one',
    file: 'services/ingest/src/parse.ts',
    from: "  if (assemblePages(pages).text === '') throw new IngestRefusal(INGEST_FAILURES.noTextLayer);\n",
    to: '',
    suite: ['unit', '@rag/ingest'],
  },
  {
    name: 'a refusal is retried like a transient fault',
    file: 'services/ingest/src/worker.ts',
    from: '      if (refusal !== null) throw new UnrecoverableError(refusal.reason);\n',
    to: '',
    suite: ['integration', undefined, 'ingest'],
  },
  {
    name: 'a killed worker’s job is failed instead of picked up again',
    file: 'services/ingest/src/worker.ts',
    from: '    maxStalledCount: 2,\n',
    to: '    maxStalledCount: 0,\n',
    suite: ['integration', undefined, 'ingest'],
  },
  {
    name: 'upload budget applied to every route',
    file: 'apps/api/src/common/throttle.ts',
    from: "      skipIf: (context) => budgetOf(context) !== 'upload',\n",
    to: '',
    suite: ['integration', 'documents'],
  },
  {
    name: 'a .pdf is accepted by its name, not its bytes',
    file: 'packages/shared/src/server/sniff.ts',
    from: '    return isPdf(file.head)\n',
    to: '    return true\n',
    suite: ['integration', 'documents'],
  },
  {
    name: 'a document is read without the owner filter',
    file: 'apps/api/src/documents/documents.service.ts',
    from: '    const row = await this.prisma.client.document.findFirst({\n      where: { id, ownerId },\n      select: DOCUMENT_SELECT,\n',
    to: '    const row = await this.prisma.client.document.findFirst({\n      where: { id },\n      select: DOCUMENT_SELECT,\n',
    suite: ['integration', 'documents'],
  },
  {
    name: 'an event stream hears every subscribed channel',
    file: 'apps/api/src/infra/ingest-events.service.ts',
    from: '      for (const listener of this.listeners.get(channel)?.set ?? []) listener(parsed.data);\n',
    to: '      for (const entry of this.listeners.values()) for (const listener of entry.set) listener(parsed.data);\n',
    suite: ['integration', 'documents'],
  },
  {
    name: 'status leaves the ingest worker out',
    file: 'apps/api/src/status/status.controller.ts',
    from: 'services: [api, ingest] };',
    to: 'services: [api] };',
    suite: ['integration', 'health'],
  },
  // --- the chat stream (build step 7) ---------------------------------------
  {
    name: 'a marker naming nothing packed reaches the reader (unit)',
    file: 'services/answer/src/answer.ts',
    from: '  markers = createMarkerStream(retrieval.sources.map((s) => s.marker));',
    to: '  markers = createMarkerStream(Array.from({ length: 50 }, (_, i) => i + 1));',
    suite: ['unit', '@rag/answer'],
  },
  {
    name: 'a marker naming nothing packed reaches the reader (API)',
    file: 'services/answer/src/answer.ts',
    from: '  markers = createMarkerStream(retrieval.sources.map((s) => s.marker));',
    to: '  markers = createMarkerStream(Array.from({ length: 50 }, (_, i) => i + 1));',
    suite: ['integration', 'chat'],
  },
  {
    name: 'an abstention still calls the model',
    file: 'services/answer/src/answer.ts',
    from: '  if (retrieval.abstained) {',
    to: '  if (retrieval.abstained && false) {',
    suite: ['integration', 'chat'],
  },
  {
    name: 'a closed request does not stop the model',
    file: 'apps/api/src/chat/chat.controller.ts',
    from: '      if (!response.writableEnded) stop.abort();',
    to: '      if (!response.writableEnded) void 0;',
    suite: ['integration', 'chat'],
  },
  {
    name: 'a stop is stored as a failure',
    file: 'services/answer/src/answer.ts',
    from: "    if (stop?.aborted === true) return finish('STOPPED', null);",
    to: '',
    suite: ['unit', '@rag/answer'],
  },
  {
    name: 'history keeps the old answer’s markers',
    file: 'services/answer/src/prompt.ts',
    from: '    const answer = stripMarkers(exchange.answer).trim();',
    to: '    const answer = exchange.answer.trim();',
    suite: ['integration', 'chat'],
  },
  {
    name: 'an abstention is history for the next prompt',
    file: 'apps/api/src/conversations/conversations.service.ts',
    from: '      !reply.abstained\n',
    to: '      true\n',
    suite: ['integration', 'chat'],
  },
  {
    name: 'a conversation is read without the owner filter',
    file: 'apps/api/src/conversations/conversations.service.ts',
    from: '      where: { id, ownerId },\n      select: { id: true, collectionId: true, _count: { select: { messages: true } } },',
    to: '      where: { id },\n      select: { id: true, collectionId: true, _count: { select: { messages: true } } },',
    suite: ['integration', 'chat'],
  },
  {
    name: 'a citation is stored against a chunk deleted mid-answer',
    file: 'apps/api/src/chat/chat.service.ts',
    from: '          chunkId: live ? c.chunkId : null,',
    to: '          chunkId: c.chunkId,',
    suite: ['integration', 'chat'],
  },
  {
    name: 'an answer a dead process left behind blocks the conversation',
    file: 'apps/api/src/conversations/conversations.service.ts',
    from: `        AND "created_at" < now() - make_interval(secs => \${ORPHAN_AFTER_MS / 1000})\``,
    to: `        AND false AND "created_at" < now() - make_interval(secs => \${ORPHAN_AFTER_MS / 1000})\``,
    suite: ['integration', 'chat'],
  },
  {
    name: 'chat budget applied to every route',
    file: 'apps/api/src/common/throttle.ts',
    from: "      skipIf: (context) => budgetOf(context) !== 'chat',\n",
    to: '',
    suite: ['integration', 'chat'],
  },
  // --- the eval lane's own arithmetic (evals/) ------------------------------
  {
    name: 'eval threshold chosen on the questions it is scored on',
    file: 'evals/src/run.ts',
    from: "const dev = hybrid.filter((r) => r.split === 'dev').map(toRow);",
    to: 'const dev = hybrid.map(toRow);',
    suite: ['unit', '@rag/evals'],
  },
  {
    name: 'eval correct abstention counted over answerable questions',
    file: 'evals/src/metrics.ts',
    from: 'correctAbstention: share(unanswerable),',
    to: 'correctAbstention: share(answerable),',
    suite: ['unit', '@rag/evals'],
  },
  {
    name: 'eval faithfulness not corrected for the judge errors',
    file: 'evals/src/metrics.ts',
    from: 'return Math.min(1, Math.max(0, (observed + judge.tnr - 1) / denominator));',
    to: 'return Math.min(1, Math.max(0, observed));',
    suite: ['unit', '@rag/evals'],
  },
  {
    name: 'eval judge reply with a doubled claim read as a verdict',
    file: 'evals/src/judge.ts',
    from: 'if (v.claim > claims || out[v.claim - 1] !== undefined) return null;',
    to: 'if (v.claim > claims) return null;',
    suite: ['unit', '@rag/evals'],
  },
  {
    name: 'eval false abstention ceiling read as a floor',
    file: 'evals/src/report.ts',
    from: 'pass: value !== null && value <= ceiling,',
    to: 'pass: value !== null && value >= ceiling,',
    suite: ['unit', '@rag/evals'],
  },
  {
    name: 'eval precision judged part not corrected',
    file: 'evals/src/metrics.ts',
    from: 'const share = corrected(judgedSupporting / judged, judge);',
    to: 'const share = judgedSupporting / judged;',
    suite: ['unit', '@rag/evals'],
  },
  {
    name: 'eval judge corrected by its short-passage score',
    file: 'evals/src/run.ts',
    from: 'long: agreement(rows.filter((r) => r.long)),',
    to: 'long: agreement(rows),',
    suite: ['unit', '@rag/evals'],
  },
  {
    name: 'answer prompt example cites once at the end',
    file: 'services/answer/src/prompt.ts',
    from: 'opens at 9:00 [S2].',
    to: 'opens at 9:00.',
    suite: ['unit', '@rag/answer'],
  },
];

/**
 * `--check`: no suite runs, nothing is broken. Every mutation must still
 * match its file exactly once. A refactor that moves a guarded line leaves a
 * proof that can only fail with "no match" on the next full run, which
 * nobody runs on every commit; this is the gate-lane half (CI lint job).
 */
if (process.argv.includes('--check')) {
  const stale = [];
  for (const proof of PROOFS) {
    const text = readFileSync(join(ROOT, proof.file), 'utf8');
    for (const { from } of [proof, ...(proof.also === undefined ? [] : [proof.also])]) {
      const count = text.split(from).length - 1;
      if (count !== 1) stale.push(`${proof.name}: matches ${proof.file} ${String(count)} times`);
    }
  }
  for (const line of stale) console.error(`red-proofs --check: ${line}`);
  console.log(`red-proofs --check: ${String(PROOFS.length)} proofs, ${String(stale.length)} stale`);
  process.exit(stale.length === 0 ? 0 : 1);
}

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
  const [lane, arg, phase] = suite;
  // One integration phase (db, ingest, retrieval, bench, api) instead of all
  // of them; an API filter implies the API phase.
  const env = { ...process.env, INTEGRATION_ONLY: phase ?? (arg === undefined ? '' : 'api') };
  if (proof.freshDatabase !== undefined) {
    dropDatabase(proof.freshDatabase);
    env.INTEGRATION_DATABASE_URL = databaseUrl(proof.freshDatabase);
  }
  const options = { cwd: ROOT, encoding: 'utf8', env };
  const result =
    lane === 'unit'
      ? spawnSync('pnpm', ['--filter', arg ?? '@rag/api', 'exec', 'vitest', 'run'], options)
      : lane === 'e2e'
        ? spawnSync(
            './scripts/e2e.sh',
            ['--project=chromium', arg, ...(phase === undefined ? [] : ['-g', phase])],
            options,
          )
        : spawnSync('./scripts/integration.sh', arg === undefined ? [] : [arg], options);
  return {
    status: result.status,
    tail: `${result.stdout}${result.stderr}`
      .split('\n')
      .filter((l) => /×|✘|\bFAIL\b|error TS|db-drift:/u.test(l))
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
