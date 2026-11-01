/**
 * The library, as the API answers it and the web app reads it.
 *
 * Counts are by state, in the reader's terms: how many documents a collection
 * holds, how many can be asked about (READY), how many are still being read
 * (QUEUED, PARSING, EMBEDDING) and how many failed. The four always add up,
 * which the schema checks, so a page never prints a total its parts disagree
 * with.
 */
import { z } from 'zod';

/** Ingestion states, in the order a document moves through them. */
export const DOCUMENT_STATUSES = ['QUEUED', 'PARSING', 'EMBEDDING', 'READY', 'FAILED'] as const;
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

/** The states counted as "still being read". */
export const IN_PROGRESS_STATUSES: readonly DocumentStatus[] = ['QUEUED', 'PARSING', 'EMBEDDING'];

const count = z.number().int().min(0);

export const documentCountsSchema = z
  .object({ total: count, ready: count, inProgress: count, failed: count })
  .refine((c) => c.ready + c.inProgress + c.failed === c.total, {
    message: 'ready + inProgress + failed must equal total',
  });
export type DocumentCounts = z.infer<typeof documentCountsSchema>;

export const collectionSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  documents: documentCountsSchema,
});
export type CollectionSummary = z.infer<typeof collectionSummarySchema>;

/** `GET /collections`: the signed-in person's collections, by name. */
export const collectionListSchema = z.object({ collections: z.array(collectionSummarySchema) });
export type CollectionList = z.infer<typeof collectionListSchema>;

/** Fold per-status counts (absent statuses are zero) into the four the reader sees. */
export function countDocuments(byStatus: Partial<Record<DocumentStatus, number>>): DocumentCounts {
  const of = (status: DocumentStatus) => byStatus[status] ?? 0;
  const inProgress = IN_PROGRESS_STATUSES.reduce((sum, status) => sum + of(status), 0);
  const ready = of('READY');
  const failed = of('FAILED');
  return { total: ready + inProgress + failed, ready, inProgress, failed };
}
