import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
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
 * The three faces (docs/DESIGN.md) are self-hosted variable woff2, latin
 * subset, beside their SIL Open Font License in `app/fonts/<Face>/`, so a
 * build never fetches a font. `lib/identity.test.ts` and
 * `web/scripts/identity-distinct.mjs` read the face names from the
 * `./fonts/<Face>/` paths below.
 *
 * `metadataBase` is the public origin, so every relative Open Graph or
 * canonical URL a page declares resolves against the address readers use.
 */
/** What is read: answers, questions, passages, headings. */
const text = localFont({
  src: [
    {
      path: './fonts/Vollkorn/vollkorn-latin-wght-normal.woff2',
      weight: '400 900',
      style: 'normal',
    },
    {
      path: './fonts/Vollkorn/vollkorn-latin-wght-italic.woff2',
      weight: '400 900',
      style: 'italic',
    },
  ],
  display: 'swap',
  variable: '--font-text',
});

/** Every control and label. */
const ui = localFont({
  src: [
    {
      path: './fonts/Atkinson_Hyperlegible_Next/atkinson-hyperlegible-next-latin-wght-normal.woff2',
      weight: '200 800',
      style: 'normal',
    },
  ],
  display: 'swap',
  variable: '--font-ui',
});

/** Shelf marks, slip fields, ticket numbers. */
const mono = localFont({
  src: [
    {
      path: './fonts/Sometype_Mono/sometype-mono-latin-wght-normal.woff2',
      weight: '400 700',
      style: 'normal',
    },
  ],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL(appBaseUrl),
  title: { default: 'rag-assistant', template: '%s | rag-assistant' },
  description:
    'Ask questions of your own documents and get answers that cite the exact passage, from an open-weight model on your own machine.',
  // Every page is a private library or the door to one: nothing here is for a
  // search engine (robots.ts says the same to crawlers that skip the page).
  robots: { index: false },
};

/** The browser chrome matches the canvas in each scheme (`--bg` in globals.css). */
export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ddf2e0' },
    { media: '(prefers-color-scheme: dark)', color: '#09180c' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${text.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
