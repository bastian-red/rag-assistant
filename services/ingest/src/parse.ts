/**
 * Bytes to text, per type. A PDF keeps its pages (one string per page, an
 * image-only page as ''), so a citation can say "page 3"; markdown and text
 * are decoded as strict UTF-8.
 *
 * unpdf 2.x (pdf.js 5) needs Node 24, which .nvmrc pins everywhere. In 2.x a
 * document proxy has no destroy(); its loading task does.
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
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // A copy: pdf.js transfers the buffer it is given to its worker, which
    // would detach the caller's bytes.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    ({ text: pages } = await extractText(pdf, { mergePages: false }));
  } catch {
    // InvalidPDFException, PasswordException, a truncated xref: the file is
    // the problem whichever it is, and none of their messages is for a reader.
    throw new IngestRefusal(INGEST_FAILURES.unreadablePdf);
  } finally {
    // Outside the refusal: freeing pdf.js's worker state is our bookkeeping,
    // and a failure there says nothing about the file. Under 1.7 this sat
    // inside the try, so the 2.x upgrade (no proxy.destroy) refused every PDF.
    await pdf?.loadingTask.destroy().catch(() => undefined);
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
