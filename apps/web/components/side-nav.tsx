'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

export interface NavCollection {
  readonly id: string;
  readonly name: string;
  readonly ready: number;
}

export interface NavConversation {
  readonly id: string;
  readonly title: string;
}

interface Props {
  readonly collections: readonly NavCollection[];
  readonly conversations: readonly NavConversation[];
}

/**
 * The shell's sidebar: the library, its collections, the recent
 * conversations, the current one marked with `aria-current` (and a mark, not
 * only a colour). Standard navigation: operate mode lends it type and ink only.
 *
 * Below 60rem it folds under the top bar behind a disclosure button, closed
 * by default and closed again on every navigation, so a phone opens straight
 * onto the page it asked for.
 */
export function SideNav({ collections, conversations }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const listId = useId();

  useEffect(() => setOpen(false), [pathname]);

  const current = (href: string) => (pathname === href ? 'page' : undefined);

  return (
    <nav className="sidenav" aria-label="Library and conversations" data-open={open}>
      <button
        className="button sidenav-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? '▴ ' : '▾ '}</span>
        Library and conversations
      </button>
      <div className="sidenav-body" id={listId}>
        <p className="sidenav-home">
          <Link href="/" aria-current={current('/')}>
            Your library
          </Link>
        </p>
        <h2 className="sidenav-heading">Collections</h2>
        {collections.length === 0 ? (
          <p className="muted sidenav-empty">None yet.</p>
        ) : (
          <ul className="sidenav-list">
            {collections.map((collection) => {
              const href = `/collections/${collection.id}`;
              return (
                <li key={collection.id}>
                  <Link href={href} aria-current={current(href)} data-testid="nav-collection">
                    <span className="sidenav-name">{collection.name}</span>
                    <span className="sidenav-count num">
                      {collection.ready}
                      <span className="visually-hidden"> ready</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <h2 className="sidenav-heading">Conversations</h2>
        {conversations.length === 0 ? (
          <p className="muted sidenav-empty">None yet.</p>
        ) : (
          <ul className="sidenav-list">
            {conversations.map((conversation) => {
              const href = `/conversations/${conversation.id}`;
              return (
                <li key={conversation.id}>
                  <Link href={href} aria-current={current(href)} data-testid="nav-conversation">
                    <span className="sidenav-name">{conversation.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <p className="sidenav-foot">
          <Link href="/status">Service status</Link>
        </p>
      </div>
    </nav>
  );
}
