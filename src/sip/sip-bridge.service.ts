import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { JanusService } from '../janus/janus.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MEDIA_PROVIDER } from '../providers/tokens';
import type { MediaProvider } from '../providers/media-provider.interface';
import type { SipProvider } from '../providers/sip-provider.interface';

/**
 * Per-call state kept in Redis under `janus:sip:call:<callId>`.
 * Serialized as JSON. TTL = SIP_MAX_CALL_SECONDS so a reaper can kill
 * stuck calls after the hard cap.
 */
interface SipCallState {
  callId: string;
  sipSessionId: string;
  sipHandleId: string;
  audioHandleId: string | null;
  audioBridgeRoomId: number | null;
  contextId: string;
  contextType: string;
  appId: string;
  domainUserId: string;
  sipUsername: string;
  createdAt: number;
}

/**
 * SipBridgeService — orchestrates free SIP softphone access to AudioBridge
 * rooms. Owns the long-lived Janus SIP plugin registrar handle, the HTTP
 * long-poll worker that receives async SIP events, and the per-call state
 * that survives pod restarts.
 *
 * ## Lifecycle
 *
 *   onModuleInit → ensureBridgeRegistered → startLongPoll → keepaliveTimer
 *     ↓
 *   onSipPluginEvent (incomingcall / accepted / hangup / registered / …)
 *     ↓
 *   acceptInboundSipCall (validate user + room) → bridge to AudioBridge
 *     ↓
 *   hangupSipCall on either-side hangup or reaper tick
 *
 * ## Media bridging (important limitation)
 *
 * Janus's SIP plugin handles SIP media via its own RTP stack; the
 * AudioBridge plugin handles WebRTC+plain-RTP via its own. Janus does
 * NOT expose a direct "forward SIP RTP into AudioBridge" API. The two
 * canonical production approaches are:
 *
 *   1. Run rtpengine alongside Kamailio. Kamailio rewrites the INVITE
 *      SDP through rtpengine, which allocates proxy ports. Janus's SIP
 *      plugin sees the rtpengine endpoint instead of the softphone. A
 *      separate AudioBridge "plain RTP participant" join is pointed at
 *      rtpengine's other side. rtpengine proxies the media.
 *
 *   2. Run a second Janus instance dedicated to SIP and use
 *      AudioBridge `rtp_forward` to bridge the mix between the two.
 *
 * v1 of this service **wires up everything except the actual RTP
 * bridging** — the registrar lifecycle works, softphones can register
 * with Kamailio, INVITEs reach Janus, and inbound calls are validated
 * against the comms database. The `bridgeMediaToAudioBridge()` method
 * is a TODO stub documenting what the rtpengine-integrated v1.1 needs
 * to do. See docs/sip/01-architecture.md for the full roadmap.
 *
 * ## Zero-cost degradation
 *
 * This service is loaded by SipModule only when `SIP_ENABLED=true`. When
 * disabled, none of this code runs and `JanusService` is completely
 * unaware SIP exists.
 */
