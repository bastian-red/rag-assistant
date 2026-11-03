/**
 * `/collections`: the shelves of one person's library.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  createCollectionSchema,
  idSchema,
  type CollectionList,
  type CollectionSummary,
  type CreateCollectionInput,
  type SessionUser,
} from '@rag/shared';

import { CurrentUser } from '../common/session.guard';
import { ZodPipe } from '../common/zod.pipe';
import { DocumentsService } from '../documents/documents.service';
import { CollectionsService } from './collections.service';

@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly collections: CollectionsService,
    private readonly documents: DocumentsService,
  ) {}

  @Get()
  list(@CurrentUser() user: SessionUser): Promise<CollectionList> {
    return this.collections.list(user.id);
  }

  /** 201 with the new, empty collection; 409 when this person already has one by that name. */
  @Post()
  create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(createCollectionSchema)) input: CreateCollectionInput,
  ): Promise<CollectionSummary> {
    return this.collections.create(user.id, input.name);
  }

  /**
   * 204. Its documents and their chunks go with it (cascade), and so do
   * their stored files and waiting jobs. Conversations over it are kept,
   * unlinked (`SET NULL`).
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.collections.assertOwned(user.id, id);
    await this.documents.forgetCollection(user.id, id);
  }
}
