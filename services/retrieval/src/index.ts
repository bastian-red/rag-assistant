export {
  retrieve,
  cachedSpace,
  retrievalQuerySchema,
  QueryVectorError,
  QUERY_DIMENSIONS,
  type Retrieval,
  type RetrievalDeps,
  type RetrievalQuery,
  type TracedCandidate,
} from './retrieve';
export {
  RETRIEVAL_DEFAULTS,
  RETRIEVAL_MODES,
  QWEN3_QUERY_INSTRUCTION,
  queryInstructionFor,
  retrievalOptions,
  retrievalOptionsSchema,
  type RetrievalMode,
  type RetrievalOptions,
} from './options';
export { fuse, type TextHit, type VectorHit } from './fuse';
export { pack, select, mergeNeighbours, type Packed, type RetrievedSource } from './pack';
export { decide, type AbstainReason, type Verdict } from './abstain';
export {
  vectorSearch,
  vectorSearchPlan,
  textSearch,
  textSearchPlan,
  staleDocuments,
  vectorLiteral,
  type Scope,
} from './search';
export type { CandidateChunk, RankedCandidate } from './candidate';
