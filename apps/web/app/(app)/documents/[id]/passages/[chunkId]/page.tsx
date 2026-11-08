import { chunkViewSchema, collectionListSchema, documentSchema, idSchema } from '@rag/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { ApiError, apiFetch } from '../../../../../../lib/api';
import { pageWords } from '../../../../../../lib/chat-state';
import {
  highlight,
  offsetParam,
  originalHref,
  pageAt,
  passageWhere,
} from '../../../../../../lib/passage';
import {
  passageBlocks,
  passageFormat,
  quoteSection,
  type Block,
  type Piece,
} from '../../../../../../lib/passage-blocks';
import { requireUser } from '../../../../../../lib/session';

export const metadata = { title: 'Passage' };

/** Draws blocks; the first marked piece carries the test id and is what the page scrolls to. */
function render(blocks: readonly Block[]): ReactNode[] {
  let firstMark = true;
  const pieces = (list: readonly Piece[], key: string) =>
    list.map((piece, index) => {
      if (!piece.marked) return piece.text;
      const first = firstMark;
      firstMark = false;
      return (
        <mark
          key={`${key}.${String(index)}`}
          id={first ? 'quote' : undefined}
          data-testid={first ? 'quote' : undefined}
        >
          {piece.text}
        </mark>
      );
    });
  return blocks.map((block, index) => {
    const key = String(index);
    switch (block.kind) {
      case 'heading': {
        // Under the page's own h1, so a passage's "#" is an h2.
        const Tag = `h${String(Math.min(block.level + 1, 6))}` as 'h2';
        return (
          <Tag key={key} className="passage-heading">
            {pieces(block.pieces, key)}
          </Tag>
        );
      }
      case 'paragraph':
        return <p key={key}>{pieces(block.pieces, key)}</p>;
      case 'list':
        return (
          <ul key={key}>
            {block.items.map((item, i) => (
              <li key={`${key}.${String(i)}`}>{pieces(item, `${key}.${String(i)}`)}</li>
            ))}
          </ul>
        );
      default:
        return (
          <pre key={key} className="passage-set" tabIndex={0}>
            {pieces(block.pieces, key)}
          </pre>
        );
    }
  });
}

/**
 * Where a citation lands (PRODUCT.md moment 3): the stored passage, set as a
 * reader sees it (headings, reflowed paragraphs, tables kept as set), the
 * quoted words marked exactly (code points from the citation), the page and
 * the section the QUOTE is in, and a way to open the original at that page.
 *
 * The page is computed from the chunk's own `pageStarts`, the same rule the
 * citation resolver used, so the page printed here and the page the PDF opens
 * at cannot disagree. Without a span (a ticket opened mid-stream) the passage
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
  const library = await apiFetch(user, '/collections', collectionListSchema);
  const collection = library.collections.find((c) => c.id === document.collectionId);

  const from = offsetParam(search.from);
  const to = offsetParam(search.to);
  // `highlight` refuses a span that does not fit the text: then nothing is marked.
  const marked = highlight(chunk.text, from, to);
  const span = marked === null ? null : { from: from!, to: to! };
  const quoteStart = span?.from ?? 0;
  const format = passageFormat(document.mime);
  const page = pageAt(chunk, quoteStart);
  const where = passageWhere(page, quoteSection(chunk, format, quoteStart), document.title);
  const range = pageWords(chunk.pageStart, chunk.pageEnd);

  return (
    <main id="main" className="work">
      <header className="work-head">
        {collection === undefined ? null : (
          <p className="crumb">
            <Link href={`/collections/${collection.id}`}>{collection.name}</Link>
            <span aria-hidden="true"> / </span>
          </p>
        )}
        <h1>{document.title}</h1>
        <p className="passage-where" data-testid="passage-where">
          {where}
          {range !== null && chunk.pageStart !== chunk.pageEnd
            ? ` (the passage runs over ${range})`
            : null}
        </p>
      </header>
      {span === null ? null : <p className="muted">The quoted words are marked.</p>}
      <article className="passage" data-testid="passage" aria-label="The passage">
        {render(passageBlocks(chunk.text, format, span))}
      </article>
      <p>
        <a
          className="button"
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
