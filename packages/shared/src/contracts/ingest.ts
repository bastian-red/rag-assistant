/**
 * Documents and their ingestion: what the API answers, what it puts on the
 * queue, and what the worker announces as a document moves.
 *
 * QUEUED -> PARSING -> EMBEDDING -> READY, or FAILED with a reason a reader
 * can act on. The worker owns every move after QUEUED; the API only creates
 * the row and the job.
 */
import { z } from 'zod';

import { ACCEPTED_TYPES, LIMITS } from '../constants';
import { documentStatusSchema } from './library';
import { idSchema, instantSchema } from './primitives';

/** The BullMQ queue both sides name. */
export const INGEST_QUEUE = 'ingest';

/**
 * One job per document, `jobId = documentId`, so a second `add` for the same
 * document while one is waiting is a no-op rather than a second ingestion.
 */
export const ingestJobSchema = z
  .object({
    documentId: idSchema,
    ownerId: idSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export type IngestJob = z.infer<typeof ingestJobSchema>;

/**
 * The sentences a FAILED document carries, word for word. The worker writes
 * them, the UI prints them and the tests match them, so they live in one place.
 */
export const INGEST_FAILURES = Object.freeze({
  noTextLayer: 'no text layer; OCR not supported',
  unreadablePdf: 'the PDF could not be read (damaged or password-protected)',
  notUtf8: 'the file is not UTF-8 text',
  empty: 'the file has no text to read',
  fileMissing: 'the uploaded file is missing from storage; upload it again',
  fileChanged: 'the stored file does not match what was uploaded; upload it again',
  tooLong: 'a passage is longer than the embedding model can read',
  modelUnavailable: 'the embedding model could not be reached; it was tried several times',
  gaveUp: 'ingestion kept failing; it was tried several times. Upload it again',
} as const);

/**
 * How far a document has got. `done`/`total` count embedded chunks during
 * EMBEDDING and are null otherwise.
 */
export const ingestEventSchema = z
  .object({
    documentId: idSchema,
    collectionId: idSchema,
    status: documentStatusSchema,
    progress: z
      .object({ done: z.number().int().nonnegative(), total: z.number().int().positive() })
      .refine((p) => p.done <= p.total, { message: 'done must not exceed total' })
      .nullable(),
    error: z.string().nullable(),
    at: instantSchema,
  })
  .strict();
export type IngestEvent = z.infer<typeof ingestEventSchema>;

/**
 * The Redis pub/sub channel for one person's events. Per owner, so the API's
 * event stream subscribes to the signed-in person's channel and cannot hear
 * anyone else's documents move, whatever it does with the messages.
 */
export function ingestChannel(ownerId: string): string {
  return `ingest:events:${idSchema.parse(ownerId)}`;
}

export const acceptedTypeSchema = z.enum(ACCEPTED_TYPES);
export type AcceptedType = z.infer<typeof acceptedTypeSchema>;

/** A document as the API answers it. */
export const documentSchema = z
  .object({
    id: idSchema,
    collectionId: idSchema,
    title: z.string().min(1),
    filename: z.string().min(1),
    mime: acceptedTypeSchema,
    bytes: z.number().int().positive(),
    status: documentStatusSchema,
    error: z.string().nullable(),
    pages: z.number().int().positive().nullable(),
    chunks: z.number().int().nonnegative(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type DocumentView = z.infer<typeof documentSchema>;

export const documentListSchema = z.object({ documents: z.array(documentSchema) });
export type DocumentList = z.infer<typeof documentListSchema>;

/**
 * `POST /documents`. `duplicate` is true when the same bytes were already in
 * this person's library: the answer is the existing document (200), not a
 * second copy (202).
 */
export const uploadResultSchema = z
  .object({ document: documentSchema, duplicate: z.boolean() })
  .strict();
export type UploadResult = z.infer<typeof uploadResultSchema>;

/** `GET /documents/:id/chunks/:chunkId`: one passage, where it sits, for the viewer. */
export const chunkViewSchema = z
  .object({
    id: idSchema,
    documentId: idSchema,
    ord: z.number().int().nonnegative(),
    text: z.string().min(1),
    charStart: z.number().int().nonnegative(),
    charEnd: z.number().int().positive(),
    pageStart: z.number().int().positive().nullable(),
    pageEnd: z.number().int().positive().nullable(),
    pageStarts: z.array(
      z.object({ page: z.number().int().positive(), at: z.number().int().positive() }),
    ),
    headingPath: z.array(z.string()),
  })
  .strict();
export type ChunkView = z.infer<typeof chunkViewSchema>;

export const createCollectionSchema = z
  .object({ name: z.string().trim().min(1).max(LIMITS.collectionName) })
  .strict();
export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;

/**
 * How the API adds a job, and how the worker re-adds one it finds missing.
 * Plain data so this package needs no BullMQ: five attempts, 5 s doubling
 * (5, 10, 20, 40 s), which outlasts a model server restarting. A finished job
 * is removed so the same document can be queued again under the same id.
 */
export const INGEST_JOB_OPTIONS = Object.freeze({
  attempts: 5,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 5_000 }),
  removeOnComplete: true,
  removeOnFail: true,
});

/**
 * A fresh, mutable copy for one document (a queue library may write to the
 * options it is given), with `jobId = documentId`.
 */
export interface IngestJobOptions {
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
  removeOnComplete: boolean;
  removeOnFail: boolean;
  jobId: string;
}

export function ingestJobOptions(documentId: string): IngestJobOptions {
  return {
    ...INGEST_JOB_OPTIONS,
    backoff: { ...INGEST_JOB_OPTIONS.backoff },
    jobId: idSchema.parse(documentId),
  };
}

const FILENAME_MAX = 255;
const sliceCodePoints = (s: string, max: number) => [...s].slice(0, max).join('');
// C0 and C1 controls, DEL included: never part of a name a person typed.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

/**
 * The name a file is stored under: the last path segment of what the browser
 * sent (some send a full path), with control characters dropped, at most 255
 * characters. Held by `documents_filename_check`.
 */
export function safeFilename(original: string): string {
  const last = original.split(/[/\\]/u).pop()!.replace(CONTROL_CHARACTERS, '');
  const trimmed = sliceCodePoints(last.trim(), FILENAME_MAX).trim();
  return trimmed === '' ? 'upload' : trimmed;
}

/**
 * A document's title: the first non-blank line of a text or markdown file
 * (without a heading's `#`), else the file name without its extension. One
 * line, at most `LIMITS.documentTitle` characters, no outer whitespace, which
 * is what `documents_title_check` holds.
 */
export function documentTitle(filename: string, text: string | null): string {
  const clean = (s: string) =>
    sliceCodePoints(s.replace(/\s+/gu, ' ').trim(), LIMITS.documentTitle).trim();
  const line = (text ?? '')
    .replace(/^\uFEFF/u, '')
    .split('\n')
    .map((l) => clean(l.replace(/^\s*#{1,6}\s+/u, '')))
    .find((l) => l !== '');
  if (line !== undefined) return line;
  const name = safeFilename(filename);
  const dot = name.lastIndexOf('.');
  return clean(dot > 0 ? name.slice(0, dot) : name) || clean(name);
}
