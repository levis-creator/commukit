import { Global, Module } from '@nestjs/common';
import { JanusService } from './janus.service';
import { MEDIA_PROVIDER } from '../providers/tokens';

/**
 * Binds `JanusService` as the `MEDIA_PROVIDER` for the Nest DI container.
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
