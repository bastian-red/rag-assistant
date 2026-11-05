# @rag/retrieval

Hybrid retrieval over one person's library. It is a library the API calls, not a process: it
reads Postgres and asks `services/llm` for one query embedding.

```
query -> embed (with the model's query instruction)
      -> vector top 40 (HNSW, cosine) + text top 40 (Postgres full text, OR of stems)   same scope
      -> reciprocal rank fusion (k = 60) -> top 6 distinct -> overlapping neighbours merged
      -> packed under 3,200 tokens as [S1]..[Sn] -> abstain below similarity 0.43
```

```ts
import { cachedSpace, retrieve } from '@rag/retrieval';

const space = cachedSpace(() => llm.embeddingSpace());
const r = await retrieve(
  { prisma, embed: (t) => llm.embed(t), embeddingSpace: space },
  { ownerId, query: 'When does the boiler warranty end?', collectionId: null },
);
r.abstained; // true -> answer "Not found in your documents", show r.nearest, call no model
r.sources; //   [S1]..[Sn] for formatSources(), each with its chunk ids and parts
r.candidates; // every fused candidate with both ranks and its marker: the trace
```

## The scope

Both searches filter inside the SQL, never on their result:

| Filter                    | Why                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owner_id`                | Another person's chunk is never a candidate, so it can never reach a prompt (SPECS #3)                                                                                                                                                                       |
| `status = 'READY'`        | A document being re-ingested keeps its old chunks until the replace transaction commits                                                                                                                                                                      |
| `embedding_model = space` | A vector from another vector space ranks by noise. The space is `model@digest` read from the model server, so the fake under the real model's name is a different space; such documents are counted in `staleDocuments` and re-embedded by the ingest worker |
| `collection_id`           | When a question is asked of one collection                                                                                                                                                                                                                   |

## Decisions, each measured

- **Abstain on similarity, not on the fused score.** RRF scores are ranks: the best one looks the
  same whether the top passage answers the question or is merely the least unrelated text. The
  threshold 0.43 is the midpoint of the gap measured on the seeded corpus with
  `qwen3-embedding:0.6b` (best unanswerable 0.338, worst answerable 0.526); the eval lane (build
  step 8) recalibrates it on ~60 questions.
- **The Qwen3 query instruction** (`Instruct: ...\nQuery: `) raised every answerable question's top
  similarity (0.427-0.670 to 0.526-0.732). `queryInstruction: 'auto'` applies it only to a
  `qwen3-embedding` space; the fake model server strips it, as the real model is trained to.
- **Full text ORs the question's stems.** `plainto_tsquery` ANDs them, and a question rarely has
  every word in one passage.
- **Neighbours merge only when their spans overlap or touch**, so the merged text is the exact
  document text; a citation is still stored against the one chunk its quote is in (`partOf` in
  `@rag/citations`).
- **Custom plans, always.** A prepared statement re-run with new parameters switches to a generic
  plan, which cannot use HNSW for `ORDER BY embedding <=> $1`: 6 ms inside Postgres, 657 ms from
  the client, until `plan_cache_mode = force_custom_plan`.
- **Vectors stay in the row** (migration `20261105120000_chunk_inline_storage`): a chunk row is over
  2 KB, so vectors had been TOASTed and every distance read the TOAST table.

## Speed (SPECS #8)

`node scripts/retrieval-bench.mjs` (run by `scripts/integration.sh`) writes 5,000 chunks for each
of two people, then times `retrieve()` over 200 questions. On this machine (2026-11-05):

| Stage                    | Before   | After |
| ------------------------ | -------- | ----- |
| `retrieve()` p95         | 1,073 ms | 56 ms |
| vector search alone, p95 | 657 ms   | 16 ms |
| text search alone, p95   | 1,098 ms | 44 ms |

`--explain` prints `EXPLAIN (ANALYZE, BUFFERS)` of both searches; the vector plan must name
`chunks_embedding_hnsw_idx`.

## Files

| File              | What it holds                                                                |
| ----------------- | ---------------------------------------------------------------------------- |
| `src/options.ts`  | Every number retrieval runs on, with where it came from                      |
| `src/search.ts`   | The two searches and the stale count, in SQL, with their plans for the bench |
| `src/fuse.ts`     | Reciprocal rank fusion, totally ordered                                      |
| `src/pack.ts`     | Select distinct, merge neighbours, pack under the budget, number the sources |
| `src/abstain.ts`  | When not to call the chat model                                              |
| `src/retrieve.ts` | The whole question, with the trace; `cachedSpace`                            |

## Tests

```bash
pnpm --filter @rag/retrieval test                 # gate: fusion, packing (property-tested), abstain, options
./scripts/integration.sh                          # rag_it: isolation, scope, merging, abstention, the bench
```
