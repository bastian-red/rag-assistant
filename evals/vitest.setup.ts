/**
 * Parses the corpus once per test run, the way ingest stores it, and hands
 * the texts to every test file (`inject('corpusTexts')`). Two files read the
 * same 2.8 MB, and each parsing the NIST PDFs on its own took ~3 s apiece.
 */
import { documentText, loadManifest } from './src/corpus';

declare module 'vitest' {
  export interface ProvidedContext {
    /** File name -> stored text; null for a file ingest refuses. */
    corpusTexts: Record<string, string | null>;
  }
}

// The one method used, typed here: `vitest/node` is ESM-only and this package is CJS.
type Provide = (key: 'corpusTexts', value: Record<string, string | null>) => void;

export default async function setup({ provide }: { provide: Provide }): Promise<void> {
  const texts: Record<string, string | null> = {};
  for (const doc of loadManifest()) texts[doc.file] = await documentText(doc);
  provide('corpusTexts', texts);
}
