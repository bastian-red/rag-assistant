-- Build step 2: the library (collections, documents, chunks) and the answers
-- (conversations, messages, citations, retrieval traces).
--
-- The first half is what `prisma migrate diff` generates from schema.prisma,
-- with one edit: `tsv` is a generated column (Prisma declares it
-- `dbgenerated()` and cannot write the expression). The second half is
-- hand-written, because schema.prisma cannot say it. Every name in it is
-- exported from src/constraints.ts, and constraints.test.ts fails if a name
-- there is missing here.

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('QUEUED', 'PARSING', 'EMBEDDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "message_role" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('STREAMING', 'DONE', 'STOPPED', 'FAILED');

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "document_status" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "pages" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "page_start" INTEGER,
    "page_end" INTEGER,
    "char_start" INTEGER NOT NULL,
    "char_end" INTEGER NOT NULL,
    "heading_path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokens" INTEGER NOT NULL,
    "embedding" halfvec(1024) NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "collection_id" TEXT,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" "message_role" NOT NULL,
    "content" TEXT NOT NULL,
    "status" "message_status" NOT NULL,
    "model" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "citations" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "marker" INTEGER NOT NULL,
    "chunk_id" TEXT,
    "document_title" TEXT NOT NULL,
    "page" INTEGER,
    "quote" TEXT NOT NULL,
    "quote_start" INTEGER NOT NULL,
    "quote_end" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retrieval_traces" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "embed_model" TEXT NOT NULL,
    "chat_model" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retrieval_traces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "collections_owner_id_name_key" ON "collections"("owner_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "collections_id_owner_id_key" ON "collections"("id", "owner_id");

-- CreateIndex
CREATE INDEX "documents_collection_id_idx" ON "documents"("collection_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_owner_id_sha256_key" ON "documents"("owner_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "documents_id_owner_id_key" ON "documents"("id", "owner_id");

-- CreateIndex
CREATE INDEX "chunks_owner_id_document_id_idx" ON "chunks"("owner_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "chunks_document_id_ord_key" ON "chunks"("document_id", "ord");

-- CreateIndex
CREATE UNIQUE INDEX "chunks_id_owner_id_key" ON "chunks"("id", "owner_id");

-- CreateIndex
CREATE INDEX "conversations_owner_id_updated_at_idx" ON "conversations"("owner_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_id_owner_id_key" ON "conversations"("id", "owner_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_id_owner_id_key" ON "messages"("id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "citations_message_id_marker_key" ON "citations"("message_id", "marker");

-- CreateIndex
CREATE UNIQUE INDEX "retrieval_traces_message_id_key" ON "retrieval_traces"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "retrieval_traces_message_id_owner_id_key" ON "retrieval_traces"("message_id", "owner_id");

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_collection_same_owner_fkey" FOREIGN KEY ("collection_id", "owner_id") REFERENCES "collections"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_same_owner_fkey" FOREIGN KEY ("document_id", "owner_id") REFERENCES "documents"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_same_owner_fkey" FOREIGN KEY ("conversation_id", "owner_id") REFERENCES "conversations"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_message_same_owner_fkey" FOREIGN KEY ("message_id", "owner_id") REFERENCES "messages"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citations" ADD CONSTRAINT "citations_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retrieval_traces" ADD CONSTRAINT "retrieval_traces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retrieval_traces" ADD CONSTRAINT "retrieval_traces_message_same_owner_fkey" FOREIGN KEY ("message_id", "owner_id") REFERENCES "messages"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written. Nothing below can be declared in schema.prisma.
-- ===========================================================================

-- --- Same-owner links that must survive their target's deletion ------------
-- A conversation outlives its collection and a citation outlives its chunk,
-- so these two composite keys clear ONE column on delete. A plain
-- `ON DELETE SET NULL` would also null owner_id, which is NOT NULL, and the
-- delete would fail. The column-list form is Postgres 15+.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_collection_same_owner_fkey"
  FOREIGN KEY ("collection_id", "owner_id") REFERENCES "collections"("id", "owner_id")
  ON DELETE SET NULL ("collection_id");

ALTER TABLE "citations"
  ADD CONSTRAINT "citations_chunk_same_owner_fkey"
  FOREIGN KEY ("chunk_id", "owner_id") REFERENCES "chunks"("id", "owner_id")
  ON DELETE SET NULL ("chunk_id");

-- --- Retrieval indexes -------------------------------------------------------
-- Cosine over halfvec (half the storage of vector, recall loss negligible for
-- a 1024-wide unit-normalised embedding). m and ef_construction are pgvector's
-- defaults, written out so a change is a reviewed migration.
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks"
  USING hnsw ("embedding" halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX "chunks_tsv_gin_idx" ON "chunks" USING gin ("tsv");

-- --- One streaming answer per conversation ---------------------------------
-- A reload, a second tab or a retried request cannot start a second
-- generation while one is in flight: the second INSERT fails by this name.
CREATE UNIQUE INDEX "messages_one_streaming_per_conversation"
  ON "messages" ("conversation_id") WHERE "status" = 'STREAMING';

-- --- CHECKs ----------------------------------------------------------------
-- "Trimmed" and "not blank" are spelled with [[:space:]], never btrim():
-- btrim strips only the space character, so '  \n ' passed a btrim check
-- as text (found by library.test.ts). [[:space:]] is the set JavaScript's
-- trim() removes, which is what the zod contracts apply before a write.

-- The step-1 users check had the same btrim hole; replaced in place.
ALTER TABLE "users"
  DROP CONSTRAINT "users_name_length_check",
  ADD CONSTRAINT "users_name_length_check"
    CHECK ("name" ~ '[^[:space:]]' AND char_length("name") BETWEEN 1 AND 80);

ALTER TABLE "collections"
  ADD CONSTRAINT "collections_name_check"
    CHECK ("name" !~ '^[[:space:]]|[[:space:]]$' AND char_length("name") BETWEEN 1 AND 80);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_title_check"
    CHECK ("title" !~ '^[[:space:]]|[[:space:]]$' AND char_length("title") BETWEEN 1 AND 200),
  ADD CONSTRAINT "documents_filename_check"
    CHECK (char_length("filename") BETWEEN 1 AND 255 AND "filename" !~ '[/\\[:cntrl:]]'),
  -- The same three types as ACCEPTED_TYPES in @rag/shared (constants.ts);
  -- constraints.test.ts compares the two lists.
  ADD CONSTRAINT "documents_mime_check"
    CHECK ("mime" IN ('application/pdf', 'text/markdown', 'text/plain')),
  -- LIMITS.uploadBytes, 20 MiB.
  ADD CONSTRAINT "documents_bytes_check" CHECK ("bytes" BETWEEN 1 AND 20971520),
  ADD CONSTRAINT "documents_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  -- FAILED says why, and nothing else carries a reason.
  ADD CONSTRAINT "documents_error_check"
    CHECK (("status" = 'FAILED') = ("error" IS NOT NULL)
           AND ("error" IS NULL OR "error" ~ '[^[:space:]]')),
  -- Pages are a PDF fact.
  ADD CONSTRAINT "documents_pages_check"
    CHECK ("pages" IS NULL OR ("pages" >= 1 AND "mime" = 'application/pdf'));

ALTER TABLE "chunks"
  ADD CONSTRAINT "chunks_ord_check" CHECK ("ord" >= 0),
  ADD CONSTRAINT "chunks_text_check" CHECK ("text" ~ '[^[:space:]]'),
  -- The span IS the text: a citation opens the document at char_start and
  -- highlights exactly what the model was shown.
  ADD CONSTRAINT "chunks_span_check"
    CHECK ("char_start" >= 0 AND "char_end" > "char_start"
           AND char_length("text") = "char_end" - "char_start"),
  ADD CONSTRAINT "chunks_pages_check"
    CHECK (("page_start" IS NULL) = ("page_end" IS NULL)
           AND ("page_start" IS NULL OR ("page_start" >= 1 AND "page_end" >= "page_start"))),
  ADD CONSTRAINT "chunks_tokens_check" CHECK ("tokens" > 0),
  -- Prisma makes list columns nullable; an absent heading path is '{}'.
  ADD CONSTRAINT "chunks_heading_path_check" CHECK ("heading_path" IS NOT NULL),
  ADD CONSTRAINT "chunks_embedding_model_check" CHECK ("embedding_model" ~ '[^[:space:]]'),
  -- Cosine distance to a zero vector is NaN, which sorts after every number
  -- and would silently drop the chunk from every result.
  ADD CONSTRAINT "chunks_embedding_nonzero_check" CHECK (l2_norm("embedding") > 0);

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_title_check"
    CHECK ("title" !~ '^[[:space:]]|[[:space:]]$' AND char_length("title") BETWEEN 1 AND 200);

ALTER TABLE "messages"
  -- A question is whole when stored, has no model, and fits LIMITS.question.
  ADD CONSTRAINT "messages_question_check"
    CHECK ("role" <> 'USER'
           OR ("status" = 'DONE' AND "model" IS NULL
               AND "content" ~ '[^[:space:]]' AND char_length("content") BETWEEN 1 AND 2000)),
  -- IS NOT NULL is not optional: a CHECK passes when it evaluates to NULL,
  -- and NULL ~ anything is NULL.
  ADD CONSTRAINT "messages_answer_model_check"
    CHECK ("role" <> 'ASSISTANT' OR ("model" IS NOT NULL AND "model" ~ '[^[:space:]]')),
  ADD CONSTRAINT "messages_error_check"
    CHECK (("status" = 'FAILED') = ("error" IS NOT NULL)
           AND ("error" IS NULL OR "error" ~ '[^[:space:]]'));

ALTER TABLE "citations"
  ADD CONSTRAINT "citations_marker_check" CHECK ("marker" BETWEEN 1 AND 50),
  ADD CONSTRAINT "citations_quote_check"
    CHECK ("quote_start" >= 0 AND "quote_end" > "quote_start"
           AND char_length("quote") = "quote_end" - "quote_start"),
  ADD CONSTRAINT "citations_page_check" CHECK ("page" IS NULL OR "page" >= 1);

ALTER TABLE "retrieval_traces"
  ADD CONSTRAINT "retrieval_traces_latency_check" CHECK ("latency_ms" >= 0),
  ADD CONSTRAINT "retrieval_traces_candidates_check"
    CHECK (jsonb_typeof("candidates") = 'array');
