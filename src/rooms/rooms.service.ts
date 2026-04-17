// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SipService } from '../sip/sip.service';
import { MessagingService } from '../messaging/messaging.service';
import { RedisService } from '../redis/redis.service';
import {
  CHAT_PROVIDER,
  MEDIA_PROVIDER,
  SIP_PROVIDER,
} from '../providers/tokens';
import type { ChatProvider } from '../providers/chat-provider.interface';
import type { MediaProvider } from '../providers/media-provider.interface';
import type { SipProvider } from '../providers/sip-provider.interface';
import { ProvisionRoomDto, RoomMode } from './dto/provision-room.dto';
import { AuthorizeUserDto, CommunicationRole } from './dto/authorize-user.dto';

/** Base shape for each capability in a session response. */
export interface CapabilityStatus {
  /** Whether the transport is reachable and usable for this session. */
  status: 'available' | 'unavailable';
  /** Human-readable reason when status is "unavailable". */
  reason?: string;
}

// ── Provider-discriminated credentials (Phase 3 shape) ───────────────────────
//
// Each capability exposes a provider-tagged `credentials` object alongside
// the legacy flat fields. Version-1 clients (no `X-Comms-API-Version` header)
// still receive the flat fields; version-2 clients (set via the controller's
// header sniff + `stripLegacySessionFields`) receive `credentials` only.
// Phase 5 deletes the legacy flat fields for good.

export interface MatrixChatCredentials {
  provider: 'matrix';
  roomId: string;
  accessToken: string;
  serverUrl: string;
  serverName: string;
}

export type ChatCredentials = MatrixChatCredentials;

export interface JanusAudioCredentials {
  provider: 'janus';
  roomId: number;
  wsUrl: string;
}

export interface LivekitAudioCredentials {
  provider: 'livekit';
  room: string;
  url: string;
  token: string;
}

export type AudioCredentials = JanusAudioCredentials | LivekitAudioCredentials;

export interface JanusVideoCredentials {
  provider: 'janus';
  roomId: number;
  wsUrl: string;
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
}

export interface LivekitVideoCredentials {
  provider: 'livekit';
  room: string;
  url: string;
  token: string;
  iceServers?: Array<{ urls: string[]; username?: string; credential?: string }>;
}

export type VideoCredentials = JanusVideoCredentials | LivekitVideoCredentials;

/**
 * Chat session returned by `authorizeUser`.
 *
 * **Legacy flat fields** (`roomId`, `accessToken`, `serverUrl`, `serverName`)
 * are populated for v1 clients. New integrations should consume `credentials`
 * and send the `X-Comms-API-Version: 2` header to suppress the legacy fields.
 */
export interface ChatSession extends CapabilityStatus {
  /** @deprecated use `credentials.roomId` */
  roomId?: string;
  /** @deprecated use `credentials.accessToken` */
  accessToken?: string;
  /** @deprecated use `credentials.serverUrl` */
  serverUrl?: string;
  /** @deprecated use `credentials.serverName` */
  serverName?: string;
  /** Provider-tagged chat credentials (preferred). */
  credentials?: ChatCredentials;
}

/** Audio session returned by `authorizeUser`. */
export interface AudioBridgeSession extends CapabilityStatus {
  /** @deprecated use `credentials.roomId` (provider=janus) */
  roomId?: number;
  /** @deprecated use `credentials.wsUrl` (provider=janus) */
  wsUrl?: string;
  /** Provider-tagged audio credentials (preferred). */
  credentials?: AudioCredentials;
}

/** Video session returned by `authorizeUser`. */
export interface VideoRoomSession extends CapabilityStatus {
  /** @deprecated use `credentials.roomId` (provider=janus) */
  roomId?: number;
  /** @deprecated use `credentials.wsUrl` (provider=janus) */
  wsUrl?: string;
  /** @deprecated use `credentials.iceServers` */
  iceServers?: Array<{ urls: string[]; username?: string; credential?: string }>;
  /** Provider-tagged video credentials (preferred). */
  credentials?: VideoCredentials;
}

/**
 * SIP softphone session info returned by `authorizeUser`.
 *
 * Returned only when `SIP_ENABLED=true` AND the room mode includes an
 * AudioBridge (`IN_PERSON` or `HYBRID`). Consumers hand these values to
 * the user so they can configure a free SIP softphone (Linphone, Zoiper,
 * MicroSIP, Jitsi, Bria) and dial the room URI to join the AudioBridge.
 *
 * Note: this is internal SIP federation — there is no PSTN connectivity.
 */
export interface SipSession extends CapabilityStatus {
  provider?: 'janus' | 'livekit';
  /** SIP username (DIGEST identifier). */
  username?: string;
  /** SIP password (DIGEST credential). Treat as a secret. */
  password?: string;
  /** Full registrar URI, e.g. `sip:comms.local:5060;transport=udp`. */
  registrar?: string;
  /** SIP domain advertised in URIs, e.g. `comms.local`. */
  domain?: string;
  /** Transport — usually `udp`; tcp/tls available where configured. */
  transport?: 'udp' | 'tcp' | 'tls';
  /** Room SIP URI to dial, e.g. `sip:room-<contextId>@comms.local`. */
  roomUri?: string;
  credentials?: {
    provider: 'janus' | 'livekit';
    username: string;
    password: string;
    registrar: string;
    domain: string;
    transport: 'udp' | 'tcp' | 'tls';
    roomUri?: string;
  };
}

