/**
 * The two searches, in SQL, and the count of what they cannot see.
 *
 * Both search the same scope, and the owner filter is inside each query, not
 * applied to its result (SPECS #3: another person's chunk is never a
 * candidate, so it can never reach a prompt):
 *
 * - the asking person's chunks (`owner_id`),
 * - of READY documents only: a document being re-ingested still holds its
 *   old chunks until the replace transaction commits, and a FAILED one has
 *   none,
 * - embedded in the current vector space (`embedding_model`, see
 *   `embeddingSpace` in @rag/shared): a vector from another space ranks by
 *   noise; such chunks are counted (`staleDocuments`) instead of searched,
 * - in one collection, when the question is asked of one.
 *
 * **Vector**: cosine over the HNSW index. `hnsw.iterative_scan =
 * relaxed_order` is what makes the owner filter safe: plain HNSW collects
 * `ef_search` candidates and only then filters, so a person whose chunks
 * all sit behind someone else's got fewer than k, or none
 * (packages/db/test/retrieval-index.test.ts holds that). Relaxed order may
 * return rows slightly out of distance order, so the caller sorts.
 *
 * **Text**: English full text over the generated `tsv` (GIN). The query's
 * lexemes are OR-ed, not AND-ed: `plainto_tsquery` requires every word, and
 * a question ("when was the boiler last serviced") rarely has all its words
 * in one passage. Ranked by `ts_rank` with length normalisation 1 (divide by
 * 1 + log of the passage length), so a long chunk does not win by repeating
 * a common word.
 */
import { Prisma, type PrismaClient } from '@rag/db';

import type { CandidateChunk } from './candidate';
import type { TextHit, VectorHit } from './fuse';

export interface Scope {
  readonly ownerId: string;
  readonly space: string;
  readonly collectionId: string | null;
}

interface Row {
  id: string;
  document_id: string;
  title: string;
  ord: number;
  text: string;
  char_start: number;
  char_end: number;
  page_start: number | null;
  page_end: number | null;
  page_starts: unknown;
  heading_path: string[];
  tokens: number;
  similarity: number | null;
}

const COLUMNS = Prisma.sql`
  c."id", c."document_id", d."title", c."ord", c."text", c."char_start", c."char_end",
  c."page_start", c."page_end", c."page_starts", c."heading_path", c."tokens"`;

const FROM = Prisma.sql`
  FROM "chunks" c
  JOIN "documents" d ON d."id" = c."document_id" AND d."owner_id" = c."owner_id"`;

function where(scope: Scope): Prisma.Sql {
  const collection =
    scope.collectionId === null
      ? Prisma.empty
      : Prisma.sql`AND d."collection_id" = ${scope.collectionId}`;
  return Prisma.sql`
    c."owner_id" = ${scope.ownerId}
    AND c."embedding_model" = ${scope.space}
    AND d."status" = 'READY'
    ${collection}`;
}

/** pgvector's text form; `String(number)` round-trips. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map(String).join(',')}]`;
}

function pageStartsOf(value: unknown): { page: number; at: number }[] {
  // Held by chunks_page_starts_check; read defensively all the same.
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is { page: number; at: number } =>
      typeof e === 'object' &&
      e !== null &&
      Number.isInteger((e as { page?: unknown }).page) &&
      Number.isInteger((e as { at?: unknown }).at),
  );
}

function chunkOf(row: Row): CandidateChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    documentTitle: row.title,
    ord: row.ord,
    text: row.text,
    charStart: row.char_start,
    charEnd: row.char_end,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    pageStarts: pageStartsOf(row.page_starts),
    headingPath: row.heading_path,
    tokens: row.tokens,
  };
}

const byId = (a: { chunk: CandidateChunk }, b: { chunk: CandidateChunk }) =>
  a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;

function checkEfSearch(efSearch: number): void {
  if (!Number.isInteger(efSearch) || efSearch < 1 || efSearch > 1_000) {
    throw new RangeError(`efSearch is 1-1000, got ${String(efSearch)}`);
  }
}

function vectorSql(scope: Scope, literal: string, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT ${COLUMNS}, 1 - (c."embedding" <=> ${literal}::halfvec(1024)) AS "similarity"
    ${FROM}
    WHERE ${where(scope)}
    ORDER BY c."embedding" <=> ${literal}::halfvec(1024)
    LIMIT ${limit}`;
}

/** A transaction in which every statement is planned with its real parameters (see the header). */
async function withCustomPlans<T>(
  prisma: PrismaClient,
  body: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL plan_cache_mode = force_custom_plan`);
    return body(tx);
  });
}

/** Run `body` in a transaction with the HNSW settings the vector search uses. */
async function withHnsw<T>(
  prisma: PrismaClient,
  efSearch: number,
  body: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  checkEfSearch(efSearch);
  return withCustomPlans(prisma, async (tx) => {
    // SET cannot take a bind parameter; the value is a checked integer.
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${String(efSearch)}`);
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return body(tx);
  });
}

