/**
 * Documents: upload, read, delete. Every query filters by `ownerId`; a
 * document that is not yours is a 404, the same answer as one that does not
 * exist, so ids cannot be probed.
 *
 * An upload is checked in this order, cheapest first, and nothing is written
 * until every check has passed:
 *
 *   size (multer, 413) -> bytes match the name (415) -> the collection is
 *   yours (404) -> same bytes already in your library (200, the existing
 *   document) -> store by hash -> row QUEUED -> job -> 202
 *
 * "Nothing is written" means nothing under a stored name: multer streams the
 * body to `.incoming/` (upload-storage.ts) and the checks read what the
 * inspector gathered on the way, so the API never holds a whole file. The
 * staged file is adopted by rename or removed before the request returns.
 *
 * The bytes are stored BEFORE the row exists, so the worker can never see a
 * row whose file is not there yet. A crash between the row and the job
 * leaves a QUEUED document the worker re-queues when it starts (reconcile);
 * a crash or a failed insert between the file and the row leaves a file no
 * row names, which the worker's sweep removes (`sweepUploads`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DOCUMENT_SHA256_UNIQUE, violatedUniqueIndex } from '@rag/db';
import {
  DomainError,
  chunkViewSchema,
  documentSchema,
  documentTitle,
  safeFilename,
  type ChunkView,
  type DocumentView,
  type UploadResult,
} from '@rag/shared';
import type { ReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';

import {
  adoptIncomingFile,
  openStoredFile,
  removeStoredFile,
  sniffInspection,
} from '@rag/shared/server';

import { API_CONFIG, type ApiConfig } from '../config/config';
import type { IncomingUpload } from './upload-storage';
import { IngestQueueService } from '../infra/ingest-queue.service';
import { PrismaService } from '../infra/prisma.service';

const DOCUMENT_SELECT = {
  id: true,
  ownerId: true,
  collectionId: true,
  title: true,
  filename: true,
  mime: true,
  bytes: true,
  sha256: true,
  status: true,
  error: true,
  pages: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { chunks: true } },
} as const;

interface DocumentRow {
  id: string;
  collectionId: string;
  title: string;
  filename: string;
  mime: string;
  bytes: number;
  status: string;
  error: string | null;
  pages: number | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { chunks: number };
}

export function toView(row: DocumentRow): DocumentView {
  return documentSchema.parse({
    id: row.id,
    collectionId: row.collectionId,
    title: row.title,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    status: row.status,
    error: row.error,
    pages: row.pages,
    chunks: row._count.chunks,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export type UploadedFile = IncomingUpload;

export interface StoredFile {
  /** Streamed to the response, never read whole into memory. */
  readonly stream: ReadStream;
  readonly bytes: number;
  readonly mime: string;
  readonly filename: string;
}

