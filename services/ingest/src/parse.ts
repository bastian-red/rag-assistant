/**
 * Bytes to text, per type. A PDF keeps its pages (one string per page, an
 * image-only page as ''), so a citation can say "page 3"; markdown and text
 * are decoded as strict UTF-8.
 *
 * unpdf 1.7.0 is pinned: 1.8 and later need Node 22, 2.x needs Node 24, and
 * this repo runs on Node 20 everywhere (CI, the images, the dev machine).
 */
import { INGEST_FAILURES, type AcceptedType } from '@rag/shared';
import { assemblePages, normalise } from '@rag/chunker';

import { IngestRefusal } from './errors';

export type Parsed =
  | { readonly format: 'pdf'; readonly pages: readonly string[] }
  | { readonly format: 'markdown' | 'text'; readonly text: string };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

async function parsePdf(bytes: Uint8Array): Promise<Parsed> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pages: string[];
  try {
    // A copy: pdf.js transfers the buffer it is given to its worker, which
    // would detach the caller's bytes.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    try {
      ({ text: pages } = await extractText(pdf, { mergePages: false }));
    } finally {
      await pdf.destroy();
    }
  } catch {
    // InvalidPDFException, PasswordException, a truncated xref: the file is
    // the problem whichever it is, and none of their messages is for a reader.
    throw new IngestRefusal(INGEST_FAILURES.unreadablePdf);
  }
  // Pages with no text are kept (they hold their numbers); a PDF where EVERY
  // page is empty after normalising is a scan, and there is no OCR here.
  if (assemblePages(pages).text === '') throw new IngestRefusal(INGEST_FAILURES.noTextLayer);
  return { format: 'pdf', pages };
}

function parseText(bytes: Uint8Array, format: 'markdown' | 'text'): Parsed {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new IngestRefusal(INGEST_FAILURES.notUtf8);
  }
  if (normalise(text) === '') throw new IngestRefusal(INGEST_FAILURES.empty);
  return { format, text };
}

export async function parseFile(mime: AcceptedType, bytes: Uint8Array): Promise<Parsed> {
  if (mime === 'application/pdf') return parsePdf(bytes);
  return parseText(bytes, mime === 'text/markdown' ? 'markdown' : 'text');
}
