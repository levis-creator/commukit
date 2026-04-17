// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Global, Module } from '@nestjs/common';
import { MessagingService } from './messaging.service';

@Global()
@Module({
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
