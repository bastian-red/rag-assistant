'use client';

import type { DocumentView, IngestEvent, UploadResult } from '@rag/shared';
import { LIMITS } from '@rag/shared/constants';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';

import { deleteDocumentAction } from '../app/library-actions';
import {
  addUploaded,
  applyIngest,
  live,
  sizeWords,
  statusWords,
  uploadOutcome,
  type LiveDocument,
} from '../lib/documents';
import { originalHref } from '../lib/passage';
import { ConfirmDelete } from './confirm-delete';

interface Props {
  readonly collectionId: string;
  readonly documents: readonly DocumentView[];
  /** Every collection's name, to say where a duplicate already lives. */
  readonly collectionNames: Readonly<Record<string, string>>;
}

interface Outcome {
  readonly key: string;
  readonly tone: 'ok' | 'danger';
  readonly text: string;
}

const ACCEPT = '.pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain';
const MAX_MB = LIMITS.uploadBytes / 1024 / 1024;

/**
 * A collection's documents: drop files in, watch each one read, see why one
 * failed (PRODUCT.md moment 1).
 *
 * Status is live over the ingest feed (`/api/documents/events`, SSE through
 * this app). EventSource reconnects by itself; after a reconnect the feed
 * says `subscribed` again and the list is re-read, because events sent while
 * it was away are gone. A settled document is announced politely, so a
 * screen-reader user hears "ready" without watching the list.
 */
export function CollectionDocuments({ collectionId, documents: initial, collectionNames }: Props) {
  const router = useRouter();
  const [documents, setDocuments] = useState<readonly LiveDocument[]>(() => initial.map(live));
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();

  // A server re-render (after a delete, or a re-read) is the new truth.
  useEffect(() => {
    setDocuments(initial.map(live));
  }, [initial]);

  useEffect(() => {
    const source = new EventSource('/api/documents/events');
    let subscribedOnce = false;
    source.addEventListener('subscribed', () => {
      if (subscribedOnce) router.refresh();
      subscribedOnce = true;
    });
    source.addEventListener('ingest', (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as IngestEvent;
      setDocuments((current) => {
        const next = applyIngest(current, event, collectionId);
        if (next.unknown) queueMicrotask(() => router.refresh());
        if (next.settled !== null) {
          const words = statusWords(next.settled.status, null, next.settled.error);
          const said = `“${next.settled.title}”: ${words.word}${words.detail === null ? '' : `, ${words.detail}`}.`;
          queueMicrotask(() => {
            setAnnouncement(said);
            // The counts and "Ask this collection" are the server's to redraw.
            router.refresh();
          });
        }
        return next.documents;
      });
    });
    return () => source.close();
  }, [collectionId, router]);

  async function upload(files: readonly File[]) {
    const results: Outcome[] = [];
    for (const [index, file] of files.entries()) {
      const key = `${String(Date.now())}-${String(index)}`;
      if (file.size > LIMITS.uploadBytes) {
        results.push({
          key,
          ...uploadOutcome(file.name, {
            ok: false,
            message: `It is ${sizeWords(file.size)}; the limit is ${String(MAX_MB)} MB.`,
          }),
        });
        continue;
      }
      setUploading(file.name);
      const form = new FormData();
      form.append('collectionId', collectionId);
      form.append('file', file);
      try {
        const response = await fetch('/api/documents', { method: 'POST', body: form });
        const body = (await response.json().catch(() => null)) as
          (UploadResult & { message?: undefined }) | { message?: string } | null;
        if (response.ok && body !== null && 'document' in body) {
          const result = body as UploadResult;
          setDocuments((current) => addUploaded(current, result, collectionId));
          results.push({
            key,
            ...uploadOutcome(file.name, {
              ok: true,
              result,
              collectionName:
                result.document.collectionId === collectionId
                  ? null
                  : (collectionNames[result.document.collectionId] ?? null),
            }),
          });
        } else {
          const message =
            response.status === 429
              ? 'Too many uploads in a minute. Wait a moment and try again.'
              : (body?.message ?? `The upload failed (${String(response.status)}).`);
          results.push({ key, ...uploadOutcome(file.name, { ok: false, message }) });
        }
      } catch {
        results.push({
          key,
          ...uploadOutcome(file.name, { ok: false, message: 'The connection dropped. Try again.' }),
        });
      }
    }
    setUploading(null);
    setOutcomes(results);
    if (inputRef.current !== null) inputRef.current.value = '';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (uploading === null) void upload([...event.dataTransfer.files]);
  }

  return (
    <>
      <section aria-labelledby="add-heading">
        <h2 id="add-heading">Add documents</h2>
        <div
          className="dropzone"
          data-dragging={dragging}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {/* The drop is said in words, not left to a dashed edge (UX-AUDIT #9). */}
          <p className="dropzone-say" aria-hidden="true">
            Drop files here
          </p>
          <label className="button dropzone-pick" data-disabled={uploading !== null}>
            Choose files<span className="visually-hidden">, or drop them here</span>
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              name="files"
              multiple
              accept={ACCEPT}
              aria-describedby={hintId}
              disabled={uploading !== null}
              onChange={(event) => void upload([...(event.currentTarget.files ?? [])])}
            />
          </label>
          <p id={hintId} className="muted">
            PDF, markdown or plain text, up to {MAX_MB} MB each. A scanned PDF without a text layer
            cannot be read.
          </p>
        </div>
        <div role="status" aria-live="polite" className="upload-results">
          {uploading === null ? null : <p>Uploading {uploading}…</p>}
          {outcomes.length === 0 ? null : (
            <ul data-testid="upload-results">
              {outcomes.map((outcome) => (
                <li key={outcome.key} className="status-word" data-state={outcome.tone}>
                  <span aria-hidden="true">{outcome.tone === 'ok' ? '✓ ' : '⚠ '}</span>
                  {outcome.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-labelledby="documents-heading">
        <h2 id="documents-heading">Documents</h2>
        {documents.length === 0 ? (
          <p className="muted" data-testid="no-documents">
            No documents yet. Add a file above and it will be ready to ask about in a minute or two.
          </p>
        ) : (
          <ul className="documents" data-testid="documents">
            {documents.map((document) => {
              const words = statusWords(document.status, document.progress, document.error);
              const facts = [
                document.filename,
                sizeWords(document.bytes),
                document.pages === null ? null : `${String(document.pages)} pages`,
                document.status === 'READY' ? `${String(document.chunks)} passages` : null,
              ].filter((fact): fact is string => fact !== null);
              return (
                <li key={document.id} className="document" data-testid="document">
                  <h3>{document.title}</h3>
                  <p className="muted">
                    <span translate="no">{facts[0]}</span>
                    {facts.length > 1 ? ` · ${facts.slice(1).join(' · ')}` : null}
                  </p>
                  <p className="status-word" data-state={words.tone} data-testid="document-status">
                    <span aria-hidden="true">{words.glyph} </span>
                    {words.word}
                    {words.detail === null ? null : `: ${words.detail}`}
                  </p>
                  <div className="actions">
                    <a href={originalHref(document.id, null)} target="_blank" rel="noopener">
                      Open the original<span className="visually-hidden"> of {document.title}</span>
                    </a>
                    <ConfirmDelete
                      action={deleteDocumentAction}
                      fields={{ documentId: document.id, collectionId }}
                      label="Delete"
                      accessibleLabel={`Delete ${document.title}`}
                      question={`Delete “${document.title}”? Answers that cited it keep their quotes, but the links to it stop working.`}
                      confirmLabel="Yes, delete it"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
