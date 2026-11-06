/**
 * The application graph.
 *
 * Two global guards, in order, each failing closed:
 *
 * 1. `SessionGuard`: every route needs a service token unless `@Public()`.
 * 2. `ThrottlerGuard`: the general budget everywhere, keyed by user or by
 *    address (so the session guard must run first); `auth`, `upload` and
 *    `chat` add stricter ones where `@Budget` asks; health and status skip.
 *
 * There is no role guard: every user owns a private library and nothing else,
 * so authorisation is an owner filter in each query, tested per feature.
 */
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { API_CONFIG, type ApiConfig } from './config/config';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ChatController } from './chat/chat.controller';
import { ChatService } from './chat/chat.service';
import { CollectionsController } from './collections/collections.controller';
import { CollectionsService } from './collections/collections.service';
import { ConversationsController } from './conversations/conversations.controller';
import { ConversationsService } from './conversations/conversations.service';
import { DomainErrorFilter } from './common/domain-error.filter';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { uploadStorage } from './documents/upload-storage';
import { SessionGuard } from './common/session.guard';
import { throttlers } from './common/throttle';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { InfraModule } from './infra/infra.module';
import { RedisService } from './infra/redis.service';
import { StatusController } from './status/status.controller';

@Module({
  imports: [
    InfraModule,
    ThrottlerModule.forRootAsync({
      inject: [API_CONFIG, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) => ({
        throttlers: throttlers(config),
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
    // Uploads stream to UPLOAD_DIR/.incoming instead of multer's default
    // memory buffer; FileInterceptor's own options (the limits) merge on top.
    MulterModule.registerAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => ({ storage: uploadStorage(config.uploadDir) }),
    }),
  ],
  controllers: [
    AuthController,
    ChatController,
    CollectionsController,
    ConversationsController,
    DocumentsController,
    HealthController,
    StatusController,
  ],
  providers: [
    AuthService,
    ChatService,
    CollectionsService,
    ConversationsService,
    DocumentsService,
    HealthService,
    // Registration order is execution order.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