/**
 * Unified session response shape returned by `POST /authorize-user`.
 * Each transport capability is present when provisioned for this room mode,
 * or `null` when the mode does not include that transport.
 */
export interface CommunicationsSessionResponse {
  /** Internal communications room UUID. */
  roomId: string;
  /** Current room lifecycle status (PROVISIONED | ACTIVE | CLOSED). */
  status: string;
  /** Matrix chat credentials, or null if chat is not provisioned. */
  chat: ChatSession | null;
  /** Janus AudioBridge credentials, or null for REMOTE-mode rooms. */
  audioBridge: AudioBridgeSession | null;
  /** Janus VideoRoom credentials, or null for IN_PERSON-mode rooms. */
  videoRoom: VideoRoomSession | null;
  /** SIP softphone credentials, or null for rooms without an AudioBridge. */
  sip: SipSession | null;
  /** Always true — room mode cannot be changed after provisioning. */
  modeImmutable: boolean;
}

/**
 * Removes the deprecated flat credential fields (`roomId`, `wsUrl`, etc.)
 * from a session response, leaving only the `credentials` discriminated
 * union. Called from the controller when the client sends
 * `X-Comms-API-Version: 2` or higher.
 *
 * Mutates the passed object and returns it for fluent use. Safe to call on
 * a response that has already been stripped.
 */
export function stripLegacySessionFields(
  session: CommunicationsSessionResponse,
): CommunicationsSessionResponse {
  const stripKeys = <T extends object>(obj: T | null, keys: readonly string[]) => {
    if (!obj) return;
    for (const key of keys) {
      delete (obj as Record<string, unknown>)[key];
    }
  };
  stripKeys(session.chat, ['roomId', 'accessToken', 'serverUrl', 'serverName']);
  stripKeys(session.audioBridge, ['roomId', 'wsUrl']);
  stripKeys(session.videoRoom, ['roomId', 'wsUrl', 'iceServers']);
  return session;
}

/**
 * Core business logic for the communications microservice.
 *
 * Orchestrates:
 * - Room provisioning (Matrix + Janus) via [provision]
 * - Room lifecycle transitions (PROVISIONED → ACTIVE → CLOSED) via [activate] / [close]
 * - User authorization and session credential issuance via [authorizeUser]
 * - Mic and video participant control (mute, unmute, kick) via dedicated methods
 * - Immutable audit logging for every state-changing operation
 *
 * All public methods are called exclusively from [RoomsController] after the
 * [InternalJwtGuard] has verified the service-to-service JWT. Domain-level
 * authorization (e.g. "is this user allowed in this room?") is the
 * responsibility of the calling service — this layer trusts the JWT.
 */
