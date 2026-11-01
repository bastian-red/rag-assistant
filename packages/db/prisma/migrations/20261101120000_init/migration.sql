-- pgvector. The compose image is pgvector/pgvector:pg17; a plain postgres
-- image fails here with "extension \"vector\" is not available", which is the
-- error we want to see on the first migrate rather than on the first embedding.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- Emails are stored the way the contracts normalise them, so the unique index
-- cannot hold two spellings of one address.
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase_check" CHECK ("email" = lower("email")),
  ADD CONSTRAINT "users_name_length_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80);
