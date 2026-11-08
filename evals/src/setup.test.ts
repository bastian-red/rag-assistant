import { DEFAULT_CHUNK_OPTIONS } from '@rag/chunker';
import type { PrismaClient } from '@rag/db';
import { chunksFor } from '@rag/ingest';
import type { AcceptedType } from '@rag/shared';
import { describe, expect, it } from 'vitest';

import { corpusBytes, loadManifest } from './corpus';
import { sameSpans, spanKey } from './setup';

type Span = { charStart: number; charEnd: number };

/** Prisma, as far as `sameSpans` reads it: one document's stored chunks. */
const storing = (spans: readonly Span[]) =>
  ({ chunk: { findMany: () => Promise.resolve(spans) } }) as unknown as PrismaClient;

describe('reusing an ingested eval library', () => {
  const doc = loadManifest().find((d) => d.mime === 'text/markdown' && d.expect === 'READY')!;

  it('keeps a library whose chunks are what this chunker makes of the file', async () => {
    const now = (await chunksFor(doc.mime as AcceptedType, corpusBytes(doc))).chunked.chunks;
    expect(now.length).toBeGreaterThan(1);
    expect(await sameSpans(storing(now), 'doc', doc, DEFAULT_CHUNK_OPTIONS)).toBe(true);
  });

  it('ingests again when the chunker would cut the file differently', async () => {
    const now = (await chunksFor(doc.mime as AcceptedType, corpusBytes(doc))).chunked.chunks;
    // One boundary moved by a single code point: an older chunker's library.
    const older = now.map((c, i) =>
      i === 0
        ? { ...c, charEnd: c.charEnd - 1 }
        : i === 1
          ? { ...c, charStart: c.charStart - 1 }
          : c,
    );
    expect(await sameSpans(storing(older), 'doc', doc, DEFAULT_CHUNK_OPTIONS)).toBe(false);
    expect(await sameSpans(storing(now.slice(1)), 'doc', doc, DEFAULT_CHUNK_OPTIONS)).toBe(false);
  });

  it('writes spans in order, so a reordering is a difference too', () => {
    const a = { charStart: 0, charEnd: 5 };
    const b = { charStart: 5, charEnd: 9 };
    expect(spanKey([a, b])).toBe('0:0-5 1:5-9');
    expect(spanKey([b, a])).not.toBe(spanKey([a, b]));
  });
});