@Injectable()
export class SipBridgeService
  implements SipProvider, OnModuleInit, OnModuleDestroy
{
  readonly id = 'janus' as const;

  /**
   * The Janus SIP plugin bridges calls into a Janus AudioBridge room. It
   * has no way to publish audio into a LiveKit (or any other) media plane
   * — the two stacks share nothing at the RTP level. A future
   * `LivekitSipProvider` would declare `['livekit']` here instead.
   */
  readonly compatibleMediaProviders: ReadonlyArray<string> = ['janus'];

  private readonly logger = new Logger(SipBridgeService.name);

  /**
   * Permanent state set at startup when the runtime guard detects that
   * the active `MediaProvider` is not in `compatibleMediaProviders`. Once
   * true, the bridge will NEVER attempt to REGISTER with the SIP
   * registrar, never open a long-poll, and always reports
   * `bridgeStatus(): 'incompatible-media'`. Operators must fix the
   * MEDIA_PROVIDER / SIP_ENABLED configuration and restart the service.
   */
  private incompatibleMedia = false;

  // ── Config ──
  private readonly bridgeUsername: string;
  private readonly bridgePassword: string;
  private readonly sipDomain: string;
  private readonly registrarHost: string;
  private readonly registrarPort: number;
  private readonly maxCallSeconds: number;
  private readonly reaperIntervalMs: number;

  // ── Long-lived handle state ──
  /** Janus session that hosts the registrar handle + any per-call handles. */
  private sipSessionId: string | null = null;
  /** Handle attached to janus.plugin.sip for the bridge REGISTER. */
  private registrarHandleId: string | null = null;
  /** True once Kamailio has confirmed REGISTER via a `registered` event. */
  private registered = false;

  // ── Workers ──
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private longPollRunning = false;
  private longPollAbort: AbortController | null = null;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private initRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Correlation map for synchronous request/response pairs across the
   * long-poll boundary. When we send a message that expects a specific
   * async ACK, we register a resolver keyed on the transaction id and
   * the long-poll worker fulfills it when the matching event arrives.
   */
  private pendingTransactions = new Map<string, (event: any) => void>();

  constructor(
    // The bridge uses Janus SIP plugin helpers (sipCreateSession,
    // sipAttachHandle, sipSendMessage, sipLongPoll) that are intentionally
    // NOT part of the `MediaProvider` interface. It therefore injects the
    // concrete `JanusService` class *and* the abstract `MEDIA_PROVIDER`
    // token separately: the former for the plugin helpers, the latter
    // only to check compatibility at startup.
    private readonly janus: JanusService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional()
    @Inject(MEDIA_PROVIDER)
    private readonly media?: MediaProvider,
    // AuditWriter is injected optionally so tests can stub it. The
    // runtime writes rows to communication_audit_logs via Prisma directly.
    @Optional() private readonly auditWriter?: AuditWriter,
  ) {
    this.bridgeUsername = process.env.SIP_BRIDGE_USERNAME ?? 'janus';
    this.bridgePassword = process.env.SIP_BRIDGE_PASSWORD ?? '';
    this.sipDomain = process.env.SIP_DOMAIN ?? 'comms.local';
    this.registrarHost = process.env.SIP_REGISTRAR_HOST ?? 'comms-kamailio';
    this.registrarPort = Number(process.env.SIP_REGISTRAR_PORT ?? '5060');
    this.maxCallSeconds = Number(process.env.SIP_MAX_CALL_SECONDS ?? '7200');
    this.reaperIntervalMs = Number(process.env.SIP_REAPER_INTERVAL_MS ?? '60000');
  }

  // ── NestJS Lifecycle ─────────────────────────────────────────────────────

  async onModuleInit() {
    // ── Compatibility guard ────────────────────────────────────────────
    //
    // SIP bridging is inherently coupled to the media backend's internal
    // RTP plumbing — this implementation can only bridge into a Janus
    // AudioBridge room. If the operator has configured a different media
    // provider (e.g. MEDIA_PROVIDER=livekit), REGISTERing with Kamailio
    // would be actively harmful: softphones would land in a Janus room
    // that WebRTC clients never joined, silently breaking the "mixed
    // WebRTC + SIP" user experience.
    //
    // Refuse to start the bridge loudly and let `/health` +
    // `/authorize-user` surface the misconfiguration.
    if (this.media && !this.compatibleMediaProviders.includes(this.media.id)) {
      this.incompatibleMedia = true;
      this.logger.error(
        `SIP bridge refusing to start: active media provider "${this.media.id}" ` +
          `is not compatible with the Janus SIP implementation ` +
          `(compatible: [${this.compatibleMediaProviders.join(', ')}]). ` +
          `Either set MEDIA_PROVIDER=janus or SIP_ENABLED=false, or wait for ` +
          `a SIP provider that supports "${this.media.id}" to ship. ` +
          `See docs/PROVIDERS.md for details.`,
      );
      return;
    }

    // Don't block startup on Janus/Kamailio readiness — schedule a
    // retrying init that backs off until both are reachable. The
    // service is already usable (credential issuance works) before
    // the bridge is fully registered.
    this.scheduleInit(0);

    // Stuck-call reaper runs whether or not the bridge is registered.
    // It can't do harm if Redis has no calls to reap.
    this.reaperTimer = setInterval(() => {
      void this.reapStuckCalls();
    }, this.reaperIntervalMs);
  }

  async onModuleDestroy() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    if (this.initRetryTimer) clearTimeout(this.initRetryTimer);
    this.longPollAbort?.abort();
    if (this.sipSessionId) {
      await this.janus.sipDestroySession(this.sipSessionId).catch(() => {});
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** True when the Janus SIP bridge has successfully REGISTERed with Kamailio. */
  isBridgeRegistered(): boolean {
    return this.registered;
  }

  /** Used by /health to surface SIP bridge state to consumers. */
  bridgeStatus(): 'registered' | 'unregistered' | 'incompatible-media' | 'disabled' {
    if (this.incompatibleMedia) return 'incompatible-media';
    if (!this.janus.isAvailable()) return 'unregistered';
    return this.registered ? 'registered' : 'unregistered';
  }

  /**
   * Hang up a specific inbound SIP call. Idempotent — safe to call on a
   * callId that no longer exists (e.g. when the reaper and the normal
   * hangup path race).
   */
  async hangupSipCall(callId: string): Promise<void> {
    const state = await this.loadCallState(callId);
    if (!state) return;
    await this.teardownCall(state, 'normal_hangup');
  }

  // ── Initialization ───────────────────────────────────────────────────────

  /**
   * Schedules a retrying init until both Janus and Kamailio are reachable
   * and the registrar handle has REGISTERed successfully. Backs off
   * exponentially up to 30s between attempts.
   */
  private scheduleInit(delayMs: number): void {
    this.initRetryTimer = setTimeout(async () => {
      try {
        await this.initBridge();
        // Success — no further retries needed.
      } catch (err) {
        const next = Math.min(30_000, Math.max(2_000, delayMs * 2 || 2_000));
        this.logger.debug(
          `SIP bridge init failed (${err instanceof Error ? err.message : err}); retrying in ${next}ms`,
        );
        this.scheduleInit(next);
      }
    }, delayMs);
  }

  private async initBridge(): Promise<void> {
    if (!this.janus.isAvailable()) {
      throw new Error('Janus not yet available');
    }
    if (!this.bridgePassword) {
      throw new Error('SIP_BRIDGE_PASSWORD not configured');
    }

    // 1. Create session + attach SIP handle
    this.sipSessionId = await this.janus.sipCreateSession();
    this.registrarHandleId = await this.janus.sipAttachHandle(
      this.sipSessionId,
      'janus.plugin.sip',
    );

    // 2. Start long-poll BEFORE sending register so we don't miss the
    //    `registered` event that comes back asynchronously.
    void this.runLongPoll(this.sipSessionId);

    // 3. Send REGISTER
    await this.janus.sipSendMessage(this.sipSessionId, this.registrarHandleId, {
      request: 'register',
      type: 'registered',
      username: `sip:${this.bridgeUsername}@${this.sipDomain}`,
      authuser: this.bridgeUsername,
      secret: this.bridgePassword,
      proxy: `sip:${this.registrarHost}:${this.registrarPort}`,
    });

    // 4. Start keepalive — Janus session timeout is 60s, refresh every 25s.
    this.keepaliveTimer = setInterval(() => {
      if (this.sipSessionId) {
        void this.janus
          .sipKeepalive(this.sipSessionId)
          .catch((err) =>
            this.logger.warn(`SIP session keepalive failed: ${err}`),
          );
      }
    }, 25_000);

    this.logger.log(
      `SIP bridge initialization sent. Waiting for async 'registered' event for ${this.bridgeUsername}@${this.sipDomain}`,
    );
  }

  // ── Long-Poll Worker ─────────────────────────────────────────────────────

  private async runLongPoll(sessionId: string): Promise<void> {
    if (this.longPollRunning) return;
    this.longPollRunning = true;
    this.longPollAbort = new AbortController();

    try {
      while (!this.longPollAbort.signal.aborted && this.sipSessionId === sessionId) {
        try {
          const events = await this.janus.sipLongPoll(sessionId);
          for (const event of events) {
            await this.onSipPluginEvent(event).catch((err) =>
              this.logger.error(`SIP event handler failed: ${err}`),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('session expired')) {
            this.logger.warn('SIP session expired; tearing down and reinitializing');
            this.registered = false;
            this.sipSessionId = null;
            this.registrarHandleId = null;
            if (this.keepaliveTimer) {
              clearInterval(this.keepaliveTimer);
              this.keepaliveTimer = null;
            }
            // Kick off a fresh init
            this.scheduleInit(1000);
            break;
          }
          // Transient error — small backoff before retrying
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } finally {
      this.longPollRunning = false;
    }
  }

  // ── Event Handler ────────────────────────────────────────────────────────

  /**
   * Dispatches a single Janus async event to the appropriate handler.
   * Event shape (simplified):
   *
   *   {
   *     janus: 'event',
   *     session_id: '<sessionId>',
   *     sender: '<handleId>',
   *     transaction: '<txn>',
   *     plugindata: {
   *       plugin: 'janus.plugin.sip',
   *       data: { sip: 'event', result: { event: 'registered'|'incomingcall'|'hangup'|..., ... } }
   *     },
   *     jsep?: { ... }   // only on incomingcall/accepted
   *   }
   */
  private async onSipPluginEvent(event: any): Promise<void> {
    // Fulfill any pending transaction resolvers first
    if (event.transaction && this.pendingTransactions.has(event.transaction)) {
      const resolve = this.pendingTransactions.get(event.transaction)!;
      this.pendingTransactions.delete(event.transaction);
      resolve(event);
    }

    const plugin = event?.plugindata?.plugin;
    if (plugin !== 'janus.plugin.sip') return;

    const result = event?.plugindata?.data?.result;
    const eventType = result?.event as string | undefined;
    if (!eventType) return;

    switch (eventType) {
      case 'registered':
        if (event.sender === this.registrarHandleId) {
          this.registered = true;
          this.logger.log(
            `SIP bridge REGISTERed as ${this.bridgeUsername}@${this.sipDomain}`,
          );
          await this.audit('SIP_BRIDGE_REGISTERED', null, {
            username: this.bridgeUsername,
            domain: this.sipDomain,
          });
        }
        break;

      case 'registration_failed':
        if (event.sender === this.registrarHandleId) {
          this.registered = false;
          this.logger.error(
            `SIP bridge REGISTRATION_FAILED: ${JSON.stringify(result)}`,
          );
          await this.audit('SIP_BRIDGE_REGISTRATION_FAILED', null, {
            code: result.code,
            reason: result.reason,
          });
        }
        break;

      case 'incomingcall':
        await this.handleIncomingCall(event, result);
        break;

      case 'accepted':
        // Our own accept was acknowledged — nothing to do, state already
        // updated when we sent it.
        this.logger.debug(`SIP accept acknowledged (sender=${event.sender})`);
        break;

      case 'hangup':
        await this.handleHangupEvent(event, result);
        break;

      default:
        this.logger.debug(`Ignoring SIP event type '${eventType}'`);
    }
  }

  // ── Incoming Call ────────────────────────────────────────────────────────

  /**
   * Validate an inbound call against the comms database, then either
   * accept it and bridge into AudioBridge or decline it with a reason.
   *
   * Validation order:
   *   1. SIP_CALL_REJECTED_BRIDGE_NOT_READY — bridge hasn't REGISTERed yet
   *   2. SIP_CALL_REJECTED_MISSING_CONTEXT — no X-Comms-Context-Id header
   *   3. SIP_CALL_REJECTED_UNKNOWN_USER — From URI doesn't match any sipUsername
   *   4. SIP_CALL_REJECTED_ROOM_NOT_FOUND — context doesn't map to any room
   *   5. SIP_CALL_REJECTED_ROOM_INACTIVE — room not ACTIVE
   *   6. SIP_CALL_REJECTED_NOT_MEMBER — user has no membership in the room
   *   7. SIP_CALL_REJECTED_SESSION_INVALIDATED — membership.leftAt is set
   *   → SIP_CALL_BRIDGED on success
   */
  private async handleIncomingCall(event: any, result: any): Promise<void> {
    const senderHandleId = event.sender as string;
    const jsep = event.jsep;
    const callId = result?.call_id ?? crypto.randomUUID();
    const fromUri = result?.username as string | undefined;
    const headers = (result?.headers ?? {}) as Record<string, string>;
    const contextId = headers['X-Comms-Context-Id'] ?? headers['x-comms-context-id'];

    const rejectWith = async (action: string, reason: string) => {
      this.logger.warn(`${action}: ${reason} (callId=${callId})`);
      await this.audit(action, null, {
        callId,
        fromUri,
        contextId,
        reason,
      });
      await this.declineSipCall(senderHandleId).catch((err) =>
        this.logger.warn(`SIP decline failed: ${err}`),
      );
    };

    if (!this.registered) {
      return rejectWith('SIP_CALL_REJECTED_BRIDGE_NOT_READY', 'Bridge not yet registered');
    }
    if (!contextId) {
      return rejectWith('SIP_CALL_REJECTED_MISSING_CONTEXT', 'No X-Comms-Context-Id header');
    }

    // Extract SIP username from the From URI: sip:<user>@<domain>
    const usernameMatch = fromUri?.match(/sip:([^@]+)@/);
    const sipUsername = usernameMatch?.[1];
    if (!sipUsername) {
      return rejectWith('SIP_CALL_REJECTED_UNKNOWN_USER', 'Malformed From URI');
    }

    // Look up the CommunicationUser by sipUsername
    const user = await this.prisma.communicationUser.findUnique({
      where: { sipUsername },
    });
    if (!user) {
      return rejectWith('SIP_CALL_REJECTED_UNKNOWN_USER', `No user with sipUsername=${sipUsername}`);
    }

    // Find the room by contextId (across any contextType this user's
    // appId owns). The X-Comms-Context-Id header alone doesn't carry
    // the contextType, so we match on (appId, contextId).
    const room = await this.prisma.communicationRoom.findFirst({
      where: { appId: user.appId, contextId },
    });
    if (!room) {
      return rejectWith('SIP_CALL_REJECTED_ROOM_NOT_FOUND', `No room for context ${contextId}`);
    }
    if (room.status !== 'ACTIVE') {
      return rejectWith('SIP_CALL_REJECTED_ROOM_INACTIVE', `Room status ${room.status}`);
    }
    if (!room.audioRoomId) {
      return rejectWith('SIP_CALL_REJECTED_ROOM_NOT_FOUND', 'Room has no AudioBridge');
    }

    // Verify membership
    const membership = await this.prisma.communicationMembership.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: user.id } },
    });
    if (!membership) {
      return rejectWith('SIP_CALL_REJECTED_NOT_MEMBER', 'No membership');
    }
    if (membership.leftAt) {
      return rejectWith('SIP_CALL_REJECTED_SESSION_INVALIDATED', 'Membership leftAt set');
    }

    // All checks pass — accept the call and bridge into AudioBridge.
    try {
      await this.acceptAndBridge({
        callId,
        senderHandleId,
        jsep,
        room,
        user,
        sipUsername,
      });
      await this.audit('SIP_CALL_BRIDGED', user.domainUserId, {
        callId,
        roomId: room.id,
        contextId: room.contextId,
        sipUsername,
      }, room.id);
    } catch (err) {
      this.logger.error(`Failed to accept+bridge SIP call ${callId}: ${err}`);
      await this.audit('SIP_CALL_BRIDGE_FAILED', user.domainUserId, {
        callId,
        roomId: room.id,
        error: err instanceof Error ? err.message : String(err),
      }, room.id);
      await this.declineSipCall(senderHandleId).catch(() => {});
    }
  }

  /**
   * Accept an inbound SIP call and bridge its media into the target
   * AudioBridge room. Persists per-call state to Redis so hangup and
   * the reaper can find the call later.
   *
   * NOTE: the `bridgeMediaToAudioBridge` step is a stub in v1 — see the
   * class-level JSDoc for why. The SIP call will be accepted (so the
   * softphone hears silence instead of a rejection) but media will not
   * actually flow until the rtpengine integration lands in v1.1.
   */
  private async acceptAndBridge(args: {
    callId: string;
    senderHandleId: string;
    jsep: any;
    room: { id: string; contextId: string; contextType: string; appId: string; audioRoomId: number | null };
    user: { id: string; domainUserId: string; displayName: string };
    sipUsername: string;
  }): Promise<void> {
    if (!this.sipSessionId) throw new Error('SIP session lost');

    // Accept the INVITE — Janus generates the answer SDP internally when
    // we provide only the offer JSEP. For plain audio-only calls the
    // default answer is sufficient.
    await this.janus.sipSendMessage(
      this.sipSessionId,
      args.senderHandleId,
      { request: 'accept' },
      args.jsep,
    );

    // Attach a second handle for the AudioBridge side on the same session.
    const audioHandleId = await this.janus.sipAttachHandle(
      this.sipSessionId,
      'janus.plugin.audiobridge',
    );

    // TODO(v1.1): bridge media via rtpengine. For now we issue the join
    // as a regular AudioBridge participant so moderation (mute/kick) by
    // domainUserId resolves correctly via the display-name convention.
    // The join succeeds but no RTP flows until rtpengine is wired in.
    await this.bridgeMediaToAudioBridge({
      audioHandleId,
      audioBridgeRoomId: args.room.audioRoomId!,
      display: `${args.sipUsername}|${args.user.domainUserId}`,
    });

    const state: SipCallState = {
      callId: args.callId,
      sipSessionId: this.sipSessionId,
      sipHandleId: args.senderHandleId,
      audioHandleId,
      audioBridgeRoomId: args.room.audioRoomId,
      contextId: args.room.contextId,
      contextType: args.room.contextType,
      appId: args.room.appId,
      domainUserId: args.user.domainUserId,
      sipUsername: args.sipUsername,
      createdAt: Date.now(),
    };
    await this.saveCallState(state);
  }

  /**
   * Stub for the actual SIP→AudioBridge media bridge. In v1 we issue the
   * AudioBridge `join` with the domain-user display so moderation works
   * by `domainUserId`, but the plain-RTP parameters that would actually
   * wire the softphone's audio into the mix are NOT yet set — doing so
   * correctly requires either rtpengine on the Kamailio side or a second
   * Janus instance with `rtp_forward`. Both are v1.1 features.
   *
   * Once rtpengine is wired in, this method becomes:
   *
   *   await janus.sipSendMessage(sessionId, audioHandleId, {
   *     request: 'join',
   *     room: audioBridgeRoomId,
   *     display,
   *     rtp: { ip: rtpengineIp, port: rtpenginePort, payload_type: 0 },
   *   });
   */
  private async bridgeMediaToAudioBridge(args: {
    audioHandleId: string;
    audioBridgeRoomId: number;
    display: string;
  }): Promise<void> {
    if (!this.sipSessionId) throw new Error('SIP session lost');
    try {
      await this.janus.sipSendMessage(
        this.sipSessionId,
        args.audioHandleId,
        {
          request: 'join',
          room: args.audioBridgeRoomId,
          display: args.display,
          muted: false,
        },
      );
    } catch (err) {
      this.logger.warn(
        `AudioBridge join failed (expected in v1 without rtpengine): ${err}`,
      );
    }
  }

  private async declineSipCall(handleId: string): Promise<void> {
    if (!this.sipSessionId) return;
    await this.janus.sipSendMessage(this.sipSessionId, handleId, {
      request: 'decline',
      code: 603, // Decline
    });
  }

  // ── Hangup ───────────────────────────────────────────────────────────────

  private async handleHangupEvent(event: any, result: any): Promise<void> {
    // Find the call this handle belongs to by scanning Redis.
    // Hangup events don't carry our callId directly — we match on
    // the sender handleId.
    const handleId = event.sender as string;
    const allCalls = await this.listAllCallStates();
    const state = allCalls.find(
      (c) => c.sipHandleId === handleId || c.audioHandleId === handleId,
    );
    if (!state) {
      this.logger.debug(`Hangup for unknown handle ${handleId}`);
      return;
    }
    await this.teardownCall(state, result?.reason ?? 'remote_hangup');
  }

  private async teardownCall(state: SipCallState, reason: string): Promise<void> {
    if (!this.sipSessionId) return;

    // Tell Janus to hang up the SIP side (idempotent)
    try {
      await this.janus.sipSendMessage(
        this.sipSessionId,
        state.sipHandleId,
        { request: 'hangup' },
      );
    } catch (err) {
      this.logger.debug(`SIP hangup request failed (may already be gone): ${err}`);
    }

    // Leave the AudioBridge side
    if (state.audioHandleId && state.audioBridgeRoomId) {
      try {
        await this.janus.sipSendMessage(
          this.sipSessionId,
          state.audioHandleId,
          { request: 'leave' },
        );
      } catch (err) {
        this.logger.debug(`AudioBridge leave failed: ${err}`);
      }
    }

    const durationSeconds = Math.round((Date.now() - state.createdAt) / 1000);
    await this.audit(
      reason === 'reaped' ? 'SIP_CALL_TIMEOUT_REAPED' : 'SIP_CALL_HUNG_UP',
      state.domainUserId,
      { callId: state.callId, sipUsername: state.sipUsername, durationSeconds, reason },
      await this.resolveRoomPk(state),
    );

    await this.deleteCallState(state.callId);
  }

  // ── Reaper ───────────────────────────────────────────────────────────────

  /**
   * Kills any call whose age exceeds `SIP_MAX_CALL_SECONDS`. Runs on a
   * Cron-style interval regardless of whether any calls are active.
   */
  private async reapStuckCalls(): Promise<void> {
    if (!this.redis.isReady()) return;
    const now = Date.now();
    const maxAgeMs = this.maxCallSeconds * 1000;
    const all = await this.listAllCallStates();
    for (const call of all) {
      if (now - call.createdAt > maxAgeMs) {
        this.logger.warn(
          `Reaping stuck SIP call ${call.callId} (age=${Math.round((now - call.createdAt) / 1000)}s)`,
        );
        await this.teardownCall(call, 'reaped').catch((err) =>
          this.logger.error(`Reaper teardown failed for ${call.callId}: ${err}`),
        );
      }
    }
  }

  // ── Redis Call State ─────────────────────────────────────────────────────

  private callKey(callId: string): string {
    return `janus:sip:call:${callId}`;
  }

  private async saveCallState(state: SipCallState): Promise<void> {
    if (!this.redis.isReady()) return;
    // Cap TTL slightly above maxCallSeconds so the reaper gets a chance
    // to fire before Redis drops the key on its own.
    const ttl = this.maxCallSeconds + 60;
    await this.redis.set(this.callKey(state.callId), JSON.stringify(state), ttl);
  }

  private async loadCallState(callId: string): Promise<SipCallState | null> {
    if (!this.redis.isReady()) return null;
    const raw = await this.redis.get(this.callKey(callId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async deleteCallState(callId: string): Promise<void> {
    if (!this.redis.isReady()) return;
    await this.redis.del(this.callKey(callId));
  }

  /**
   * Returns every active SIP call. Used by the hangup event handler to
   * find the owning call from a Janus handle id, and by the reaper to
   * iterate stuck calls.
   *
   * Uses Redis SCAN (non-blocking) so we don't freeze the single Redis
   * thread on large keyspaces.
   */
  private async listAllCallStates(): Promise<SipCallState[]> {
    if (!this.redis.isReady()) return [];
    const keys = await this.redis.scanKeys('janus:sip:call:*');
    const states: SipCallState[] = [];
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw) continue;
      try {
        states.push(JSON.parse(raw));
      } catch {
        /* ignore corrupt entries */
      }
    }
    return states;
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  /**
   * Writes a single audit row. Failures are swallowed (with a loud log)
   * to mirror the existing RoomsService audit pattern — an audit DB blip
   * must not roll back a SIP state transition.
   *
   * `roomPk` (optional) is the `communication_rooms.id` UUID. When null
   * we write a synthetic row with a sentinel room id, because the schema
   * requires a non-null `roomId` foreign key. For bridge-level events
   * that aren't tied to a room (registration success/failure) we skip
   * the audit write and log instead.
   */
  private async audit(
    action: string,
    actorUserId: string | null,
    metadata: Record<string, any>,
    roomPk?: string | null,
  ): Promise<void> {
    try {
      if (this.auditWriter) {
        await this.auditWriter(action, actorUserId, metadata, roomPk ?? null);
        return;
      }
      if (!roomPk) {
        // Bridge-level event — log it but don't try to satisfy the FK.
        this.logger.log(`[AUDIT] ${action} ${JSON.stringify(metadata)}`);
        return;
      }
      await this.prisma.communicationAuditLog.create({
        data: {
          roomId: roomPk,
          action,
          actorUserId: actorUserId ?? undefined,
          metadata,
        },
      });
    } catch (err) {
      this.logger.error(
        `AUDIT LOG WRITE FAILED · action=${action} actor=${actorUserId ?? '-'} · ${err}`,
      );
    }
  }

  /**
   * Best-effort room PK lookup. Used by the hangup/reaper path where we
   * only have a Redis state blob (no live Prisma query on the hot path).
   */
  private async resolveRoomPk(state: SipCallState): Promise<string | null> {
    try {
      const room = await this.prisma.communicationRoom.findUnique({
        where: {
          appId_contextType_contextId: {
            appId: state.appId,
            contextType: state.contextType,
            contextId: state.contextId,
          },
        },
        select: { id: true },
      });
      return room?.id ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Audit writer hook — allows tests to capture audit calls without a
 * real database, and allows a future consolidation with RoomsService's
 * audit implementation without changing this class's signature.
 */
export type AuditWriter = (
  action: string,
  actorUserId: string | null,
  metadata: Record<string, any>,
  roomPk: string | null,
) => Promise<void>;
