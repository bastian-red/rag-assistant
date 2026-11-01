/**
 * A collection's document counts, said in words.
 *
 * Absence is said, not drawn ("No documents yet"), and a count names what it
 * counts. Zero parts are left out, so "3 documents: 2 ready to ask about,
 * 1 still being read" never grows a "0 failed" that reads like a warning.
 */
import type { DocumentCounts } from '@rag/shared';

export interface CountWords {
  /** "No documents yet", "1 document", "3 documents". */
  readonly total: string;
  /** The non-zero states, or null when there is nothing to break down. */
  readonly detail: string | null;
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export function describeCounts(counts: DocumentCounts): CountWords {
  if (counts.total === 0) return { total: 'No documents yet', detail: null };
  const parts = [
    counts.ready > 0 ? `${String(counts.ready)} ready to ask about` : null,
    counts.inProgress > 0 ? `${String(counts.inProgress)} still being read` : null,
    counts.failed > 0 ? `${String(counts.failed)} could not be read` : null,
  ].filter((part): part is string => part !== null);
  return { total: plural(counts.total, 'document', 'documents'), detail: parts.join(', ') };
}
