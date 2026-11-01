import { collectionListSchema, sessionUserSchema } from '@rag/shared';
import Link from 'next/link';

import { apiFetch } from '../lib/api';
import { describeCounts } from '../lib/library';
import { requireUser } from '../lib/session';
import { signOutAction } from './(auth)/actions';

export const metadata = { title: 'Library', robots: { index: false } };

/**
 * The library: the signed-in user's own documents and conversations.
 *
 * The name shown is the API's answer from `GET /auth/me`, not the session's
 * copy, so the page proves the service token round trip works. The
 * collections come from `GET /collections`, which only ever returns the
 * signed-in person's own. Uploads and chat arrive with their API (build steps
 * 5 to 9); this page is restyled in the design step.
 */
export default async function LibraryPage() {
  const session = await requireUser('/');
  const [me, library] = await Promise.all([
    apiFetch(session, '/auth/me', sessionUserSchema),
    apiFetch(session, '/collections', collectionListSchema),
  ]);

  return (
    <main id="main" className="page">
      <h1>Your library</h1>
      <div className="panel" data-testid="who">
        <p>
          Signed in as <strong>{me.name}</strong> ({me.email}).
        </p>
        <p className="muted">Only you can see what is in your library.</p>
      </div>
      {library.collections.length === 0 ? (
        <p className="muted" data-testid="empty-library">
          Your library is empty.
        </p>
      ) : (
        <section aria-labelledby="collections-heading">
          <h2 id="collections-heading">Collections</h2>
          <ul className="collections" data-testid="collections">
            {library.collections.map((collection) => {
              const words = describeCounts(collection.documents);
              return (
                <li key={collection.id} className="panel" data-testid="collection">
                  <h3>{collection.name}</h3>
                  <p>
                    {words.total}
                    {words.detail === null ? null : <span className="muted">: {words.detail}</span>}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      )}
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
