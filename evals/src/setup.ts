/**
 * The corpus, ingested by the real pipeline into the eval database.
 *
 * One person per chunk configuration (`eval-t400-o60@rag.test`): a chunk
 * size is measured by ingesting the same corpus again under another owner,
 * and retrieval's owner filter keeps the two libraries apart, exactly as it
 * keeps two people's apart.
 *
 * Ingest is `ingestDocument` from @rag/ingest, the worker's own function,
 * called in process (no queue): what the eval measures is what the worker
 * writes. A library is reused when every document is in the state the
 * manifest expects, every chunk is in the vector space the model server
 * reports now, and the stored chunks are the spans this chunker makes of the
 * file today (a chunker change once went unmeasured: only the file hash and
 * the space were compared); anything else is ingested again.
 */
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from '@rag/chunker';
import type { PrismaClient } from '@rag/db';
import { chunksFor, IngestRefusal, ingestDocument } from '@rag/ingest';
import type { AcceptedType } from '@rag/shared';
import { writeStoredFile } from '@rag/shared/server';

import { corpusBytes, type CorpusDocument } from './corpus';
import { progress } from './progress';

export interface LibraryChunk {
  readonly id: string;
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

export interface Library {
  readonly ownerId: string;
  readonly chunkOptions: ChunkOptions;
  /** By chunk id: which file and which code points of its stored text. */
  readonly chunks: ReadonlyMap<string, LibraryChunk>;
  /** By document id. */
  readonly files: ReadonlyMap<string, string>;
  /** What ingest made of each file, against the manifest's `expect`. */
  readonly outcomes: readonly {
    file: string;
    status: string;
    expected: string;
    error: string | null;
  }[];
  readonly ingested: number;
  readonly ingestMs: number;
}

export interface SetupDeps {
  readonly prisma: PrismaClient;
  readonly embed: (texts: readonly string[]) => Promise<number[][]>;
  readonly embeddingSpace: () => Promise<string>;
  readonly uploadDir: string;
  readonly log: (line: string) => void;
}

/** `ord:start-end` for every chunk, in order: one string to compare. */
export function spanKey(chunks: readonly { charStart: number; charEnd: number }[]): string {
  return chunks.map((c, i) => `${String(i)}:${String(c.charStart)}-${String(c.charEnd)}`).join(' ');
}

/** Do the stored chunks match what this code's chunker makes of the file now? */
export async function sameSpans(
  prisma: PrismaClient,
  documentId: string,
  doc: CorpusDocument,
  chunkOptions: ChunkOptions,
): Promise<boolean> {
  const stored = await prisma.chunk.findMany({
    where: { documentId },
    orderBy: { ord: 'asc' },
    select: { charStart: true, charEnd: true },
  });
  let now: readonly { charStart: number; charEnd: number }[] = [];
  try {
    now = (await chunksFor(doc.mime as AcceptedType, corpusBytes(doc), chunkOptions)).chunked
      .chunks;
  } catch (error) {
    // A file the pipeline refuses has no chunks, stored or new.
    if (!(error instanceof IngestRefusal)) throw error;
  }
  return spanKey(stored) === spanKey(now);
}

export function ownerEmail(options: ChunkOptions): string {
  return `eval-t${String(options.targetTokens)}-o${String(options.overlapTokens)}@rag.test`;
}

export async function library(
  deps: SetupDeps,
  corpus: readonly CorpusDocument[],
  chunkOptions: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Promise<Library> {
  const { prisma } = deps;
  const email = ownerEmail(chunkOptions);
  const owner =
    (await prisma.user.findUnique({ where: { email }, select: { id: true } })) ??
    (await prisma.user.create({
      data: { email, name: `Eval ${email}`, passwordHash: 'not-a-real-hash' },
      select: { id: true },
    }));
  const collection =
    (await prisma.collection.findFirst({ where: { ownerId: owner.id }, select: { id: true } })) ??
    (await prisma.collection.create({
      data: { ownerId: owner.id, name: 'Eval corpus' },
      select: { id: true },
    }));
  const space = await deps.embeddingSpace();
  const started = performance.now();
  let ingested = 0;

  const tick = progress(`eval ingest ${ownerEmail(chunkOptions)}`);
  for (const [index, doc] of corpus.entries()) {
    const existing = await prisma.document.findFirst({
      where: { ownerId: owner.id, filename: doc.file },
      select: { id: true, sha256: true, status: true },
    });
    if (existing !== null && existing.sha256 === doc.sha256 && existing.status === doc.expect) {
      const elsewhere = await prisma.chunk.count({
        where: { documentId: existing.id, NOT: { embeddingModel: space } },
      });
      if (elsewhere === 0 && (await sameSpans(prisma, existing.id, doc, chunkOptions))) {
        tick(index + 1, corpus.length, `${doc.file} reused`);
        continue;
      }
    }
    if (existing !== null) await prisma.document.delete({ where: { id: existing.id } });

    const bytes = corpusBytes(doc);
    await writeStoredFile(deps.uploadDir, owner.id, bytes);
    const row = await prisma.document.create({
      data: {
        ownerId: owner.id,
        collectionId: collection.id,
        title: doc.title,
        filename: doc.file,
        mime: doc.mime,
        bytes: bytes.byteLength,
        sha256: doc.sha256,
      },
      select: { id: true },
    });
    const t0 = performance.now();
    try {
      const outcome = await ingestDocument(
        { documentId: row.id, ownerId: owner.id, sha256: doc.sha256 },
        {
          prisma,
          embed: deps.embed,
          embeddingSpace: deps.embeddingSpace,
          uploadDir: deps.uploadDir,
          publish: () => Promise.resolve(),
          chunkOptions,
        },
      );
      deps.log(
        `  ingested ${doc.file}: ${outcome.kind === 'ready' ? `${String(outcome.chunks)} chunks` : outcome.kind} in ${String(Math.round(performance.now() - t0))} ms`,
      );
    } catch (error) {
      if (!(error instanceof IngestRefusal)) throw error;
      // What the worker does with a refusal: FAILED, with its reason.
      await prisma.document.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: error.message },
      });
      deps.log(`  refused ${doc.file}: ${error.message}`);
    }
    ingested += 1;
    tick(index + 1, corpus.length, doc.file);
  }

  const documents = await prisma.document.findMany({
    where: { ownerId: owner.id },
    select: { id: true, filename: true, status: true, error: true },
  });
  const files = new Map(documents.map((d) => [d.id, d.filename]));
  const chunkRows = await prisma.chunk.findMany({
    where: { ownerId: owner.id },
    select: { id: true, documentId: true, charStart: true, charEnd: true },
  });
  const chunks = new Map(
    chunkRows.map((c) => [
      c.id,
      { id: c.id, file: files.get(c.documentId)!, start: c.charStart, end: c.charEnd },
    ]),
  );
  const byFile = new Map(documents.map((d) => [d.filename, d]));
  return {
    ownerId: owner.id,
    chunkOptions,
    chunks,
    files,
    outcomes: corpus.map((doc) => ({
      file: doc.file,
      status: byFile.get(doc.file)?.status ?? 'MISSING',
      expected: doc.expect,
      error: byFile.get(doc.file)?.error ?? null,
    })),
    ingested,
    ingestMs: Math.round(performance.now() - started),
  };
}