@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  /** Cooldown window (seconds) on the per-user/context authorize hot path. */
  private static readonly AUTHORIZE_COOLDOWN_SECONDS = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly redis: RedisService,
    // Capability providers are injected via DI tokens so alternative
    // implementations (LiveKit, etc.) can be bound in `app.module.ts`
    // without touching this service. `@Optional()` because each provider
    // is gated on its enable flag at module-import time.
    @Optional() @Inject(CHAT_PROVIDER) private readonly chat?: ChatProvider,
    @Optional() @Inject(MEDIA_PROVIDER) private readonly media?: MediaProvider,
    @Optional() private readonly sip?: SipService,
    @Optional() @Inject(SIP_PROVIDER) private readonly sipProvider?: SipProvider,
  ) {}

  // ── Capability availability helpers ────────────────────────────────────────
  //
  // Each helper returns either `null` when the capability is fully usable, or
  // a human-readable reason string when it isn't. The reason distinguishes
  // "disabled" (module not loaded) from "unreachable" (module loaded but the
  // external service is down) so debugging is straightforward.

  private chatUnavailableReason(): string | null {
    if (!this.chat) return 'Chat provider disabled';
    if (!this.chat.isAvailable()) return 'Chat provider unreachable';
    return null;
  }

  private mediaUnavailableReason(): string | null {
    if (!this.media) return 'Media provider disabled';
    if (!this.media.isAvailable()) return 'Media provider unreachable';
    return null;
  }

  private sipUnavailableReason(): string | null {
    if (!this.sip) return 'SIP disabled';
    // When SipBridgeService detected an incompatible media provider at
    // startup, `bridgeStatus()` returns 'incompatible-media' and the
    // bridge has refused to REGISTER. Issuing SIP credentials in that
    // state would be actively misleading — a softphone that registers
    // against Kamailio would land in a Janus AudioBridge that no
    // WebRTC client ever joins. Surface the misconfiguration instead.
    if (
      this.sipProvider &&
      this.sipProvider.bridgeStatus() === 'incompatible-media'
    ) {
      return (
        `SIP incompatible with active media provider: ` +
        `the "${this.sipProvider.id}" SIP bridge cannot route calls ` +
        `into the configured media backend. Fix MEDIA_PROVIDER or ` +
        `disable SIP_ENABLED. See /health for details.`
      );
    }
    return null;
  }

  // ── Provision ──────────────────────────────────────────────────────────────

  async provision(dto: ProvisionRoomDto): Promise<{ roomId: string; status: string }> {
    // Idempotent: return existing room if already provisioned
    const existing = await this.prisma.communicationRoom.findUnique({
      where: {
        appId_contextType_contextId: {
          appId: dto.appId,
          contextType: dto.contextType,
          contextId: dto.contextId,
        },
      },
    });

    if (existing) {
      // Reject mode changes on existing rooms
      if (existing.mode !== dto.mode) {
        throw new ConflictException(
          `Room already provisioned with mode ${existing.mode}. Room mode is immutable.`,
        );
      }
      return { roomId: existing.id, status: existing.status };
    }

    // Provision Matrix room (scoped by appId to avoid cross-app alias collisions).
    // Skipped entirely when Matrix is disabled — `matrixRoomId` stays null and
    // the room provisions chat-less. Subsequent authorizeUser calls report
    // `chat: { status: 'unavailable', reason: 'Matrix disabled' }`.
    const matrixRoomId = this.chat
      ? await this.chat.ensureRoom(dto.appId, dto.contextId, dto.title)
      : null;

    // Provision Janus rooms based on the room's transport mode.
    // CHAT mode skips Janus entirely — Matrix room only.
    // When Janus is disabled, both ids stay null and the corresponding
    // capabilities report unavailable on subsequent authorizeUser calls.
    let audioRoomId: number | null = null;
    let videoRoomId: number | null = null;

    if (this.media && (dto.mode === RoomMode.IN_PERSON || dto.mode === RoomMode.HYBRID)) {
      audioRoomId = await this.media.ensureAudioBridgeRoom(dto.contextId);
    }
    if (this.media && (dto.mode === RoomMode.HYBRID || dto.mode === RoomMode.REMOTE)) {
      videoRoomId = await this.media.ensureVideoRoom(dto.contextId);
    }

    const room = await this.prisma.communicationRoom.create({
      data: {
        appId: dto.appId,
        contextType: dto.contextType,
        contextId: dto.contextId,
        title: dto.title,
        mode: dto.mode,
        matrixRoomId,
        audioRoomId,
        videoRoomId,
      },
    });

    await this.audit(room.id, 'ROOM_PROVISIONED', null, {
      appId: dto.appId,
      contextType: dto.contextType,
      mode: dto.mode,
      matrixAvailable: !!matrixRoomId,
      janusAudioAvailable: !!audioRoomId,
      janusVideoAvailable: !!videoRoomId,
    });

    this.messaging.publish('communications.room.provisioned', {
      roomId: room.id,
      appId: dto.appId,
      contextType: dto.contextType,
      contextId: dto.contextId,
      mode: dto.mode,
      // Legacy alias emitted for backwards compatibility with the first
      // consumer app. Safe to drop once no subscriber still reads it.
      sittingMode: dto.mode,
    });

    return { roomId: room.id, status: room.status };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async activate(
    contextId: string,
    appId: string,
    contextType: string,
  ): Promise<{ roomId: string; status: string }> {
    const room = await this.findRoom(appId, contextType, contextId);

    if (room.status !== 'PROVISIONED') {
      throw new BadRequestException(
        `Cannot activate room in status ${room.status}. Expected PROVISIONED.`,
      );
    }

    const updated = await this.prisma.communicationRoom.update({
      where: { id: room.id },
      data: { status: 'ACTIVE' },
    });

    await this.audit(room.id, 'ROOM_ACTIVATED');

    this.messaging.publish('communications.room.activated', {
      roomId: room.id,
      appId,
      contextType,
      contextId,
    });

    return { roomId: updated.id, status: updated.status };
  }

  async close(
    contextId: string,
    appId: string,
    contextType: string,
  ): Promise<{ roomId: string; status: string }> {
    const room = await this.findRoom(appId, contextType, contextId);

    if (room.status !== 'ACTIVE' && room.status !== 'PROVISIONED') {
      throw new BadRequestException(
        `Cannot close room in status ${room.status}. Expected ACTIVE or PROVISIONED.`,
      );
    }

    // Best-effort cleanup of media rooms (idempotent — LiveKit audio and video
    // may share the same underlying room, so a double-destroy is a no-op).
    if (this.media) {
      if (room.videoRoomId) {
        await this.media.destroyVideoRoom(contextId, room.videoRoomId).catch(() => {});
      }
      if (room.audioRoomId) {
        await this.media.destroyVideoRoom(contextId, room.audioRoomId).catch(() => {});
      }
    }

    // Invalidate all active Matrix sessions for this room so members can't
    // keep reading chat after the domain context ends. Best-effort — a
    // failed logout is logged but doesn't block the close transition.
    await this.logoutRoomMembers(room.id);

    const updated = await this.prisma.communicationRoom.update({
      where: { id: room.id },
      data: { status: 'CLOSED' },
    });

    await this.audit(room.id, 'ROOM_CLOSED');

    this.messaging.publish('communications.room.closed', {
      roomId: room.id,
      appId,
      contextType,
      contextId,
    });

    return { roomId: updated.id, status: updated.status };
  }

  // ── Authorize User ─────────────────────────────────────────────────────────

  async authorizeUser(
    contextId: string,
    dto: AuthorizeUserDto,
  ): Promise<CommunicationsSessionResponse> {
    const room = await this.findRoom(dto.appId, dto.contextType, contextId);

    if (room.status === 'CLOSED' || room.status === 'ARCHIVED') {
      throw new BadRequestException(
        `Room is ${room.status}. Cannot authorize new sessions.`,
      );
    }

    // Cooldown: suppress Matrix-side side effects (inviteAndJoin, displayname
    // PUT) when the same user hits this endpoint within a short window. The
    // Prisma state + session credentials are still returned so the caller
    // gets a valid response — we're just skipping the expensive external work.
    const cooldownKey = `comms:authorize:cooldown:${dto.appId}:${contextId}:${dto.domainUserId}`;
    const fresh = await this.redis.setIfAbsent(
      cooldownKey,
      '1',
      RoomsService.AUTHORIZE_COOLDOWN_SECONDS,
    );
    const skipMatrixSideEffects = !fresh && this.redis.isReady();

    // Ensure communication user exists
    let commUser = await this.prisma.communicationUser.findUnique({
      where: {
        appId_domainUserId: {
          appId: dto.appId,
          domainUserId: dto.domainUserId,
        },
      },
    });

    // Provision (or look up) the Matrix user. Skipped when Matrix is disabled —
    // `matrixResult` stays null and the chat capability later reports unavailable.
    const matrixResult = this.chat
      ? await this.chat.ensureUserToken(
          dto.domainUserId,
          dto.displayName,
          commUser?.matrixPassword ?? null,
        )
      : null;

    if (!commUser) {
      commUser = await this.prisma.communicationUser.create({
        data: {
          appId: dto.appId,
          domainUserId: dto.domainUserId,
          matrixUserId: matrixResult?.matrixUserId ?? null,
          displayName: dto.displayName,
          matrixDisplayName:
            matrixResult && dto.displayName ? dto.displayName : null,
          matrixPassword: matrixResult?.password ?? null,
        },
      });
    } else {
      const updates: Record<string, any> = {};
      if (commUser.displayName !== dto.displayName) {
        updates.displayName = dto.displayName;
      }
      if (matrixResult?.password) {
        // Matrix rotated the password (legacy migration) — persist it.
        updates.matrixPassword = matrixResult.password;
      }
      if (matrixResult && !commUser.matrixUserId) {
        updates.matrixUserId = matrixResult.matrixUserId;
      }
      if (Object.keys(updates).length > 0) {
        commUser = await this.prisma.communicationUser.update({
          where: { id: commUser.id },
          data: updates,
        });
      }
    }

    // Only push the display name to Matrix when it actually changed — this
    // is the main correctness fix for the wasteful setDisplayName-on-every-call
    // issue. Safe to run even during cooldown because it's a no-op when
    // matrixDisplayName already matches.
    if (
      !skipMatrixSideEffects &&
      this.chat &&
      matrixResult &&
      dto.displayName &&
      commUser.matrixDisplayName !== dto.displayName
    ) {
      const ok = await this.chat.updateDisplayName(
        matrixResult.accessToken,
        matrixResult.matrixUserId,
        dto.displayName,
      );
      if (ok) {
        await this.prisma.communicationUser.update({
          where: { id: commUser.id },
          data: { matrixDisplayName: dto.displayName },
        });
      }
    }

    // Provision (or reuse) SIP credentials when SIP is enabled, the bridge
    // is compatible with the active media provider, and the room mode
    // includes an AudioBridge. Mirrors the Matrix credential lifecycle:
    // first call mints a password, subsequent calls return the cached one.
    //
    // When the SIP bridge reported `incompatible-media` at startup, skip
    // credential provisioning entirely — the `sipUnavailableReason()`
    // helper below will surface the misconfiguration to the caller, and
    // we don't want to persist SIP usernames/passwords for a code path
    // that will never successfully bridge a call.
    let sipResult:
      | { provider: 'janus' | 'livekit'; username: string; password: string | null }
      | null = null;
    const roomNeedsAudio =
      room.mode === RoomMode.IN_PERSON || room.mode === RoomMode.HYBRID;
    const sipBridgeUsable =
      !this.sipProvider ||
      this.sipProvider.bridgeStatus() !== 'incompatible-media';
    if (this.sip && sipBridgeUsable && roomNeedsAudio) {
      sipResult = await this.sip.ensureUserCredentials(
        dto.appId,
        dto.domainUserId,
        dto.displayName,
        commUser.sipPassword ?? null,
        commUser.sipUsername ?? null,
      );
      if (sipResult) {
        const sipUpdates: Record<string, any> = {};
        if (!commUser.sipUsername) sipUpdates.sipUsername = sipResult.username;
        if (sipResult.password) sipUpdates.sipPassword = sipResult.password;
        if (commUser.sipDisplayName !== dto.displayName) {
          sipUpdates.sipDisplayName = dto.displayName;
        }
        if (Object.keys(sipUpdates).length > 0) {
          commUser = await this.prisma.communicationUser.update({
            where: { id: commUser.id },
            data: sipUpdates,
          });
        }
      }
    }

    // Check for invalidated session (kicked member trying to reconnect)
    const existingMembership = await this.prisma.communicationMembership.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: commUser.id } },
    });
    if (existingMembership?.leftAt) {
      throw new ForbiddenException('Session invalidated for this context');
    }

    // Ensure membership (idempotent)
    await this.prisma.communicationMembership.upsert({
      where: {
        roomId_userId: { roomId: room.id, userId: commUser.id },
      },
      create: {
        roomId: room.id,
        userId: commUser.id,
        role: dto.roles?.includes(CommunicationRole.MODERATOR) ? 'MODERATOR' : 'PARTICIPANT',
      },
      update: {},
    });

    // Build chat session — null when the room mode has no chat at all,
    // otherwise either available credentials or an unavailable+reason hint.
    let chat: ChatSession | null = null;
    if (room.matrixRoomId) {
      if (this.chat && matrixResult) {
        if (!skipMatrixSideEffects) {
          await this.chat.inviteAndJoin(
            room.matrixRoomId,
            matrixResult.matrixUserId,
            matrixResult.accessToken,
          );
        }
        chat = {
          status: 'available',
          // Legacy flat fields (stripped for v2 clients).
          roomId: room.matrixRoomId,
          accessToken: matrixResult.accessToken,
          serverUrl: this.chat.publicServerUrl,
          serverName: this.chat.serverName,
          // Phase 3 discriminated-union shape.
          credentials: {
            provider: 'matrix',
            roomId: room.matrixRoomId,
            accessToken: matrixResult.accessToken,
            serverUrl: this.chat.publicServerUrl,
            serverName: this.chat.serverName,
          },
        };
      } else {
        chat = {
          status: 'unavailable',
          reason: this.chatUnavailableReason() ?? 'Matrix service unreachable',
        };
      }
    } else if (this.chatUnavailableReason()) {
      // Room was provisioned without a Matrix room (because Matrix was
      // disabled at provision time). Surface the disabled state so the
      // client knows chat is intentionally off.
      chat = { status: 'unavailable', reason: this.chatUnavailableReason()! };
    }

    // Build audioBridge session (CHAT mode has no audio/video)
    let audioBridge: AudioBridgeSession | null = null;
    const mode = room.mode;
    if (mode === 'IN_PERSON' || mode === 'HYBRID') {
      const janusReason = this.mediaUnavailableReason();
      if (this.media && !janusReason) {
        const liveAudioRoomId = await this.media.ensureAudioBridgeRoom(room.contextId, room.audioRoomId);
        if (liveAudioRoomId) {
          if (this.media.createParticipantToken) {
            const token = await this.media.createParticipantToken({
              roomId: liveAudioRoomId,
              identity: dto.domainUserId,
              name: dto.displayName,
              metadata: {
                appId: dto.appId,
                contextId: room.contextId,
                contextType: room.contextType,
                mode: room.mode,
                roles: dto.roles ?? [],
              },
              roomAdmin: !!dto.roles?.includes(CommunicationRole.MODERATOR),
            });
            audioBridge = {
              status: 'available',
              credentials: {
                provider: this.media.id as 'livekit',
                room: this.media.roomNameFor?.(liveAudioRoomId) ?? liveAudioRoomId.toString(),
                url: this.media.wsUrl,
                token: token!,
              },
            };
          } else {
            audioBridge = {
              status: 'available',
              // Legacy flat fields (stripped for v2 clients).
              roomId: liveAudioRoomId,
              wsUrl: this.media.wsUrl,
              // Phase 3 discriminated-union shape.
              credentials: {
                provider: 'janus',
                roomId: liveAudioRoomId,
                wsUrl: this.media.wsUrl,
              },
            };
          }
        } else {
          audioBridge = { status: 'unavailable', reason: 'AudioBridge room could not be provisioned' };
        }
      } else {
        audioBridge = {
          status: 'unavailable',
          reason: janusReason ?? (room.audioRoomId ? 'Media provider unreachable' : 'AudioBridge room not provisioned'),
        };
      }
    }

    // Build videoRoom session
    let videoRoom: VideoRoomSession | null = null;
    if (mode === 'HYBRID' || mode === 'REMOTE') {
      const janusReason = this.mediaUnavailableReason();
      if (this.media && !janusReason) {
        const liveVideoRoomId = await this.media.ensureVideoRoom(room.contextId, room.videoRoomId);
        if (liveVideoRoomId) {
          const iceServers = this.media.buildIceServers();
          if (this.media.createParticipantToken) {
            const token = await this.media.createParticipantToken({
              roomId: liveVideoRoomId,
              identity: dto.domainUserId,
              name: dto.displayName,
              metadata: {
                appId: dto.appId,
                contextId: room.contextId,
                contextType: room.contextType,
                mode: room.mode,
                roles: dto.roles ?? [],
              },
              roomAdmin: !!dto.roles?.includes(CommunicationRole.MODERATOR),
            });
            videoRoom = {
              status: 'available',
              credentials: {
                provider: this.media.id as 'livekit',
                room: this.media.roomNameFor?.(liveVideoRoomId) ?? liveVideoRoomId.toString(),
                url: this.media.wsUrl,
                token: token!,
                iceServers,
              },
            };
          } else {
            videoRoom = {
              status: 'available',
              // Legacy flat fields (stripped for v2 clients).
              roomId: liveVideoRoomId,
              wsUrl: this.media.wsUrl,
              iceServers,
              // Phase 3 discriminated-union shape.
              credentials: {
                provider: 'janus',
                roomId: liveVideoRoomId,
                wsUrl: this.media.wsUrl,
                iceServers,
              },
            };
          }
        } else {
          videoRoom = { status: 'unavailable', reason: 'VideoRoom could not be provisioned' };
        }
      } else {
        videoRoom = {
          status: 'unavailable',
          reason: janusReason ?? (room.videoRoomId ? 'Media provider unreachable' : 'VideoRoom not provisioned'),
        };
      }
    }

    // Build SIP session — only present for rooms that have an AudioBridge
    // (IN_PERSON or HYBRID). REMOTE and CHAT rooms get `sip: null`.
    let sip: SipSession | null = null;
    if (roomNeedsAudio) {
      const sipReason = this.sipUnavailableReason();
      if (this.sip && !sipReason && sipResult) {
        // Pull the persisted credentials. `sipResult.password` is only set
        // when a fresh password was minted on this call; otherwise we read
        // the cached value from the user row we updated above.
        const password = sipResult.password ?? commUser.sipPassword ?? null;
        if (password) {
          const roomTarget =
            this.media?.roomNameFor && audioBridge?.credentials?.provider === 'livekit'
              ? (audioBridge.credentials as LivekitAudioCredentials).room
              : null;
          sip = this.sip.buildSessionDescriptor(
            { username: sipResult.username, password },
            room.contextId,
            roomTarget,
          );
        } else {
          sip = { status: 'unavailable', reason: 'SIP credential provisioning failed' };
        }
      } else {
        sip = {
          status: 'unavailable',
          reason: sipReason ?? 'SIP credential provisioning failed',
        };
      }
    }

    await this.audit(room.id, 'USER_AUTHORIZED', dto.domainUserId, {
      displayName: dto.displayName,
      chatAvailable: chat?.status === 'available',
      audioBridgeAvailable: audioBridge?.status === 'available',
      videoRoomAvailable: videoRoom?.status === 'available',
      sipAvailable: sip?.status === 'available',
    });

    return {
      roomId: room.id,
      status: room.status,
      chat,
      audioBridge,
      videoRoom,
      sip,
      modeImmutable: true,
    };
  }

  // ── Mic Control ───────────────────────────────────────────────────────────

  /**
   * Mute a single participant in the AudioBridge room.
   * Discovers the Janus participant ID by matching display name to domainUserId.
   */
  async muteParticipant(
    contextId: string,
    appId: string,
    contextType: string,
    domainUserId: string,
  ): Promise<{ success: boolean }> {
    const { room, janus } = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    const participantId = await this.resolveParticipantId(janus, room.audioRoomId!, domainUserId);
    await janus.muteParticipant(room.audioRoomId!, participantId);
    await this.audit(room.id, 'MIC_MUTED', domainUserId, { participantId });
    return { success: true };
  }

  /**
   * Unmute a single participant in the AudioBridge room.
   * Discovers the Janus participant ID by matching display name to domainUserId.
   */
  async unmuteParticipant(
    contextId: string,
    appId: string,
    contextType: string,
    domainUserId: string,
  ): Promise<{ success: boolean }> {
    const { room, janus } = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    const participantId = await this.resolveParticipantId(janus, room.audioRoomId!, domainUserId);
    await janus.unmuteParticipant(room.audioRoomId!, participantId);
    await this.audit(room.id, 'MIC_UNMUTED', domainUserId, { participantId });
    return { success: true };
  }

  /**
   * Mute ALL participants in the AudioBridge room.
   * Used for emergency mute, moderator lockdown, and room adjournment.
   */
  async muteRoom(
    contextId: string,
    appId: string,
    contextType: string,
  ): Promise<{ success: boolean }> {
    const { room, janus } = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    await janus.muteRoom(room.audioRoomId!);
    await this.audit(room.id, 'ROOM_MUTED', null, { reason: 'server_initiated' });
    return { success: true };
  }

  /**
   * List all participants in the AudioBridge room with their mute state.
   */
  async listAudioParticipants(
    contextId: string,
    appId: string,
    contextType: string,
  ): Promise<Array<{ id: string | number; display: string; muted: boolean }>> {
    const { room, janus } = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    return janus.listParticipants(room.audioRoomId!);
  }

  // ── Kick ───────────────────────────────────────────────────────────────────

  /**
   * Kick a participant from the AudioBridge room.
   * Resolves the Janus participant ID by display name, then issues the kick.
   */
  async kickAudioParticipant(
    contextId: string,
    appId: string,
    contextType: string,
    domainUserId: string,
  ): Promise<{ success: boolean }> {
    const { room, janus } = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    const participantId = await this.resolveParticipantId(janus, room.audioRoomId!, domainUserId);
    await janus.kickAudioParticipant(room.audioRoomId!, participantId);
    await this.audit(room.id, 'PARTICIPANT_KICKED_AUDIO', domainUserId, { participantId });
    return { success: true };
  }

  /**
   * Kick a participant from the VideoRoom.
   * Resolves the Janus participant ID by display name, then issues the kick.
   */
  async kickVideoParticipant(
    contextId: string,
    appId: string,
    contextType: string,
    domainUserId: string,
  ): Promise<{ success: boolean }> {
    const { room, janus } = await this.findActiveRoomWithVideo(appId, contextType, contextId);
    const participantId = await this.resolveVideoParticipantId(janus, room.videoRoomId!, domainUserId);
    await janus.kickVideoParticipant(room.videoRoomId!, participantId);
    await this.audit(room.id, 'PARTICIPANT_KICKED_VIDEO', domainUserId, { participantId });
    return { success: true };
  }

  // ── Session Invalidation ──────────────────────────────────────────────────

  /**
   * Invalidate a user's session for a room context.
   * Sets `leftAt` on the membership record so authorizeUser rejects reconnection.
   */
  async invalidateUserSession(
    contextId: string,
    appId: string,
    contextType: string,
    domainUserId: string,
  ): Promise<{ success: boolean }> {
    const room = await this.findRoom(appId, contextType, contextId);

    const commUser = await this.prisma.communicationUser.findUnique({
      where: { appId_domainUserId: { appId, domainUserId } },
    });
    if (!commUser) {
      throw new NotFoundException(`Communication user not found for ${domainUserId}`);
    }

    const membership = await this.prisma.communicationMembership.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: commUser.id } },
    });
    if (!membership) {
      throw new NotFoundException(`User ${domainUserId} has no membership in this room`);
    }

    await this.prisma.communicationMembership.update({
      where: { id: membership.id },
      data: { leftAt: new Date() },
    });

    await this.audit(room.id, 'SESSION_INVALIDATED', domainUserId);
    return { success: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Find an ACTIVE room that has a provisioned AudioBridge.
   * Shared by all mic control methods. Returns the room **and a non-null
   * JanusService reference** so call sites don't need to re-check
   * availability or use non-null assertions. Throws a descriptive 503 /
   * 400 when any precondition fails.
   */
  private async findActiveRoomWithAudio(appId: string, contextType: string, contextId: string) {
    const reason = this.mediaUnavailableReason();
    if (reason || !this.media) {
      throw new ServiceUnavailableException(reason ?? 'Janus disabled');
    }
    const room = await this.findRoom(appId, contextType, contextId);
    if (room.status !== 'ACTIVE') {
      throw new BadRequestException(`Room is ${room.status}. Mic control requires ACTIVE room.`);
    }
    if (!room.audioRoomId) {
      throw new BadRequestException('Room has no AudioBridge provisioned.');
    }
    return { room, janus: this.media };
  }

  /**
   * Find an ACTIVE room that has a provisioned VideoRoom.
   * Shared by video kick methods. Returns the room **and a non-null
   * JanusService reference**. Throws a descriptive 503 / 400 when any
   * precondition fails.
   */
  private async findActiveRoomWithVideo(appId: string, contextType: string, contextId: string) {
    const reason = this.mediaUnavailableReason();
    if (reason || !this.media) {
      throw new ServiceUnavailableException(reason ?? 'Janus disabled');
    }
    const room = await this.findRoom(appId, contextType, contextId);
    if (room.status !== 'ACTIVE') {
      throw new BadRequestException(`Room is ${room.status}. Video control requires ACTIVE room.`);
    }
    if (!room.videoRoomId) {
      throw new BadRequestException('Room has no VideoRoom provisioned.');
    }
    return { room, janus: this.media };
  }

  /**
   * Resolve a domain user ID to a Janus AudioBridge participant ID.
   *
   * Display names are expected to follow the convention `DisplayName|domainUserId`
   * (set by the client at join time). The lookup splits on '|' and matches the
   * trailing segment exactly. Falls back to substring match for legacy clients.
   */
  private async resolveParticipantId(
    janus: MediaProvider,
    roomId: number,
    domainUserId: string,
  ): Promise<string | number> {
    const participants = await janus.listParticipants(roomId);

    // Primary: exact match on structured suffix after '|'
    const exactMatch = participants.find((p) => {
      const parts = p.display.split('|');
      return parts.length >= 2 && parts[parts.length - 1] === domainUserId;
    });
    if (exactMatch) {
      this.guardHardwareHandle(exactMatch.display);
      return exactMatch.id;
    }

    // Fallback: substring match for legacy clients (less precise)
    const fuzzyMatch = participants.find((p) => p.display.includes(domainUserId));
    if (fuzzyMatch) {
      this.guardHardwareHandle(fuzzyMatch.display);
      this.logger.warn(
        `Resolved participant ${domainUserId} via fuzzy match in room ${roomId}. ` +
        `Client should set display to "DisplayName|${domainUserId}" for reliable matching.`,
      );
      return fuzzyMatch.id;
    }

    throw new NotFoundException(
      `Participant for user ${domainUserId} not found in AudioBridge room ${roomId}`,
    );
  }

  /**
   * Resolve a domain user ID to a Janus VideoRoom participant ID.
   * Same display name convention as AudioBridge: `DisplayName|domainUserId`.
   */
  private async resolveVideoParticipantId(
    janus: MediaProvider,
    roomId: number,
    domainUserId: string,
  ): Promise<string | number> {
    const participants = await janus.listVideoParticipants(roomId);

    const exactMatch = participants.find((p) => {
      const parts = p.display.split('|');
      return parts.length >= 2 && parts[parts.length - 1] === domainUserId;
    });
    if (exactMatch) {
      this.guardHardwareHandle(exactMatch.display);
      return exactMatch.id;
    }

    const fuzzyMatch = participants.find((p) => p.display.includes(domainUserId));
    if (fuzzyMatch) {
      this.guardHardwareHandle(fuzzyMatch.display);
      this.logger.warn(
        `Resolved video participant ${domainUserId} via fuzzy match in room ${roomId}. ` +
        `Client should set display to "DisplayName|${domainUserId}" for reliable matching.`,
      );
      return fuzzyMatch.id;
    }

    throw new NotFoundException(
      `Participant for user ${domainUserId} not found in VideoRoom ${roomId}`,
    );
  }

  /**
   * Prevents targeting HARDWARE handles (physical room equipment).
   * HARDWARE handles represent embedded microphones/speakers — kicking or
   * muting them would cut audio for the entire physical chamber.
   */
  private guardHardwareHandle(display: string): void {
    if (display.includes('|HARDWARE')) {
      throw new ForbiddenException('Cannot target HARDWARE handle');
    }
  }

  /**
   * Look up a room by its composite key (appId + contextType + contextId).
   * Throws [NotFoundException] when no room exists — callers don't need to
   * null-check the result.
   */
  private async findRoom(appId: string, contextType: string, contextId: string) {
    const room = await this.prisma.communicationRoom.findUnique({
      where: {
        appId_contextType_contextId: { appId, contextType, contextId },
      },
    });
    if (!room) {
      throw new NotFoundException(
        `No communication room found for ${appId}/${contextType}/${contextId}`,
      );
    }
    return room;
  }

  /**
   * Write an immutable audit log entry for a room action.
   *
   * Errors are swallowed with a loud log so a transient DB blip never rolls
   * back the primary operation. The log line includes full context so the row
   * can be reconstructed from application logs if needed.
   *
   * @param roomId     - Internal communications room UUID.
   * @param action     - Audit action key (e.g. "ROOM_PROVISIONED", "MIC_MUTED").
   * @param actorUserId - Domain user ID of the actor, or null for system actions.
   * @param metadata   - Optional arbitrary metadata to store alongside the log entry.
   */
  private async audit(
    roomId: string,
    action: string,
    actorUserId?: string | null,
    metadata?: Record<string, any>,
  ) {
    try {
      await this.prisma.communicationAuditLog.create({
        data: {
          roomId,
          action,
          actorUserId: actorUserId ?? undefined,
          metadata: metadata ?? undefined,
        },
      });
    } catch (err) {
      // Audit is compliance-critical. Log loudly with full context so the
      // row can be reconstructed from logs if the DB write never lands.
      // We still swallow so the caller's primary operation succeeds — this
      // is a deliberate trade-off; the alternative (bubbling) would roll
      // back legitimate room lifecycle transitions on a transient DB blip.
      this.logger.error(
        `AUDIT LOG WRITE FAILED · room=${roomId} action=${action} ` +
          `actor=${actorUserId ?? '-'} metadata=${JSON.stringify(metadata ?? {})} · ${err}`,
      );
    }
  }

  /**
   * Logs out every active Matrix session for the given room. Invoked from
   * [close] so members can't keep reading chat history via their cached
   * Matrix tokens after the domain context ends.
   *
   * No-op when Matrix is disabled — there's nothing to log out of.
   */
  private async logoutRoomMembers(roomId: string): Promise<void> {
    if (!this.chat) return;
    const matrix = this.chat;
    const memberships = await this.prisma.communicationMembership.findMany({
      where: { roomId, leftAt: null },
      include: { user: true },
    });
    await Promise.all(
      memberships.map(async (m) => {
        if (!m.user.domainUserId) return;
        try {
          // Best-effort: we don't have the cached token here, but matrix
          // service owns the cache and will invalidate on logout.
          // Fetch the cached token from Redis and call logoutMember.
          const cachedToken = this.redis.isReady()
            ? await this.redis.get(
                `comms:matrix:token:${m.user.domainUserId}`,
              )
            : null;
          if (cachedToken) {
            await matrix.logoutMember(m.user.domainUserId, cachedToken);
          }
        } catch (err) {
          this.logger.debug(
            `Matrix logout failed for user ${m.user.domainUserId}: ${err}`,
          );
        }
      }),
    );
  }
}
