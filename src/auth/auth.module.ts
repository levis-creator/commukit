// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Global, Module } from '@nestjs/common';
import { InternalJwtGuard } from './internal-jwt.guard';

@Global()
@Module({
  providers: [InternalJwtGuard],
  exports: [InternalJwtGuard],
})
export class AuthModule {}
