import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { appBaseUrl } from '../lib/config';
import './globals.css';

/**
 * The document and the skip link.
 *
 * **`auth()` is not called here, and must not be.** A root layout that awaits
 * the session opts every route into dynamic rendering, and this product's
 * sign-in and status pages are static. Each private page reads the session
 * itself (`lib/session.ts`).
 *
 * No typeface is loaded yet: the scaffold renders in the system face, and the
 * design step self-hosts the chosen faces with `next/font/local` (body face
 * first: answers are read for minutes at a time).
 *
 * `metadataBase` is the public origin, so every relative Open Graph or
 * canonical URL a page declares resolves against the address readers use.
 */
export const metadata: Metadata = {
  metadataBase: new URL(appBaseUrl),
  title: { default: 'rag-assistant', template: '%s | rag-assistant' },
  description:
    'Ask questions of your own documents and get answers that cite the exact passage, from an open-weight model on your own machine.',
};

/** The browser chrome matches the canvas in each scheme (`--bg` in globals.css). */
export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f4f2' },
    { media: '(prefers-color-scheme: dark)', color: '#161615' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
