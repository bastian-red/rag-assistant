/**
 * `/collections`: the shelves of one person's library. Listing only for now;
 * creating and deleting arrive with uploads (build step 5).
 */
import { Controller, Get } from '@nestjs/common';
import type { CollectionList, SessionUser } from '@rag/shared';

import { CurrentUser } from '../common/session.guard';
import { CollectionsService } from './collections.service';

@Controller('collections')
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  list(@CurrentUser() user: SessionUser): Promise<CollectionList> {
    return this.collections.list(user.id);
  }
}
