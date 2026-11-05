/**
 * One question in, the sources for its prompt out (or an abstention):
 *
 *   embed the query (with the model's query instruction)
 *     -> vector top `vectorK` and text top `textK`, the same scope, in parallel
 *     -> reciprocal rank fusion -> top `k` distinct -> neighbours merged
 *     -> packed under the token budget, labelled [S1]..[Sn]
 *     -> abstain when nothing is within `minSimilarity`
 *
 * Everything the trace needs comes back with it (every candidate's ranks,
 * scores and the marker it got, the timings, what was skipped and why), so
 * an answer can be audited later without re-running the search.
 */
import type { PrismaClient } from '@rag/db';
import { idSchema, LIMITS } from '@rag/shared';
import { z } from 'zod';

import { decide, type AbstainReason } from './abstain';
import type { RankedCandidate } from './candidate';
import { fuse, type TextHit, type VectorHit } from './fuse';
import {
  queryInstructionFor,
  retrievalOptions,
  type RetrievalMode,
  type RetrievalOptions,
} from './options';
import { pack, type RetrievedSource } from './pack';
import { staleDocuments, textSearch, vectorSearch, type Scope } from './search';

/** Width of `chunks.embedding` (halfvec(1024)); a query vector must match it. */
export const QUERY_DIMENSIONS = 1024;

export interface RetrievalDeps {
  readonly prisma: PrismaClient;
  /** The configured embedding model, through `services/llm`. */
  readonly embed: (texts: readonly string[]) => Promise<number[][]>;
  /** The space `embed` writes into, from the model server (see `cachedSpace`). */
  readonly embeddingSpace: () => Promise<string>;
  readonly now?: () => number;
}

export const retrievalQuerySchema = z
  .object({
    ownerId: idSchema,
    query: z.string().trim().min(1).max(LIMITS.question),
    collectionId: idSchema.nullable().default(null),
  })
  .strict();
export type RetrievalQuery = z.input<typeof retrievalQuerySchema>;

/** One candidate as the trace stores it. */
export interface TracedCandidate {
  readonly chunkId: string;
  readonly documentId: string;
  readonly vectorRank: number | null;
  readonly textRank: number | null;
  readonly similarity: number | null;
  readonly lexical: number | null;
  readonly fused: number;
  /** The marker of the source it went into; null when not packed. */
  readonly marker: number | null;
}

export interface Retrieval {
  readonly query: string;
  readonly mode: RetrievalMode;
  readonly space: string;
  readonly abstained: boolean;
  readonly reason: AbstainReason | null;
  readonly bestSimilarity: number | null;
  /** The prompt's sources, [S1] first. Empty when abstained. */
  readonly sources: readonly RetrievedSource[];
  /** With an abstention, the closest passages to show the reader; else empty. */
  readonly nearest: readonly RetrievedSource[];
  readonly candidates: readonly TracedCandidate[];
  readonly skipped: { readonly duplicates: number; readonly overBudget: number };
  /** READY documents in scope embedded in another space (not searched). */
  readonly staleDocuments: number;
  readonly timings: {
    readonly embedMs: number;
    readonly searchMs: number;
    readonly totalMs: number;
  };
}

export class QueryVectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryVectorError';
  }
}

export async function retrieve(
  deps: RetrievalDeps,
  input: RetrievalQuery,
  overrides: Partial<RetrievalOptions> = {},
): Promise<Retrieval> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const { ownerId, query, collectionId } = retrievalQuerySchema.parse(input);
  const options = retrievalOptions(overrides);

  const space = await deps.embeddingSpace();
  const scope: Scope = { ownerId, space, collectionId };

  let vector: number[] | null = null;
  const embedStarted = now();
  if (options.mode !== 'text') {
    const instruction =
      options.queryInstruction === 'auto' ? queryInstructionFor(space) : options.queryInstruction;
    const [embedded] = await deps.embed([`${instruction ?? ''}${query}`]);
    if (embedded?.length !== QUERY_DIMENSIONS || !embedded.every(Number.isFinite)) {
      throw new QueryVectorError(
        `the query vector must be ${String(QUERY_DIMENSIONS)} finite numbers, got ${String(embedded?.length ?? 0)}`,
      );
    }
    vector = embedded;
  }
  const embedMs = now() - embedStarted;

  const searchStarted = now();
  const [vectorHits, textHits, stale] = await Promise.all([
    vector === null
      ? Promise.resolve<VectorHit[]>([])
      : vectorSearch(deps.prisma, scope, vector, options.vectorK, options.efSearch),
    options.mode === 'vector'
      ? Promise.resolve<TextHit[]>([])
      : textSearch(deps.prisma, scope, query, vector, options.textK),
    staleDocuments(deps.prisma, scope),
  ]);
  const searchMs = now() - searchStarted;

  const ranked: RankedCandidate[] = fuse(vectorHits, textHits, options.rrfK);
  const packed = pack(ranked, options);
  const verdict = decide(ranked, packed.sources.length, options.mode, options.minSimilarity);

  const markerOf = new Map<string, number>();
  if (!verdict.abstain) {
    for (const source of packed.sources) {
      for (const id of source.chunkIds) markerOf.set(id, source.marker);
    }
  }
  return {
    query,
    mode: options.mode,
    space,
    abstained: verdict.abstain,
    reason: verdict.reason,
    bestSimilarity: verdict.bestSimilarity,
    sources: verdict.abstain ? [] : packed.sources,
    nearest: verdict.abstain ? packed.sources.slice(0, options.nearest) : [],
    candidates: ranked.map((c) => ({
      chunkId: c.id,
      documentId: c.documentId,
      vectorRank: c.vectorRank,
      textRank: c.textRank,
      similarity: c.similarity,
      lexical: c.lexical,
      fused: c.fused,
      marker: markerOf.get(c.id) ?? null,
    })),
    skipped: { duplicates: packed.duplicates, overBudget: packed.overBudget },
    staleDocuments: stale,
    timings: { embedMs, searchMs, totalMs: now() - started },
  };
}

/**
 * `embeddingSpace` asked of the model server at most once per `ttlMs`: it is
 * one `/api/tags` call, and a question should not pay it every time. A
 * failed read is not cached. A model re-pulled shows after at most `ttlMs`.
 */
export function cachedSpace(
  read: () => Promise<string>,
  ttlMs = 10_000,
  clock: () => number = Date.now,
): () => Promise<string> {
  let value: { space: string; at: number } | null = null;
  return async () => {
    if (value !== null && clock() - value.at < ttlMs) return value.space;
    const space = await read();
    value = { space, at: clock() };
    return space;
  };
}
