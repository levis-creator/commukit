// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Global, Module } from '@nestjs/common';
import { JanusService } from './janus.service';
import { MEDIA_PROVIDER } from '../providers/tokens';

/**
 * Binds `JanusService` as the `MEDIA_PROVIDER` for the Nest DI container.
 *
 * @deprecated LiveKit is now the default media provider. Janus remains
 * available as an opt-in fallback by setting `MEDIA_PROVIDER=janus` and
 * `JANUS_ENABLED=true`. This module and its service are fully functional
 * but no longer the recommended path for new deployments.
 *
 * The concrete `JanusService` is still exported so `SipBridgeService` can
 * continue to consume Janus-specific SIP plugin helpers that are not part
 * of the `MediaProvider` interface.
 */
@Global()
@Module({
  providers: [
    JanusService,
    { provide: MEDIA_PROVIDER, useExisting: JanusService },
  ],
  exports: [JanusService, MEDIA_PROVIDER],
})
export class JanusModule {}
