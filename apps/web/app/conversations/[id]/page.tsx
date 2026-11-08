import { collectionListSchema, conversationDetailSchema, idSchema } from '@rag/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Chat } from '../../../components/chat';
import { ConfirmDelete } from '../../../components/confirm-delete';
import { ApiError, apiFetch } from '../../../lib/api';
import { turnsFromMessages } from '../../../lib/chat-state';
import { requireUser } from '../../../lib/session';
import { deleteConversationAction } from '../../library-actions';

export const metadata = { title: 'Conversation', robots: { index: false } };

/**
 * A conversation: its stored history rendered on the server, then the live
 * chat for the next question. A stored answer keeps its citations (quote,
 * page, span), so a chip in last week's answer still lands on its passage.
 */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/conversations/${id}`);
  if (!idSchema.safeParse(id).success) notFound();
  let conversation;
  try {
    conversation = await apiFetch(user, `/conversations/${id}`, conversationDetailSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const library = await apiFetch(user, '/collections', collectionListSchema);
  const collection =
    conversation.collectionId === null
      ? null
      : (library.collections.find((c) => c.id === conversation.collectionId) ?? null);
  const scope = collection === null ? 'your whole library' : `“${collection.name}”`;

  return (
    <main id="main" className="page">
      <p>
        <Link href="/">← Your library</Link>
      </p>
      <h1 data-testid="conversation-title">{conversation.title}</h1>
      <p className="muted">
        Asking {scope}
        {collection === null ? null : (
          <>
            {' · '}
            <Link href={`/collections/${collection.id}`}>Open the collection</Link>
          </>
        )}
      </p>
      <Chat
        conversationId={conversation.id}
        turns={turnsFromMessages(conversation.messages)}
        scope={scope}
      />
      <ConfirmDelete
        action={deleteConversationAction}
        fields={{ conversationId: conversation.id, then: 'library' }}
        label="Delete conversation"
        question={`Delete “${conversation.title}” and all its answers? Your documents stay.`}
        confirmLabel="Yes, delete the conversation"
      />
    </main>
  );
}
