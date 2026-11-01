import { sessionUserSchema } from '@rag/shared';
import Link from 'next/link';

import { apiFetch } from '../lib/api';
import { requireUser } from '../lib/session';
import { signOutAction } from './(auth)/actions';

export const metadata = { title: 'Library', robots: { index: false } };

/**
 * The library: the signed-in user's own documents and conversations.
 *
 * The name shown is the API's answer from `GET /auth/me`, not the session's
 * copy, so the page proves the service token round trip works. Collections,
 * uploads and chat arrive with their API (build steps 5 to 9).
 */
export default async function LibraryPage() {
  const session = await requireUser('/');
  const me = await apiFetch(session, '/auth/me', sessionUserSchema);

  return (
    <main id="main" className="page">
      <h1>Your library</h1>
      <div className="panel" data-testid="who">
        <p>
          Signed in as <strong>{me.name}</strong> ({me.email}).
        </p>
        <p className="muted" data-testid="empty-library">
          Your library is empty. Only you can see what you add to it.
        </p>
      </div>
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
