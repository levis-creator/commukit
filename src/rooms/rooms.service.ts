import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MatrixService } from '../matrix/matrix.service';
import { JanusService } from '../janus/janus.service';
import { MessagingService } from '../messaging/messaging.service';
import { RedisService } from '../redis/redis.service';
import { ProvisionRoomDto, RoomMode } from './dto/provision-room.dto';
import { AuthorizeUserDto } from './dto/authorize-user.dto';

/** Base shape for each capability in a session response. */
export interface CapabilityStatus {
  /** Whether the transport is reachable and usable for this session. */
  status: 'available' | 'unavailable';
  /** Human-readable reason when status is "unavailable". */
  reason?: string;
}

/** Matrix chat session credentials returned by `authorizeUser`. */
export interface ChatSession extends CapabilityStatus {
  /** Matrix room ID (e.g. `!abc123:matrix.server`). */
  roomId?: string;
  /** User-scoped Matrix access token for direct CS-API calls. */
  accessToken?: string;
  /** Public Matrix server URL for client connections. */
  serverUrl?: string;
  /** Matrix server name (home server domain). */
  serverName?: string;
}

/** Janus AudioBridge session info returned by `authorizeUser`. */
export interface AudioBridgeSession extends CapabilityStatus {
  /** Janus AudioBridge room ID. */
  roomId?: number;
  /** WebSocket URL for the Janus Gateway. */
  wsUrl?: string;
}

