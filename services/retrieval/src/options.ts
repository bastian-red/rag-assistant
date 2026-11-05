/**
 * Every number retrieval runs on, in one place, so the eval lane (build step
 * 8) can sweep them and record which values it measured.
 *
 * The defaults are not guesses, but they are provisional where marked: the
 * abstain threshold and the query instruction were measured on 12 questions
 * over the seeded corpus (2026-11-05, qwen3-embedding:0.6b@ac6da0dfba84),
 * and step 8 re-measures them on about 60.
 */
import { z } from 'zod';

export const RETRIEVAL_MODES = ['hybrid', 'vector', 'text'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/**
 * The instruction Qwen3-Embedding is trained to read before a query (its
 * model card: "Instruct: <task>\nQuery: <query>"); passages are embedded
 * without one. Measured: it raised the top similarity of every answerable
 * question (0.427-0.670 without, 0.526-0.732 with) and kept them apart from
 * the unanswerable ones (at most 0.338).
 */
export const QWEN3_QUERY_INSTRUCTION =
  "Instruct: Given a question, retrieve passages from the reader's own documents that answer it\nQuery: ";

/**
 * The query instruction for the model a vector space belongs to. Only
 * Qwen3-Embedding is measured here; another model gets none rather than a
 * prompt written for a different one.
 */
export function queryInstructionFor(space: string): string | null {
  return space.startsWith('qwen3-embedding') ? QWEN3_QUERY_INSTRUCTION : null;
}

export const retrievalOptionsSchema = z
  .object({
    /** Which lists are fused. `vector` and `text` exist for the eval's comparison. */
    mode: z.enum(RETRIEVAL_MODES),
    /** Nearest neighbours by cosine taken into fusion. */
    vectorK: z.number().int().min(1).max(200),
    /** Full-text matches taken into fusion. */
    textK: z.number().int().min(1).max(200),
    /** Distinct chunks selected after fusion, before neighbours are merged. */
    k: z.number().int().min(1).max(50),
    /**
     * Reciprocal rank fusion's constant: score = sum of 1 / (rrfK + rank).
     * 60 is the value from Cormack et al. (2009), the usual default.
     */
    rrfK: z.number().min(0).max(1_000),
    /**
     * HNSW candidate list size. With `hnsw.iterative_scan` the owner filter
     * can no longer starve the result, so this is a recall knob only.
     */
    efSearch: z.number().int().min(1).max(1_000),
    /**
     * Estimated tokens the source blocks may take in the prompt. The chat
     * context is 8192 (`services/llm`); this leaves room for the system
     * prompt, the conversation and an answer of about 1,000 tokens.
     */
    contextTokens: z.number().int().min(100).max(100_000),
    /**
     * Below this best cosine similarity, the answer is "Not found in your
     * documents" and the chat model is not called. Provisional (see header):
     * the midpoint of the measured gap, 0.338 (best unanswerable) to 0.526
     * (worst answerable). Fused RRF scores cannot do this job: they are
     * ranks, so the best one is the same whether the top passage is the
     * answer or merely the least unrelated text in the library.
     */
    minSimilarity: z.number().min(-1).max(1),
    /**
     * Prepended to the query before embedding: a string, null for none, or
     * `auto` for the instruction the space's model was trained with
     * (`queryInstructionFor`).
     */
    queryInstruction: z.union([z.literal('auto'), z.string(), z.null()]),
    /** Passages shown with an abstention ("the nearest we found"). */
    nearest: z.number().int().min(0).max(10),
  })
  .strict();

export type RetrievalOptions = z.infer<typeof retrievalOptionsSchema>;

export const RETRIEVAL_DEFAULTS: Readonly<RetrievalOptions> = Object.freeze({
  mode: 'hybrid',
  vectorK: 40,
  textK: 40,
  k: 6,
  rrfK: 60,
  efSearch: 100,
  contextTokens: 3_200,
  minSimilarity: 0.43,
  queryInstruction: 'auto',
  nearest: 3,
});

/** The defaults with `overrides` applied, validated as a whole. */
export function retrievalOptions(overrides: Partial<RetrievalOptions> = {}): RetrievalOptions {
  return retrievalOptionsSchema.parse({ ...RETRIEVAL_DEFAULTS, ...overrides });
}
