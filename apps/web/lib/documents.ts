/**
 * A document's state in words, with a glyph beside it (colour is never the
 * only channel), and the live-update merge for the collection page.
 */
import type { DocumentStatus, DocumentView, IngestEvent, UploadResult } from '@rag/shared';

export interface StatusWords {
  /** Shown before the word; decoration, hidden from screen readers. */
  readonly glyph: string;
  readonly word: string;
  /** The finer detail: progress or the reason it failed. */
  readonly detail: string | null;
  readonly tone: 'progress' | 'ok' | 'danger';
}

const WORDS: Record<DocumentStatus, Omit<StatusWords, 'detail'>> = {
  QUEUED: { glyph: '◌', word: 'Waiting to be read', tone: 'progress' },
  PARSING: { glyph: '◔', word: 'Reading the text', tone: 'progress' },
  EMBEDDING: { glyph: '◑', word: 'Indexing passages', tone: 'progress' },
  READY: { glyph: '✓', word: 'Ready to ask about', tone: 'ok' },
  FAILED: { glyph: '⚠', word: 'Could not be read', tone: 'danger' },
};

export function statusWords(
  status: DocumentStatus,
  progress: IngestEvent['progress'] = null,
  error: string | null = null,
): StatusWords {
  const base = WORDS[status];
  if (status === 'FAILED') return { ...base, detail: error };
  if (status === 'EMBEDDING' && progress !== null) {
    return {
      ...base,
      detail: `${String(progress.done)} of ${String(progress.total)} ${progress.total === 1 ? 'passage' : 'passages'}`,
    };
  }
  return { ...base, detail: null };
}

/** A document as the collection page holds it: the API's view plus the live progress. */
export interface LiveDocument extends DocumentView {
  readonly progress: IngestEvent['progress'];
}

export const live = (document: DocumentView): LiveDocument => ({ ...document, progress: null });

/**
 * One ingest event applied to the list. Events for documents of another
 * collection are ignored; an event for a document the list does not hold
 * yet (uploaded in another tab) reports `unknown`, so the page re-reads the
 * list instead of inventing a row. An event older than the row is ignored:
 * pub/sub does not promise order across reconnects.
 */
export function applyIngest(
  documents: readonly LiveDocument[],
  event: IngestEvent,
  collectionId: string,
): { documents: readonly LiveDocument[]; unknown: boolean; settled: LiveDocument | null } {
  if (event.collectionId !== collectionId) return { documents, unknown: false, settled: null };
  const index = documents.findIndex((d) => d.id === event.documentId);
  if (index === -1) return { documents, unknown: true, settled: null };
  const current = documents[index]!;
  if (Date.parse(event.at) < Date.parse(current.updatedAt)) {
    return { documents, unknown: false, settled: null };
  }
  const next: LiveDocument = {
    ...current,
    status: event.status,
    error: event.error,
    progress: event.status === 'EMBEDDING' ? event.progress : null,
    updatedAt: event.at,
  };
  const settled =
    current.status !== event.status && (event.status === 'READY' || event.status === 'FAILED')
      ? next
      : null;
  return { documents: documents.map((d, i) => (i === index ? next : d)), unknown: false, settled };
}

/** An upload's answer added to the list: new rows first, a duplicate never twice. */
export function addUploaded(
  documents: readonly LiveDocument[],
  result: UploadResult,
  collectionId: string,
): readonly LiveDocument[] {
  if (result.document.collectionId !== collectionId) return documents;
  if (documents.some((d) => d.id === result.document.id)) return documents;
  return [live(result.document), ...documents];
}

/** What one file's upload came to, said to the person who dropped it. */
export function uploadOutcome(
  filename: string,
  outcome:
    | { readonly ok: true; readonly result: UploadResult; readonly collectionName: string | null }
    | { readonly ok: false; readonly message: string },
): { readonly tone: 'ok' | 'danger'; readonly text: string } {
  if (!outcome.ok) return { tone: 'danger', text: `${filename}: ${outcome.message}` };
  if (!outcome.result.duplicate) return { tone: 'ok', text: `${filename}: added, reading it now.` };
  const where = outcome.collectionName === null ? '' : ` in “${outcome.collectionName}”`;
  return {
    tone: 'ok',
    text: `${filename}: already in your library${where} as “${outcome.result.document.title}”.`,
  };
}

/** "2.4 MB", "830 KB", "512 bytes": binary units, one decimal under ten. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/u, '') : String(Math.round(value));
  return `${shown} ${units[unit]!}`;
}
