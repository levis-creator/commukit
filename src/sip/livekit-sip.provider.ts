// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { MEDIA_PROVIDER } from '../providers/tokens';
import type { MediaProvider } from '../providers/media-provider.interface';
import type { SipProvider } from '../providers/sip-provider.interface';
import { SipService } from './sip.service';

@Injectable()
export class LivekitSipProvider implements SipProvider, OnModuleInit {
  readonly id = 'livekit' as const;
  readonly compatibleMediaProviders: ReadonlyArray<string> = ['livekit'];

  private readonly logger = new Logger(LivekitSipProvider.name);
  private ready = false;

  constructor(
    private readonly sip: SipService,
    @Optional() @Inject(MEDIA_PROVIDER) private readonly media?: MediaProvider,
  ) {}

  async onModuleInit() {
    if (this.media && !this.compatibleMediaProviders.includes(this.media.id)) {
      this.ready = false;
      return;
    }
    this.ready = await this.sip.ensureLivekitInfrastructure();
    if (!this.ready) {
      this.logger.warn('LiveKit SIP infrastructure is not ready yet.');
    }
  }

  isBridgeRegistered(): boolean {
    return this.ready && !!this.media?.isAvailable();
  }

  bridgeStatus(): 'registered' | 'unregistered' | 'incompatible-media' | 'disabled' {
    if (this.media && !this.compatibleMediaProviders.includes(this.media.id)) {
      return 'incompatible-media';
    }
    if (!this.media?.isAvailable()) return 'unregistered';
    return this.ready ? 'registered' : 'unregistered';
  }

  async hangupSipCall(_callId: string): Promise<void> {
    // LiveKit models SIP callers as regular room participants. Hangup for a
    // specific SIP call is handled through participant management rather than
    // a Janus-style registrar handle, so this method is intentionally a no-op
    // until the service persists callId -> participant mappings.
  }
}
