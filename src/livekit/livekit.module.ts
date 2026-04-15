import { Global, Module } from '@nestjs/common';
import { MEDIA_PROVIDER } from '../providers/tokens';
import { LivekitService } from './livekit.service';

@Global()
@Module({
  providers: [
    LivekitService,
    { provide: MEDIA_PROVIDER, useExisting: LivekitService },
  ],
  exports: [LivekitService, MEDIA_PROVIDER],
})
export class LivekitModule {}