const notFound = () => new DomainError('NOT_FOUND', 'No such document.');

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: IngestQueueService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async upload(
    ownerId: string,
    collectionId: string,
    file: UploadedFile | undefined,
  ): Promise<UploadResult> {
    if (file === undefined) throw new DomainError('INVALID', 'Choose a file to upload.');
    try {
      return await this.accept(ownerId, collectionId, file);
    } finally {
      // Adopted files were renamed away; anything still here was refused.
      await rm(file.path, { force: true });
    }
  }

  private async accept(
    ownerId: string,
    collectionId: string,
    file: UploadedFile,
  ): Promise<UploadResult> {
    const filename = safeFilename(file.originalname);
    const sniffed = sniffInspection(filename, file.inspection);
    if (!sniffed.ok) throw new DomainError('UNSUPPORTED', `Not accepted: ${sniffed.reason}.`);

    const collection = await this.prisma.client.collection.findFirst({
      where: { id: collectionId, ownerId },
      select: { id: true },
    });
    if (collection === null) throw new DomainError('NOT_FOUND', 'No such collection.');

    const { sha256 } = file.inspection;
    const existing = await this.findBySha(ownerId, sha256);
    if (existing !== null) return this.duplicate(ownerId, existing, file.path);

    await adoptIncomingFile(file.path, this.config.uploadDir, ownerId, sha256);
    const text = sniffed.mime === 'application/pdf' ? null : file.inspection.leadingText;
    let row: DocumentRow;
    try {
      row = await this.prisma.client.document.create({
        data: {
          ownerId,
          collectionId,
          title: documentTitle(filename, text),
          filename,
          mime: sniffed.mime,
          bytes: file.inspection.bytes,
          sha256,
        },
        select: DOCUMENT_SELECT,
      });
    } catch (error) {
      // Two uploads of the same bytes at once: the unique index picked one,
      // and the other is a duplicate of it.
      if (!violatedUniqueIndex(error, DOCUMENT_SHA256_UNIQUE)) throw error;
      const winner = await this.findBySha(ownerId, sha256);
      if (winner === null) throw error;
      return { document: toView(winner), duplicate: true };
    }
    await this.queue.enqueue({ documentId: row.id, ownerId, sha256 });
    return { document: toView(row), duplicate: false };
  }

  /**
   * The same bytes again. One document, one chunk set (SPECS #4). A FAILED
   * one is given another go: its reasons say "upload it again", and the
   * person just did, so the file is re-stored and the job re-queued.
   */
  private async duplicate(
    ownerId: string,
    existing: DocumentRow & { sha256: string },
    incoming: string,
  ): Promise<UploadResult> {
    if (existing.status !== 'FAILED') return { document: toView(existing), duplicate: true };
    await adoptIncomingFile(incoming, this.config.uploadDir, ownerId, existing.sha256);
    const row = await this.prisma.client.document.update({
      where: { id: existing.id },
      data: { status: 'QUEUED', error: null },
      select: DOCUMENT_SELECT,
    });
    await this.queue.enqueue({ documentId: row.id, ownerId, sha256: existing.sha256 });
    return { document: toView(row), duplicate: true };
  }

  private findBySha(ownerId: string, sha256: string) {
    return this.prisma.client.document.findUnique({
      where: { ownerId_sha256: { ownerId, sha256 } },
      select: DOCUMENT_SELECT,
    });
  }

  async list(ownerId: string, collectionId: string | undefined): Promise<DocumentView[]> {
    if (collectionId !== undefined) {
      const owned = await this.prisma.client.collection.count({
        where: { id: collectionId, ownerId },
      });
      if (owned === 0) throw new DomainError('NOT_FOUND', 'No such collection.');
    }
    const rows = await this.prisma.client.document.findMany({
      where: { ownerId, ...(collectionId === undefined ? {} : { collectionId }) },
      select: DOCUMENT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toView);
  }

  async get(ownerId: string, id: string): Promise<DocumentView> {
    const row = await this.prisma.client.document.findFirst({
      where: { id, ownerId },
      select: DOCUMENT_SELECT,
    });
    if (row === null) throw notFound();
    return toView(row);
  }

  async file(ownerId: string, id: string): Promise<StoredFile> {
    const row = await this.prisma.client.document.findFirst({
      where: { id, ownerId },
      select: { sha256: true, mime: true, filename: true },
    });
    if (row === null) throw notFound();
    const opened = await openStoredFile(this.config.uploadDir, ownerId, row.sha256);
    if (opened === null)
      throw new DomainError('GONE', 'The stored file is missing; upload it again.');
    return { ...opened, mime: row.mime, filename: row.filename };
  }

  async chunk(ownerId: string, documentId: string, chunkId: string): Promise<ChunkView> {
    const row = await this.prisma.client.chunk.findFirst({
      where: { id: chunkId, documentId, ownerId },
      select: {
        id: true,
        documentId: true,
        ord: true,
        text: true,
        charStart: true,
        charEnd: true,
        pageStart: true,
        pageEnd: true,
        pageStarts: true,
        headingPath: true,
      },
    });
    if (row === null) throw new DomainError('NOT_FOUND', 'No such passage.');
    return chunkViewSchema.parse(row);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const row = await this.prisma.client.document.findFirst({
      where: { id, ownerId },
      select: { sha256: true },
    });
    if (row === null) throw notFound();
    await this.prisma.client.document.deleteMany({ where: { id, ownerId } });
    // The row first: a worker mid-ingest then finds it gone and stops; the
    // file and the job after, because one sha256 is one row per person.
    await removeStoredFile(this.config.uploadDir, ownerId, row.sha256);
    await this.queue.discard(id);
  }

  /** Files and jobs of every document in a collection, before it is deleted. */
  async forgetCollection(ownerId: string, collectionId: string): Promise<void> {
    const rows = await this.prisma.client.document.findMany({
      where: { ownerId, collectionId },
      select: { id: true, sha256: true },
    });
    await this.prisma.client.collection.deleteMany({ where: { id: collectionId, ownerId } });
    for (const row of rows) {
      await removeStoredFile(this.config.uploadDir, ownerId, row.sha256);
      await this.queue.discard(row.id);
    }
  }
}
