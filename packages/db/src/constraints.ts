/**
 * The names Postgres will use when it refuses a write. Catch blocks match on
 * these, never on message text.
 *
 * `constraints.test.ts` fails if a name exported here does not appear in a
 * migration, so a renamed index cannot leave a catch block matching nothing.
 */

export const PRISMA_UNIQUE_VIOLATION = 'P2002';
export const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';
export const PRISMA_NOT_FOUND = 'P2025';
/** `$executeRaw` / `$queryRaw` failed; the SQLSTATE is in `meta.code`. */
export const PRISMA_RAW_QUERY_FAILED = 'P2010';

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

export const USER_EMAIL_UNIQUE = 'users_email_key';
export const USER_EMAIL_LOWERCASE = 'users_email_lowercase_check';
export const USER_NAME_LENGTH = 'users_name_length_check';

// --- uniques ------------------------------------------------------------------
export const COLLECTION_NAME_UNIQUE = 'collections_owner_id_name_key';
/** A second upload of the same bytes by the same person is the same document. */
export const DOCUMENT_SHA256_UNIQUE = 'documents_owner_id_sha256_key';
export const CHUNK_ORD_UNIQUE = 'chunks_document_id_ord_key';
export const CITATION_MARKER_UNIQUE = 'citations_message_id_marker_key';
export const TRACE_MESSAGE_UNIQUE = 'retrieval_traces_message_id_key';
/** Partial: one STREAMING answer per conversation (hand-written). */
export const ONE_STREAMING_ANSWER = 'messages_one_streaming_per_conversation';

export const UNIQUE_INDEXES = Object.freeze({
  USER_EMAIL_UNIQUE,
  COLLECTION_NAME_UNIQUE,
  DOCUMENT_SHA256_UNIQUE,
  CHUNK_ORD_UNIQUE,
  CITATION_MARKER_UNIQUE,
  TRACE_MESSAGE_UNIQUE,
  ONE_STREAMING_ANSWER,
});

export const UNIQUE_INDEX_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [USER_EMAIL_UNIQUE]: Object.freeze(['email']),
  [COLLECTION_NAME_UNIQUE]: Object.freeze(['owner_id', 'name']),
  [DOCUMENT_SHA256_UNIQUE]: Object.freeze(['owner_id', 'sha256']),
  [CHUNK_ORD_UNIQUE]: Object.freeze(['document_id', 'ord']),
  [CITATION_MARKER_UNIQUE]: Object.freeze(['message_id', 'marker']),
  [TRACE_MESSAGE_UNIQUE]: Object.freeze(['message_id']),
  [ONE_STREAMING_ANSWER]: Object.freeze(['conversation_id']),
});

// --- same-owner composite foreign keys ------------------------------------
// Each refuses a row that points at another person's row. The first four are
// declared in schema.prisma; the last two are hand-written (SET NULL (col)).
export const DOCUMENT_COLLECTION_SAME_OWNER = 'documents_collection_same_owner_fkey';
export const CHUNK_DOCUMENT_SAME_OWNER = 'chunks_document_same_owner_fkey';
export const MESSAGE_CONVERSATION_SAME_OWNER = 'messages_conversation_same_owner_fkey';
export const CITATION_MESSAGE_SAME_OWNER = 'citations_message_same_owner_fkey';
export const TRACE_MESSAGE_SAME_OWNER = 'retrieval_traces_message_same_owner_fkey';
export const CONVERSATION_COLLECTION_SAME_OWNER = 'conversations_collection_same_owner_fkey';
export const CITATION_CHUNK_SAME_OWNER = 'citations_chunk_same_owner_fkey';

// --- indexes retrieval depends on (hand-written) ----------------------------
export const CHUNK_EMBEDDING_INDEX = 'chunks_embedding_hnsw_idx';
export const CHUNK_TSV_INDEX = 'chunks_tsv_gin_idx';

// --- CHECKs -------------------------------------------------------------------
export const COLLECTION_NAME = 'collections_name_check';
export const DOCUMENT_TITLE = 'documents_title_check';
export const DOCUMENT_FILENAME = 'documents_filename_check';
export const DOCUMENT_MIME = 'documents_mime_check';
export const DOCUMENT_BYTES = 'documents_bytes_check';
export const DOCUMENT_SHA256 = 'documents_sha256_check';
export const DOCUMENT_ERROR = 'documents_error_check';
export const DOCUMENT_PAGES = 'documents_pages_check';
export const CHUNK_ORD = 'chunks_ord_check';
export const CHUNK_TEXT = 'chunks_text_check';
export const CHUNK_SPAN = 'chunks_span_check';
export const CHUNK_PAGES = 'chunks_pages_check';
export const CHUNK_TOKENS = 'chunks_tokens_check';
export const CHUNK_HEADING_PATH = 'chunks_heading_path_check';
export const CHUNK_EMBEDDING_MODEL = 'chunks_embedding_model_check';
export const CHUNK_EMBEDDING_NONZERO = 'chunks_embedding_nonzero_check';
export const CONVERSATION_TITLE = 'conversations_title_check';
export const MESSAGE_QUESTION = 'messages_question_check';
export const MESSAGE_ANSWER_MODEL = 'messages_answer_model_check';
export const MESSAGE_ERROR = 'messages_error_check';
export const CITATION_MARKER = 'citations_marker_check';
export const CITATION_QUOTE = 'citations_quote_check';
export const CITATION_PAGE = 'citations_page_check';
export const TRACE_LATENCY = 'retrieval_traces_latency_check';
export const TRACE_CANDIDATES = 'retrieval_traces_candidates_check';

/** The embedding width the `chunks.embedding` column is declared with. */
export const EMBEDDING_DIMENSIONS = 1024;

/** The MIME types `documents_mime_check` allows, in the migration's order. */
export const DOCUMENT_MIME_TYPES: readonly string[] = Object.freeze([
  'application/pdf',
  'text/markdown',
  'text/plain',
]);

/**
 * Hand-written objects that `prisma migrate diff` sees and would DROP, because
 * schema.prisma cannot declare them. `scripts/db-drift.mjs` reads this list
 * from the built package and treats exactly these as intended. CHECKs,
 * generated-column expressions and partial indexes are not here: the diff does
 * not report them (checked against the live database, 2026-11-01).
 */
export const HAND_WRITTEN_DIFF_OBJECTS: readonly string[] = Object.freeze([
  CONVERSATION_COLLECTION_SAME_OWNER,
  CITATION_CHUNK_SAME_OWNER,
  CHUNK_EMBEDDING_INDEX,
  CHUNK_TSV_INDEX,
]);
