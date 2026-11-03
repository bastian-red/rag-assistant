# @rag/ingest

The ingest worker. It takes a document's job off the BullMQ queue `ingest`, reads the stored
upload, and leaves the document READY with one chunk set, or FAILED with a reason a reader can
act on. The API (`apps/api`) adds the jobs; nothing else consumes them.

```
load -> PARSING -> read + verify sha256 -> parse -> chunk -> EMBEDDING (progress per batch)
     -> one transaction: lock the row, delete its chunks, insert the new set, READY
```

| File               | What it holds                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/config.ts`    | Every variable it reads, parsed once at boot (`UPLOAD_DIR` must be absolute)                                 |
| `src/parse.ts`     | Bytes to text: unpdf 1.7.0 for PDF, one string per page; strict UTF-8 for markdown and text                  |
| `src/pipeline.ts`  | One document, start to finish; nothing durable is written until the last step                                |
| `src/store.ts`     | Every Postgres write: status moves, the replace-chunks transaction, FAILED with no chunks                    |
| `src/errors.ts`    | `IngestRefusal` (the file is the problem: final) versus everything else (retried)                            |
| `src/worker.ts`    | The BullMQ consumer: no retry for a refusal, FAILED on the last attempt, a stalled job past the limit marked |
| `src/reconcile.ts` | At start, every unfinished document gets its job back (idempotent: `jobId = documentId`)                     |
| `src/events.ts`    | Progress on the owner's Redis channel (`ingest:events:<ownerId>`)                                            |
| `src/health.ts`    | `GET /health`: Postgres, Redis, the embedding model, a write to `UPLOAD_DIR`, the consumer running           |
| `src/app.ts`       | The pieces assembled; `main.ts` runs it, the crash test runs it in a child process it kills                  |

## Configuration

`DATABASE_URL`, `REDIS_URL`, `OLLAMA_URL`, `EMBED_MODEL`, `UPLOAD_DIR` (shared with the API),
`INGEST_PORT` (4500), `INGEST_CONCURRENCY` (1), `INGEST_LOCK_MS` (30000). All documented in the
root `.env.example`.

## Tests

```bash
pnpm --filter @rag/ingest test     # gate lane: config, the parser on generated PDFs, failure sorting
./scripts/integration.sh           # the pipeline, the queue and a worker killed mid-embed (rag_it, Redis db 1, the fake)
```

The test PDFs are built in code (`test/pdf.ts`), so no binary fixture is committed. A `null` page
is a grey rectangle with no text operators, which is what a scanned page is to an extractor.
