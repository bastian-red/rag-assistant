import { collectionListSchema, conversationListSchema } from '@rag/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { auth } from '../../auth';
import { SideNav } from '../../components/side-nav';
import { apiFetch } from '../../lib/api';
import { signOutAction } from '../(auth)/actions';

/** How many recent conversations the sidebar lists; the library lists them all. */
const RECENT = 8;

/**
 * The signed-in shell: a top bar (the product, who is signed in, sign out)
 * and the sidebar (the library, collections, recent conversations) around every
 * private page. Standard app chrome on purpose: operate mode (docs/DESIGN.md).
 *
 * Without a session it renders the page alone, because each page decides
 * where sign-in should come back to (`requireUser(next)`), which a layout
 * cannot know. Every action that changes these lists revalidates the layout.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) return children;
  const user = session.user;
  const [library, history] = await Promise.all([
    apiFetch(user, '/collections', collectionListSchema),
    apiFetch(user, '/conversations', conversationListSchema),
  ]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand" translate="no">
          rag-assistant
        </Link>
        <div className="who" data-testid="who">
          <span className="who-name">{user.name}</span>
          <span className="who-email muted">{user.email}</span>
          <form action={signOutAction}>
            <button className="button button-quiet" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <SideNav
        collections={library.collections.map((c) => ({
          id: c.id,
          name: c.name,
          ready: c.documents.ready,
        }))}
        conversations={history.conversations
          .slice(0, RECENT)
          .map((c) => ({ id: c.id, title: c.title }))}
      />
      {children}
    </div>
  );
}
