import { collectionListSchema, conversationListSchema } from '@rag/shared';
import Link from 'next/link';

import { ConfirmDelete } from '../../components/confirm-delete';
import { CreateCollectionForm } from '../../components/create-collection-form';
import { apiFetch } from '../../lib/api';
import { dayWords } from '../../lib/dates';
import { describeCounts } from '../../lib/library';
import { requireUser } from '../../lib/session';
import {
  createCollectionAction,
  deleteConversationAction,
  startConversationAction,
} from '../library-actions';

export const metadata = { title: 'Library' };

/**
 * The library: what a returning reader comes for, in that order. Ask (the
 * whole library, or one collection from its card), then the collections,
 * then every past conversation (UX-AUDIT #8: these had no more weight than
 * the sign-out button). Everything here is the reader's own; the API's owner
 * filter is what makes that true, and the isolation E2E holds it.
 */
export default async function LibraryPage() {
  const session = await requireUser('/');
  const [library, history] = await Promise.all([
    apiFetch(session, '/collections', collectionListSchema),
    apiFetch(session, '/conversations', conversationListSchema),
  ]);
  const names = new Map(library.collections.map((c) => [c.id, c.name]));
  const ready = library.collections.reduce((sum, c) => sum + c.documents.ready, 0);

  return (
    <main id="main" className="work">
      <header className="work-head">
        <h1>Your library</h1>
        <p className="muted">Only you can see what is in it.</p>
      </header>

      <section aria-labelledby="ask-heading" className="desk">
        <h2 id="ask-heading">Ask</h2>
        {ready === 0 ? (
          <p className="muted">
            Nothing is ready to ask about yet. Open a collection and add a file first.
          </p>
        ) : (
          <>
            <p>Every answer names the passages it came from, numbered, before it says a word.</p>
            <form action={startConversationAction}>
              <input type="hidden" name="collectionId" value="" />
              <button className="button button-primary" type="submit">
                Ask your whole library
              </button>
            </form>
          </>
        )}
      </section>

      <section aria-labelledby="collections-heading">
        <h2 id="collections-heading">Collections</h2>
        {library.collections.length === 0 ? (
          <p className="muted" data-testid="empty-library">
            Your library is empty. Create a collection to put your first file in.
          </p>
        ) : (
          <ul className="drawers" data-testid="collections">
            {library.collections.map((collection) => {
              const words = describeCounts(collection.documents);
              return (
                <li key={collection.id} className="drawer" data-testid="collection">
                  <h3>
                    <Link href={`/collections/${collection.id}`}>{collection.name}</Link>
                  </h3>
                  <p>
                    {words.total}
                    {words.detail === null ? null : <span className="muted">: {words.detail}</span>}
                  </p>
                  {collection.documents.ready === 0 ? null : (
                    <form action={startConversationAction}>
                      <input type="hidden" name="collectionId" value={collection.id} />
                      <button className="button" type="submit">
                        Ask<span className="visually-hidden"> {collection.name}</span>
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <CreateCollectionForm action={createCollectionAction} />
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Conversations</h2>
        {history.conversations.length === 0 ? (
          <p className="muted" data-testid="no-conversations">
            No conversations yet. Your questions and their answers are kept here.
          </p>
        ) : (
          <ul className="history" data-testid="history">
            {history.conversations.map((conversation) => (
              <li key={conversation.id} className="history-row" data-testid="conversation">
                <div className="history-text">
                  <h3>
                    <Link href={`/conversations/${conversation.id}`}>{conversation.title}</Link>
                  </h3>
                  <p className="muted">
                    {conversation.collectionId === null
                      ? 'Your whole library'
                      : (names.get(conversation.collectionId) ?? 'A deleted collection')}
                    {' · '}
                    <time className="num" dateTime={conversation.updatedAt}>
                      {dayWords(conversation.updatedAt)}
                    </time>
                  </p>
                </div>
                <ConfirmDelete
                  action={deleteConversationAction}
                  fields={{ conversationId: conversation.id }}
                  label="Delete"
                  accessibleLabel={`Delete the conversation “${conversation.title}”`}
                  question={`Delete the conversation “${conversation.title}” and all its answers? Your documents stay.`}
                  confirmLabel="Yes, delete the conversation"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
