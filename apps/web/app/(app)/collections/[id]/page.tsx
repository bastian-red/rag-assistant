import { collectionListSchema, documentListSchema, idSchema } from '@rag/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CollectionDocuments } from '../../../../components/collection-documents';
import { ConfirmDelete } from '../../../../components/confirm-delete';
import { apiFetch, query } from '../../../../lib/api';
import { describeCounts } from '../../../../lib/library';
import { requireUser } from '../../../../lib/session';
import { deleteCollectionAction, startConversationAction } from '../../../library-actions';

export const metadata = { title: 'Collection', robots: { index: false } };

/**
 * One collection: its documents with live status, the upload, and "ask this
 * collection". A collection that is not the reader's is a 404, the same as
 * one that does not exist: the API's owner filter cannot tell them apart,
 * and neither does this page.
 */
export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/collections/${id}`);
  if (!idSchema.safeParse(id).success) notFound();
  const [library, list] = await Promise.all([
    apiFetch(user, '/collections', collectionListSchema),
    apiFetch(user, `/documents${query({ collectionId: id })}`, documentListSchema),
  ]);
  const collection = library.collections.find((c) => c.id === id);
  if (collection === undefined) notFound();
  const words = describeCounts(collection.documents);
  const names = Object.fromEntries(library.collections.map((c) => [c.id, c.name]));

  return (
    <main id="main" className="work">
      <header className="work-head">
        <p className="crumb">
          <Link href="/">Your library</Link>
          <span aria-hidden="true"> / </span>
        </p>
        <h1>{collection.name}</h1>
        <p className="muted" data-testid="collection-counts">
          {words.total}
          {words.detail === null ? null : `: ${words.detail}`}
        </p>
      </header>
      <div className="actions work-actions">
        {collection.documents.ready === 0 ? null : (
          <form action={startConversationAction}>
            <input type="hidden" name="collectionId" value={collection.id} />
            <button className="button button-primary" type="submit">
              Ask this collection
            </button>
          </form>
        )}
        <ConfirmDelete
          action={deleteCollectionAction}
          fields={{ collectionId: collection.id }}
          label="Delete collection"
          question={
            collection.documents.total === 0
              ? `Delete “${collection.name}”? It holds no documents.`
              : `Delete “${collection.name}” and its ${
                  collection.documents.total === 1
                    ? '1 document'
                    : `${String(collection.documents.total)} documents`
                }? Conversations over it are kept.`
          }
          confirmLabel="Yes, delete the collection"
        />
      </div>
      <CollectionDocuments
        collectionId={collection.id}
        documents={list.documents}
        collectionNames={names}
      />
    </main>
  );
}
