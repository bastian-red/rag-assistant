/**
 * `/conversations`: one person's questions and the answers they got.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  createConversationSchema,
  idSchema,
  type ConversationDetail,
  type ConversationList,
  type ConversationSummary,
  type SessionUser,
} from '@rag/shared';
import type { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { ZodPipe } from '../common/zod.pipe';
import { ConversationsService } from './conversations.service';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  /** 201. `{collectionId}` asks one collection; `{}` or null the whole library. */
  @Post()
  create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(createConversationSchema)) input: z.infer<typeof createConversationSchema>,
  ): Promise<ConversationSummary> {
    return this.conversations.create(user.id, input.collectionId);
  }

  /** Most recently active first. */
  @Get()
  list(@CurrentUser() user: SessionUser): Promise<ConversationList> {
    return this.conversations.list(user.id);
  }

  /** The messages, oldest first, each answer with its citations. */
  @Get(':id')
  detail(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idSchema)) id: string,
  ): Promise<ConversationDetail> {
    return this.conversations.detail(user.id, id);
  }

  /** 204. Its messages, citations and traces go with it. */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: SessionUser,
    @Param('id', new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.conversations.remove(user.id, id);
  }
}
