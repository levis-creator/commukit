/**
 * SipProvider — backend-agnostic contract for the SIP bridge that links
 * softphone callers into a communications room's audio plane.
 *
 * **Why this is a separate interface from `MediaProvider`:**
 * SIP federation is inherently coupled to the *media backend's* internal
 * plumbing. The Janus implementation bridges incoming SIP RTP into the
 * same Janus AudioBridge room that WebRTC clients joined, via the Janus
 * SIP plugin. A LiveKit deployment, by contrast, would use LiveKit's SIP
 * Ingress to mint a LiveKit participant and publish SIP-side audio into
 * the LiveKit room. Those two flows share nothing at the wire level, so
 * the abstraction lives one level up: each `SipProvider` declares which
 * `MediaProvider` ids it can bridge into via `compatibleMediaProviders`,
 * and the service refuses to start when the runtime selection is
 * incompatible.
 *
 * **Today:** the only shipped implementation is the Janus SIP bridge
 * (`SipBridgeService`), which declares `compatibleMediaProviders: ['janus']`.
 *
 * **Future:** a `LivekitSipProvider` wrapping livekit-sip / SIP Ingress
 * would declare `compatibleMediaProviders: ['livekit']`. Consumers never
 * see the difference — they inject `SIP_PROVIDER` and read the abstract
 * `bridgeStatus()` from the session response and `/health`.
 */
export interface SipProvider {
  /**
   * Stable provider identifier. Surfaced in logs and the health endpoint
   * so operators can tell which SIP implementation is running.
   */
  readonly id: 'janus' | 'livekit' | string;

  /**
   * `MediaProvider.id` values this SIP implementation can bridge calls
   * into. The runtime guard in `SipBridgeService.onModuleInit` refuses to
   * REGISTER with the SIP registrar when the active media provider is
   * not in this list, preventing the silent-brokenness scenario where
   * softphones would land in a media plane that WebRTC clients never join.
   */
  readonly compatibleMediaProviders: ReadonlyArray<string>;

  /**
   * True when the bridge has successfully REGISTERed with its SIP
   * registrar (Kamailio for Janus) and is routing calls end-to-end.
   */
  isBridgeRegistered(): boolean;

  /**
   * Coarse state for `/health` and `/authorize-user` graceful degradation.
   *
   * - `registered`         — bridge is live and routing calls.
   * - `unregistered`       — bridge is enabled but not yet registered
   *                          (transient — registrar down, retrying).
   * - `incompatible-media` — SIP is enabled but the active MediaProvider
   *                          is not compatible with this SIP impl. The
   *                          bridge will NOT attempt to REGISTER until
   *                          the operator fixes the configuration.
   * - `disabled`           — SIP is intentionally off for this deployment.
   */
  bridgeStatus(): 'registered' | 'unregistered' | 'incompatible-media' | 'disabled';

  /**
   * Hang up a specific inbound SIP call by its provider-native call ID.
   * Idempotent — safe to call on a call that no longer exists.
   */
  hangupSipCall(callId: string): Promise<void>;
}