export async function vectorSearch(
  prisma: PrismaClient,
  scope: Scope,
  vector: readonly number[],
  limit: number,
  efSearch: number,
): Promise<VectorHit[]> {
  const sql = vectorSql(scope, vectorLiteral(vector), limit);
  const rows = await withHnsw(prisma, efSearch, (tx) => tx.$queryRaw<Row[]>(sql));
  return rows
    .map((row) => ({ chunk: chunkOf(row), similarity: Number(row.similarity) }))
    .sort((a, b) => b.similarity - a.similarity || byId(a, b));
}

/**
 * The planner's plan for exactly the query `vectorSearch` runs, under the
 * same settings: what the bench prints, so "HNSW was used" is read, not
 * assumed.
 */
export async function vectorSearchPlan(
  prisma: PrismaClient,
  scope: Scope,
  vector: readonly number[],
  limit: number,
  efSearch: number,
  options: { analyze?: boolean } = {},
): Promise<string> {
  const sql = vectorSql(scope, vectorLiteral(vector), limit);
  const explain =
    options.analyze === true ? Prisma.sql`EXPLAIN (ANALYZE, BUFFERS)` : Prisma.sql`EXPLAIN`;
  const rows = await withHnsw(prisma, efSearch, (tx) =>
    tx.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`${explain} ${sql}`),
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

function textSql(
  scope: Scope,
  query: string,
  vector: readonly number[] | null,
  limit: number,
): Prisma.Sql {
  const similarity =
    vector === null
      ? Prisma.sql`NULL::float8`
      : Prisma.sql`1 - (c."embedding" <=> ${vectorLiteral(vector)}::halfvec(1024))`;
  // plainto_tsquery joins lexemes with & (and <-> inside a hyphenated word);
  // every joiner becomes |. A query of stop words only gives '', no query.
  return Prisma.sql`
    WITH q AS (
      SELECT CASE WHEN t = '' THEN NULL ELSE t::tsquery END AS "query"
      FROM (
        SELECT regexp_replace(
          plainto_tsquery('english', ${query})::text, ' (&|<->|<[0-9]+>) ', ' | ', 'g'
        ) AS t
      ) raw
    ),
    top AS (
      SELECT c."id", ts_rank(c."tsv", q."query", 1) AS "lexical"
      ${FROM}
      CROSS JOIN q
      WHERE c."tsv" @@ q."query" AND ${where(scope)}
      ORDER BY "lexical" DESC, c."id"
      LIMIT ${limit}
    )
    SELECT ${COLUMNS}, top."lexical", ${similarity} AS "similarity"
    FROM top
    JOIN "chunks" c ON c."id" = top."id"
    JOIN "documents" d ON d."id" = c."document_id" AND d."owner_id" = c."owner_id"
    ORDER BY top."lexical" DESC, c."id"`;
}

export async function textSearch(
  prisma: PrismaClient,
  scope: Scope,
  query: string,
  vector: readonly number[] | null,
  limit: number,
): Promise<TextHit[]> {
  const sql = textSql(scope, query, vector, limit);
  const rows = await withCustomPlans(prisma, (tx) =>
    tx.$queryRaw<(Row & { lexical: number })[]>(sql),
  );
  return rows.map((row) => ({
    chunk: chunkOf(row),
    lexical: Number(row.lexical),
    similarity: row.similarity === null ? null : Number(row.similarity),
  }));
}

/** `EXPLAIN (ANALYZE, BUFFERS)` of exactly the query `textSearch` runs. */
export async function textSearchPlan(
  prisma: PrismaClient,
  scope: Scope,
  query: string,
  vector: readonly number[] | null,
  limit: number,
): Promise<string> {
  const sql = Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${textSql(scope, query, vector, limit)}`;
  const rows = await withCustomPlans(prisma, (tx) => tx.$queryRaw<{ 'QUERY PLAN': string }[]>(sql));
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

/**
 * READY documents in scope whose chunks are in another vector space: what a
 * question cannot see until the ingest worker embeds them again.
 */
export async function staleDocuments(prisma: PrismaClient, scope: Scope): Promise<number> {
  const collection =
    scope.collectionId === null
      ? Prisma.empty
      : Prisma.sql`AND d."collection_id" = ${scope.collectionId}`;
  const [row] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(DISTINCT c."document_id")::int AS "n"
    ${FROM}
    WHERE c."owner_id" = ${scope.ownerId}
      AND c."embedding_model" <> ${scope.space}
      AND d."status" = 'READY'
      ${collection}`;
  return row?.n ?? 0;
}
