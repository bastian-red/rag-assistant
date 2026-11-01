/**
 * The constants a browser form needs, with no zod behind them.
 *
 * `@rag/shared` ships CommonJS, which a bundler cannot tree-shake: a client
 * component that imports one constant from the package root ships every zod
 * contract with it (about 500 KB on a sibling project's page, measured by
 * Lighthouse). Client components import these from `@rag/shared/constants`
 * instead; `constants.test.ts` holds this file import-free and
 * `apps/web/lib/client-imports.test.ts` holds the client components to it.
 *
 * The contracts re-export every name here, so server code keeps one import.
 */

/** Every length limit, in characters unless the name says otherwise. */
export const LIMITS = Object.freeze({
  collectionName: 80,
  documentTitle: 200,
  conversationTitle: 200,
  question: 2_000,
  /** One uploaded file. A 300-page text PDF is about 5 MB. */
  uploadBytes: 20 * 1024 * 1024,
});

/** What can be uploaded, by MIME type. Checked again by magic bytes on the server. */
export const ACCEPTED_TYPES = Object.freeze([
  'application/pdf',
  'text/markdown',
  'text/plain',
] as const);
