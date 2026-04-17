// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { MatrixModule } from './matrix/matrix.module';
import { JanusModule } from './janus/janus.module';
import { LivekitModule } from './livekit/livekit.module';
import { SipModule } from './sip/sip.module';
import { RoomsModule } from './rooms/rooms.module';
import { UsersModule } from './users/users.module';
import { MessagingModule } from './messaging/messaging.module';
import { HealthModule } from './health/health.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';

/**
 * Reads a boolean env var, treating any case-insensitive 'true' as enabled.
 * Used to gate optional capability modules so consumers running deployments
 * that don't need a transport (chat, audio/video, sip) pay zero cost for it.
 */
const isEnabled = (key: string, fallback: 'true' | 'false'): boolean =>
  ((process.env[key] ?? fallback).trim().toLowerCase() === 'true');

const matrixEnabled = isEnabled('MATRIX_ENABLED', 'true');
const janusEnabled = isEnabled('JANUS_ENABLED', 'false');
const sipEnabled = isEnabled('SIP_ENABLED', 'false');
const mediaProvider = (process.env.MEDIA_PROVIDER ?? 'livekit').trim().toLowerCase();
const mediaImports =
  mediaProvider === 'livekit'
    ? [LivekitModule]
    : janusEnabled
      ? [JanusModule]
      : [];

@Module({
  imports: [
    // Always-on core
    DatabaseModule,
    RedisModule,
    AuthModule,
    MessagingModule,
    HealthModule,
    RoomsModule,
    UsersModule,

    // Capability modules — each conditionally loaded based on its enable flag.
    // When disabled, the module is not imported, so the corresponding service
    // is never instantiated and `@Optional()` consumers see `undefined`.
    ...(matrixEnabled ? [MatrixModule] : []),
    ...mediaImports,
    ...(sipEnabled ? [SipModule] : []),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*path');
  }
}
