import { collectionListSchema, conversationDetailSchema, idSchema } from '@rag/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Chat } from '../../../../components/chat';
import { ConfirmDelete } from '../../../../components/confirm-delete';
import { ApiError, apiFetch } from '../../../../lib/api';
import { turnsFromMessages } from '../../../../lib/chat-state';
import { requireUser } from '../../../../lib/session';
import { deleteConversationAction } from '../../../library-actions';

export const metadata = { title: 'Conversation' };

/**
 * A conversation: its stored history rendered on the server, then the live
 * chat for the next question. A stored answer keeps its citations (quote,
 * page, span), so a ticket in last week's answer still lands on its passage.
 *
 * The title is the first question, which the first slip already prints, so
 * the heading carries it for assistive technology and the eye reads the scope
 * instead (UX-AUDIT #5). Delete sits up here with the scope, away from the
 * composer and its Ask button (UX-AUDIT #4).
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
  // What the slips are stamped with: the shelf the desk searched.
  const stamp = collection === null ? 'Whole library' : collection.name;

  return (
    <main id="main" className="work">
      <header className="work-head work-head-split">
        <div>
          <h1 className="visually-hidden" data-testid="conversation-title">
            {conversation.title}
          </h1>
          <p className="scope">Asking {scope}</p>
          {collection === null ? null : (
            <p className="crumb">
              <Link href={`/collections/${collection.id}`}>Open the collection</Link>
            </p>
          )}
        </div>
        <ConfirmDelete
          action={deleteConversationAction}
          fields={{ conversationId: conversation.id, then: 'library' }}
          label="Delete conversation"
          question={`Delete “${conversation.title}” and all its answers? Your documents stay.`}
          confirmLabel="Yes, delete the conversation"
        />
      </header>
      <Chat
        conversationId={conversation.id}
        turns={turnsFromMessages(conversation.messages)}
        scope={scope}
        stamp={stamp}
      />
    </main>
  );
}
