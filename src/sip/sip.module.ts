import { Global, Module } from '@nestjs/common';
import { SipService } from './sip.service';
import { SipBridgeService } from './sip-bridge.service';
import { LivekitSipProvider } from './livekit-sip.provider';
import { SIP_PROVIDER } from '../providers/tokens';

/**
 * SipModule — exposes free SIP softphone access to AudioBridge rooms.
 *
 * This module is conditionally imported by `AppModule` based on the
 * `SIP_ENABLED` environment variable (default: `false`). When disabled,
 * the module is not loaded at all, no SipService is instantiated, and
 * `@Optional() private sip?: SipService` consumers see `undefined`.
 *
 * The module is `@Global()` so consumers (RoomsService, controllers)
 * can inject the service without an explicit `imports` array entry.
 *
 * What this enables when `SIP_ENABLED=true`:
 * - Users can register free SIP softphones (Linphone, Zoiper, MicroSIP,
 *   Jitsi, Bria) against the Kamailio sidecar
 * - Registered users can dial `sip:room-<contextId>@<domain>` to join
 *   the corresponding AudioBridge room as a regular participant
 * - Existing mute/kick moderation works on SIP participants because
 *   they join AudioBridge with `display: '<sipUsername>|<domainUserId>'`
 *
 * What this is NOT:
 * - A PSTN gateway (no real phone numbers, no per-minute charges)
 * - A federated SIP service (private, scoped to one comms deployment)
 * - A recording solution (separate v2 feature)
 *
 * See `docs/sip/` for the full feature documentation.
 */
@Global()
@Module({
  providers: [
    SipService,
    ...((process.env.MEDIA_PROVIDER ?? 'janus').trim().toLowerCase() === 'livekit'
      ? [LivekitSipProvider, { provide: SIP_PROVIDER, useExisting: LivekitSipProvider }]
      : [SipBridgeService, { provide: SIP_PROVIDER, useExisting: SipBridgeService }]),
  ],
  exports: [SipService, SIP_PROVIDER],
})
export class SipModule {}
