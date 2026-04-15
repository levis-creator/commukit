import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SipService } from '../sip/sip.service';
import {
  CHAT_PROVIDER,
  MEDIA_PROVIDER,
  SIP_PROVIDER,
} from '../providers/tokens';
import type { ChatProvider } from '../providers/chat-provider.interface';
import type { MediaProvider } from '../providers/media-provider.interface';
import type { SipProvider } from '../providers/sip-provider.interface';

/**
 * Health check endpoint reporting live connectivity to each capability
 * (chat provider, media provider, SIP/Kamailio). Does not require
 * authentication — suitable for load balancer probes and uptime monitors.
 *
 * Each capability is marked `@Optional()` so the endpoint works regardless
 * of which providers the deployment loaded. A provider that isn't enabled
 * returns `"disabled"`; one that's enabled but unreachable returns
 * `"unreachable"` (or `"unregistered"` for SIP); fully working returns
 * `"connected"` (or `"registered"` for SIP).
 *
 * Response field names (`matrix`, `janus`) remain for backwards compatibility
 * with existing probes. These reflect the provider identifier, not the
 * concrete implementation class.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @Optional() @Inject(CHAT_PROVIDER) private readonly chat?: ChatProvider,
    @Optional() @Inject(MEDIA_PROVIDER) private readonly media?: MediaProvider,
    @Optional() private readonly sip?: SipService,
    @Optional() @Inject(SIP_PROVIDER) private readonly sipProvider?: SipProvider,
  ) {}

  /**
   * Returns service connectivity status for every capability.
   *
   * Status values:
   * - `connected`          — module loaded and external service reachable
   * - `unreachable`        — module loaded but external service down
   * - `disabled`           — module not loaded for this deployment
   * - `registered`         — SIP-only: bridge has REGISTERed successfully
   * - `unregistered`       — SIP-only: module loaded but bridge not yet
   *                          REGISTERed (transient; retrying)
   * - `incompatible-media` — SIP-only: the active media provider is not
   *                          compatible with the loaded SIP impl. SIP
   *                          will not work until the misconfiguration is
   *                          fixed and the service restarted.
   */
  @Get()
  @ApiOperation({
    summary: 'Health check',
    description:
      'Returns the connectivity state of each capability transport. ' +
      'Inspect the `matrix`, `janus`, and `sip` fields to determine which ' +
      'transports are currently reachable. The overall `status` is always "ok".',
  })
  @ApiResponse({
    status: 200,
    description:
      'Health status. Example: `{ status: "ok", matrix: "connected", janus: "disabled", sip: "disabled" }`.',
  })
  check() {
    return {
      status: 'ok',
      matrix: this.matrixStatus(),
      janus: this.janusStatus(),
      sip: this.sipStatus(),
    };
  }

  private matrixStatus(): 'connected' | 'unreachable' | 'disabled' {
    if (!this.chat) return 'disabled';
    return this.chat.isAvailable() ? 'connected' : 'unreachable';
  }

  private janusStatus(): 'connected' | 'unreachable' | 'disabled' {
    if (!this.media) return 'disabled';
    return this.media.isAvailable() ? 'connected' : 'unreachable';
  }

  private sipStatus():
    | 'registered'
    | 'unregistered'
    | 'incompatible-media'
    | 'disabled' {
    if (!this.sip) return 'disabled';
    // SipService alone is just a credential issuer. The REGISTER state
    // for the bridge lives in the concrete `SipProvider` implementation.
    // Consult the provider when loaded; otherwise degrade to
    // "unregistered" so consumers know SIP is enabled but not end-to-end
    // usable yet.
    if (!this.sipProvider) return 'unregistered';
    return this.sipProvider.bridgeStatus();
  }
}
