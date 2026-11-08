'use server';

/**
 * The library's writes. Each re-checks the session (an action is a public
 * POST endpoint, whatever page rendered its form) and calls the API with the
 * signed-in person's token, which is where ownership is enforced.
 */
import {
  collectionSummarySchema,
  conversationSummarySchema,
  createCollectionSchema,
  idSchema,
  z,
} from '@rag/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ApiError, apiFetch } from '../lib/api';
import { requireUser } from '../lib/session';

export interface FormState {
  readonly error: string | null;
}

const noBody = z.null();

function idFrom(form: FormData, field: string): string {
  const parsed = idSchema.safeParse(form.get(field));
  if (!parsed.success) throw new Error(`${field} is not an id`);
  return parsed.data;
}

export async function createCollectionAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const user = await requireUser('/');
  const parsed = createCollectionSchema.safeParse({ name: form.get('collectionName') });
  if (!parsed.success) return { error: 'Give the collection a name of 1 to 80 characters.' };
  let id: string;
  try {
    id = (
      await apiFetch(user, '/collections', collectionSummarySchema, {
        method: 'POST',
        body: parsed.data,
      })
    ).id;
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) return { error: error.message };
    throw error;
  }
  // The layout too: the sidebar lists collections.
  revalidatePath('/', 'layout');
  redirect(`/collections/${id}`);
}

export async function deleteCollectionAction(form: FormData): Promise<void> {
  const id = idFrom(form, 'collectionId');
  const user = await requireUser(`/collections/${id}`);
  await apiFetch(user, `/collections/${id}`, noBody, { method: 'DELETE' });
  revalidatePath('/', 'layout');
  redirect('/');
}

export async function deleteDocumentAction(form: FormData): Promise<void> {
  const id = idFrom(form, 'documentId');
  const collectionId = idFrom(form, 'collectionId');
  const user = await requireUser(`/collections/${collectionId}`);
  await apiFetch(user, `/documents/${id}`, noBody, { method: 'DELETE' });
  // The layout too: the sidebar counts each collection's ready documents.
  revalidatePath('/', 'layout');
}

/** Start a conversation over one collection, or the whole library, and open it. */
export async function startConversationAction(form: FormData): Promise<void> {
  const raw = form.get('collectionId');
  const collectionId = raw === null || raw === '' ? null : idFrom(form, 'collectionId');
  const user = await requireUser('/');
  const conversation = await apiFetch(user, '/conversations', conversationSummarySchema, {
    method: 'POST',
    body: { collectionId },
  });
  revalidatePath('/', 'layout');
  redirect(`/conversations/${conversation.id}`);
}

export async function deleteConversationAction(form: FormData): Promise<void> {
  const id = idFrom(form, 'conversationId');
  const user = await requireUser('/');
  await apiFetch(user, `/conversations/${id}`, noBody, { method: 'DELETE' });
  revalidatePath('/', 'layout');
  if (form.get('then') === 'library') redirect('/');
}
