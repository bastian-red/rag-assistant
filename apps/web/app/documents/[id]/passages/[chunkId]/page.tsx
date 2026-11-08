import { chunkViewSchema, documentSchema, idSchema } from '@rag/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '../../../../../lib/api';
import { pageWords } from '../../../../../lib/chat-state';
import { highlight, offsetParam, originalHref, pageAt } from '../../../../../lib/passage';
import { requireUser } from '../../../../../lib/session';

export const metadata = { title: 'Passage', robots: { index: false } };

/**
 * Where a citation lands (PRODUCT.md moment 3): the stored passage, with the
 * quoted span marked exactly (code points from the citation), the page it is
 * on, and a way to open the original at that page.
 *
 * The page is computed from the chunk's own `pageStarts`, the same rule the
 * citation resolver used, so the page printed here and the page the PDF opens
 * at cannot disagree. Without a span (a chip clicked mid-stream) the passage
 * shows unmarked at its first page.
 */
export default async function PassagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; chunkId: string }>;
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const [{ id, chunkId }, search] = await Promise.all([params, searchParams]);
  const here = `/documents/${id}/passages/${chunkId}`;
  const user = await requireUser(
    search.from === undefined
      ? here
      : `${here}?from=${String(search.from)}&to=${String(search.to)}`,
  );
  if (!idSchema.safeParse(id).success || !idSchema.safeParse(chunkId).success) notFound();

  let document;
  let chunk;
  try {
    [document, chunk] = await Promise.all([
      apiFetch(user, `/documents/${id}`, documentSchema),
      apiFetch(user, `/documents/${id}/chunks/${chunkId}`, chunkViewSchema),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const marked = highlight(chunk.text, offsetParam(search.from), offsetParam(search.to));
  const quoteStart = marked === null ? 0 : Array.from(marked.before).length;
  const page = pageAt(chunk, quoteStart);
  const span = pageWords(chunk.pageStart, chunk.pageEnd);

  return (
    <main id="main" className="page">
      <p>
        <Link href={`/collections/${document.collectionId}`}>← {document.title}</Link>
      </p>
      <h1>{document.title}</h1>
      <p className="muted" data-testid="passage-where">
        {page === null ? 'Passage' : `Page ${String(page)}`}
        {span !== null && chunk.pageStart !== chunk.pageEnd ? ` (the passage spans ${span})` : null}
        {chunk.headingPath.length === 0 ? null : ` · ${chunk.headingPath.join(' › ')}`}
      </p>
      {marked === null ? null : <p className="muted">The quoted sentence is marked.</p>}
      <blockquote className="passage panel" data-testid="passage">
        {marked === null ? (
          chunk.text
        ) : (
          <>
            {marked.before}
            <mark data-testid="quote">{marked.quote}</mark>
            {marked.after}
          </>
        )}
      </blockquote>
      <p>
        <a
          href={originalHref(document.id, page)}
          target="_blank"
          rel="noopener"
          data-testid="original"
        >
          {page === null ? 'Open the original file' : `Open the original at page ${String(page)}`}
        </a>
      </p>
    </main>
  );
}
