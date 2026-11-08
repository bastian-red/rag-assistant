import { collectionListSchema, conversationListSchema, sessionUserSchema } from '@rag/shared';
import Link from 'next/link';

import { ConfirmDelete } from '../components/confirm-delete';
import { CreateCollectionForm } from '../components/create-collection-form';
import { apiFetch } from '../lib/api';
import { dayWords } from '../lib/dates';
import { describeCounts } from '../lib/library';
import { requireUser } from '../lib/session';
import { signOutAction } from './(auth)/actions';
import {
  createCollectionAction,
  deleteConversationAction,
  startConversationAction,
} from './library-actions';

export const metadata = { title: 'Library', robots: { index: false } };

/**
 * The library: the signed-in person's collections and their past
 * conversations. Everything here is their own; the API's owner filter is
 * what makes that true, and the isolation E2E holds it.
 *
 * Functional styling until the design step (PLAN step 10).
 */
export default async function LibraryPage() {
  const session = await requireUser('/');
  const [me, library, history] = await Promise.all([
    apiFetch(session, '/auth/me', sessionUserSchema),
    apiFetch(session, '/collections', collectionListSchema),
    apiFetch(session, '/conversations', conversationListSchema),
  ]);
  const names = new Map(library.collections.map((c) => [c.id, c.name]));
  const ready = library.collections.reduce((sum, c) => sum + c.documents.ready, 0);

  return (
    <main id="main" className="page">
      <h1>Your library</h1>
      <div className="panel" data-testid="who">
        <p>
          Signed in as <strong>{me.name}</strong> ({me.email}).
        </p>
        <p className="muted">Only you can see what is in your library.</p>
      </div>

      <section aria-labelledby="ask-heading" className="panel">
        <h2 id="ask-heading">Ask</h2>
        {ready === 0 ? (
          <p className="muted">
            Nothing is ready to ask about yet. Open a collection and add a file first.
          </p>
        ) : (
          <form action={startConversationAction}>
            <input type="hidden" name="collectionId" value="" />
            <button className="button button-primary" type="submit">
              Ask your whole library
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="collections-heading">
        <h2 id="collections-heading">Collections</h2>
        {library.collections.length === 0 ? (
          <p className="muted" data-testid="empty-library">
            Your library is empty. Create a collection to put your first file in.
          </p>
        ) : (
          <ul className="collections" data-testid="collections">
            {library.collections.map((collection) => {
              const words = describeCounts(collection.documents);
              return (
                <li key={collection.id} className="panel" data-testid="collection">
                  <h3>
                    <Link href={`/collections/${collection.id}`}>{collection.name}</Link>
                  </h3>
                  <p>
                    {words.total}
                    {words.detail === null ? null : <span className="muted">: {words.detail}</span>}
                  </p>
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
              <li key={conversation.id} className="panel" data-testid="conversation">
                <h3>
                  <Link href={`/conversations/${conversation.id}`}>{conversation.title}</Link>
                </h3>
                <p className="muted">
                  {conversation.collectionId === null
                    ? 'Your whole library'
                    : (names.get(conversation.collectionId) ?? 'A deleted collection')}
                  {' · '}
                  <time dateTime={conversation.updatedAt}>{dayWords(conversation.updatedAt)}</time>
                </p>
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

      <form action={signOutAction}>
        <button className="button" type="submit">
          Sign out
        </button>
      </form>
      <p>
        <Link href="/status">Service status</Link>
      </p>
    </main>
  );
}
