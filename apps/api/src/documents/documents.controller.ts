/**
 * `/documents`. The event stream is declared first so `events` is never
 * read as a document id.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  Sse,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  type MessageEvent,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  LIMITS,
  idSchema,
  type ChunkView,
  type DocumentList,
  type DocumentView,
  type SessionUser,
  type UploadResult,
} from '@rag/shared';
import type { Response } from 'express';
import { interval, map, merge, type Observable } from 'rxjs';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { Budget } from '../common/throttle';
import { ZodPipe } from '../common/zod.pipe';
import { IngestEventsService } from '../infra/ingest-events.service';
import { DocumentsService, type UploadedFile as UploadedBytes } from './documents.service';

const uploadFieldsSchema = z.object({ collectionId: idSchema }).strict();
const listQuerySchema = z.object({ collectionId: idSchema.optional() }).strict();

/** A comment line every 25 s keeps proxies from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly events: IngestEventsService,
  ) {}

  /**
   * `GET /documents/events`: the signed-in person's ingest events as SSE.
   * `subscribed` comes first (re-read the list then); `ingest` carries an
   * `IngestEvent`; `ping` is the heartbeat.
   */
  @Sse('events')
  stream(@CurrentUser() user: SessionUser): Observable<MessageEvent> {
    return merge(
      this.events
        .stream(user.id)
        .pipe(
          map((item): MessageEvent =>
            item === 'subscribed'
              ? { type: 'subscribed', data: {} }
              : { type: 'ingest', data: item },
          ),
        ),
      interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: {} }))),
    );
  }

  /**
   * Multipart: `file` and `collectionId`. 202 with the new document, or 200
   * with the existing one when the same bytes are already in this library.
   * The upload budget runs before the body is read (guards precede
   * interceptors), so a throttled upload costs no memory.
   */
  @Budget('upload')
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: LIMITS.uploadBytes, files: 1, fields: 4, fieldSize: 1024, parts: 6 },
    }),
  )
  async upload(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(uploadFieldsSchema)) fields: z.infer<typeof uploadFieldsSchema>,
    @UploadedFile() file: UploadedBytes | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UploadResult> {
    const result = await this.documents.upload(user.id, fields.collectionId, file);
    response.status(result.duplicate ? 200 : 202);
    return result;
  }

  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query(new ZodPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<DocumentList> {
    return { documents: await this.documents.list(user.id, query.collectionId) };
  }

  @Get(':id')
  get(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idSchema)) id: string,
  ): Promise<DocumentView> {
    return this.documents.get(user.id, id);
  }

  /**
   * The original bytes, for the viewer. `nosniff` and a sandbox CSP because
   * they are a stranger's bytes as far as a browser is concerned: a markdown
   * file is never rendered as HTML from here.
   */
  @Get(':id/file')
  async file(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.documents.file(user.id, id);
    response.set({
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
    });
    return new StreamableFile(file.stream, {
      type: file.mime === 'application/pdf' ? 'application/pdf' : `${file.mime}; charset=utf-8`,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      length: file.bytes,
    });
  }

  @Get(':id/chunks/:chunkId')
  chunk(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Param('chunkId', new ZodPipe(idSchema)) chunkId: string,
  ): Promise<ChunkView> {
    return this.documents.chunk(user.id, id, chunkId);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.documents.remove(user.id, id);
  }
}