/** Janus VideoRoom session info returned by `authorizeUser`. */
export interface VideoRoomSession extends CapabilityStatus {
  /** Janus VideoRoom ID. */
  roomId?: number;
  /** WebSocket URL for the Janus Gateway. */
  wsUrl?: string;
  /** ICE server configuration for WebRTC peer connection setup. */
  iceServers?: Array<{ urls: string[]; username?: string; credential?: string }>;
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
  /** Always true — room mode cannot be changed after provisioning. */
  modeImmutable: boolean;
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
 * authorization (e.g. "is this member allowed in this sitting?") is the
 * responsibility of the calling service — this layer trusts the JWT.
 */
@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  /** Cooldown window (seconds) on the per-user/context authorize hot path. */
  private static readonly AUTHORIZE_COOLDOWN_SECONDS = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly matrix: MatrixService,
    private readonly janus: JanusService,
    private readonly messaging: MessagingService,
    private readonly redis: RedisService,
  ) {}

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
    const matrixRoomId = await this.matrix.ensureRoom(
      dto.appId,
      dto.contextId,
      dto.title,
    );

    // Provision Janus rooms based on the room's transport mode.
    // CHAT mode skips Janus entirely — Matrix room only.
    let janusAudioRoomId: number | null = null;
    let janusVideoRoomId: number | null = null;

    if (dto.mode === RoomMode.IN_PERSON || dto.mode === RoomMode.HYBRID) {
      janusAudioRoomId = await this.janus.ensureAudioBridgeRoom(dto.contextId);
    }
    if (dto.mode === RoomMode.HYBRID || dto.mode === RoomMode.REMOTE) {
      janusVideoRoomId = await this.janus.ensureVideoRoom(dto.contextId);
    }

    const room = await this.prisma.communicationRoom.create({
      data: {
        appId: dto.appId,
        contextType: dto.contextType,
        contextId: dto.contextId,
        title: dto.title,
        mode: dto.mode,
        matrixRoomId,
        janusAudioRoomId,
        janusVideoRoomId,
      },
    });

    await this.audit(room.id, 'ROOM_PROVISIONED', null, {
      appId: dto.appId,
      contextType: dto.contextType,
      mode: dto.mode,
      matrixAvailable: !!matrixRoomId,
      janusAudioAvailable: !!janusAudioRoomId,
      janusVideoAvailable: !!janusVideoRoomId,
    });

    this.messaging.publish('communications.room.provisioned', {
      roomId: room.id,
      appId: dto.appId,
      contextType: dto.contextType,
      contextId: dto.contextId,
      mode: dto.mode,
      // Legacy alias for any consumer still reading the old field name.
      // TODO: remove once all consumers migrate to `mode`.
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

    // Best-effort cleanup of Janus VideoRoom
    if (room.janusVideoRoomId) {
      await this.janus.destroyVideoRoom(contextId, room.janusVideoRoomId);
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

    // Provision (or look up) the Matrix user.
    const matrixResult = await this.matrix.ensureUserToken(
      dto.domainUserId,
      dto.displayName,
      commUser?.matrixPassword ?? null,
    );

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
      matrixResult &&
      dto.displayName &&
      commUser.matrixDisplayName !== dto.displayName
    ) {
      const ok = await this.matrix.updateDisplayName(
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
        role: dto.roles?.includes('MODERATOR') ? 'MODERATOR' : 'PARTICIPANT',
      },
      update: {},
    });

    // Build chat session
    let chat: ChatSession | null = null;
    if (room.matrixRoomId) {
      if (matrixResult) {
        if (!skipMatrixSideEffects) {
          await this.matrix.inviteAndJoin(
            room.matrixRoomId,
            matrixResult.matrixUserId,
            matrixResult.accessToken,
          );
        }
        chat = {
          status: 'available',
          roomId: room.matrixRoomId,
          accessToken: matrixResult.accessToken,
          serverUrl: this.matrix.publicServerUrl,
          serverName: this.matrix.serverName,
        };
      } else {
        chat = { status: 'unavailable', reason: 'Matrix service unreachable' };
      }
    }

    // Build audioBridge session (CHAT mode has no audio/video)
    let audioBridge: AudioBridgeSession | null = null;
    const mode = room.mode;
    if (mode === 'IN_PERSON' || mode === 'HYBRID') {
      if (this.janus.isAvailable()) {
        const liveAudioRoomId = await this.janus.ensureAudioBridgeRoom(room.contextId, room.janusAudioRoomId);
        if (liveAudioRoomId) {
          audioBridge = {
            status: 'available',
            roomId: liveAudioRoomId,
            wsUrl: this.janus.wsUrl,
          };
        } else {
          audioBridge = { status: 'unavailable', reason: 'AudioBridge room could not be provisioned' };
        }
      } else {
        audioBridge = {
          status: 'unavailable',
          reason: room.janusAudioRoomId ? 'Janus service unreachable' : 'AudioBridge room not provisioned',
        };
      }
    }

    // Build videoRoom session
    let videoRoom: VideoRoomSession | null = null;
    if (mode === 'HYBRID' || mode === 'REMOTE') {
      if (this.janus.isAvailable()) {
        const liveVideoRoomId = await this.janus.ensureVideoRoom(room.contextId, room.janusVideoRoomId);
        if (liveVideoRoomId) {
          videoRoom = {
            status: 'available',
            roomId: liveVideoRoomId,
            wsUrl: this.janus.wsUrl,
            iceServers: this.janus.buildIceServers(),
          };
        } else {
          videoRoom = { status: 'unavailable', reason: 'VideoRoom could not be provisioned' };
        }
      } else {
        videoRoom = {
          status: 'unavailable',
          reason: room.janusVideoRoomId ? 'Janus service unreachable' : 'VideoRoom not provisioned',
        };
      }
    }

    await this.audit(room.id, 'USER_AUTHORIZED', dto.domainUserId, {
      displayName: dto.displayName,
      chatAvailable: chat?.status === 'available',
      audioBridgeAvailable: audioBridge?.status === 'available',
      videoRoomAvailable: videoRoom?.status === 'available',
    });

    return {
      roomId: room.id,
      status: room.status,
      chat,
      audioBridge,
      videoRoom,
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
    const room = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    const participantId = await this.resolveParticipantId(room.janusAudioRoomId!, domainUserId);
    await this.janus.muteParticipant(room.janusAudioRoomId!, participantId);
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
    const room = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    const participantId = await this.resolveParticipantId(room.janusAudioRoomId!, domainUserId);
    await this.janus.unmuteParticipant(room.janusAudioRoomId!, participantId);
    await this.audit(room.id, 'MIC_UNMUTED', domainUserId, { participantId });
    return { success: true };
  }

  /**
   * Mute ALL participants in the AudioBridge room.
   * Used for emergency mute, voting lockdown, and sitting adjournment.
   */
  async muteRoom(
    contextId: string,
    appId: string,
    contextType: string,
  ): Promise<{ success: boolean }> {
    const room = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    await this.janus.muteRoom(room.janusAudioRoomId!);
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
  ): Promise<Array<{ id: number; display: string; muted: boolean }>> {
    const room = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    return this.janus.listParticipants(room.janusAudioRoomId!);
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
    const room = await this.findActiveRoomWithAudio(appId, contextType, contextId);
    const participantId = await this.resolveParticipantId(room.janusAudioRoomId!, domainUserId);
    await this.janus.kickAudioParticipant(room.janusAudioRoomId!, participantId);
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
    const room = await this.findActiveRoomWithVideo(appId, contextType, contextId);
    const participantId = await this.resolveVideoParticipantId(room.janusVideoRoomId!, domainUserId);
    await this.janus.kickVideoParticipant(room.janusVideoRoomId!, participantId);
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
   * Shared by all mic control methods.
   */
  private async findActiveRoomWithAudio(appId: string, contextType: string, contextId: string) {
    const room = await this.findRoom(appId, contextType, contextId);
    if (room.status !== 'ACTIVE') {
      throw new BadRequestException(`Room is ${room.status}. Mic control requires ACTIVE room.`);
    }
    if (!room.janusAudioRoomId) {
      throw new BadRequestException('Room has no AudioBridge provisioned.');
    }
    if (!this.janus.isAvailable()) {
      throw new BadRequestException('Janus Gateway is unavailable.');
    }
    return room;
  }

  /**
   * Find an ACTIVE room that has a provisioned VideoRoom.
   * Shared by video kick methods.
   */
  private async findActiveRoomWithVideo(appId: string, contextType: string, contextId: string) {
    const room = await this.findRoom(appId, contextType, contextId);
    if (room.status !== 'ACTIVE') {
      throw new BadRequestException(`Room is ${room.status}. Video control requires ACTIVE room.`);
    }
    if (!room.janusVideoRoomId) {
      throw new BadRequestException('Room has no VideoRoom provisioned.');
    }
    if (!this.janus.isAvailable()) {
      throw new BadRequestException('Janus Gateway is unavailable.');
    }
    return room;
  }

  /**
   * Resolve a domain user ID to a Janus AudioBridge participant ID.
   *
   * Display names are expected to follow the convention `DisplayName|domainUserId`
   * (set by the client at join time). The lookup splits on '|' and matches the
   * trailing segment exactly. Falls back to substring match for legacy clients.
   */
  private async resolveParticipantId(roomId: number, domainUserId: string): Promise<number> {
    const participants = await this.janus.listParticipants(roomId);

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
  private async resolveVideoParticipantId(roomId: number, domainUserId: string): Promise<number> {
    const participants = await this.janus.listVideoParticipants(roomId);

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
   */
  private async logoutRoomMembers(roomId: string): Promise<void> {
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
            await this.matrix.logoutMember(m.user.domainUserId, cachedToken);
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
