// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InternalJwtGuard } from '../auth/internal-jwt.guard';
import { RoomsService, stripLegacySessionFields } from './rooms.service';
import { ProvisionRoomDto } from './dto/provision-room.dto';
import { RoomLifecycleDto } from './dto/room-lifecycle.dto';
import { MicControlDto } from './dto/mic-control.dto';
import { AuthorizeUserDto } from './dto/authorize-user.dto';

/** Request header consumers send to opt in to the v2 session response shape. */
const API_VERSION_HEADER = 'x-comms-api-version';

/**
 * Parses the `X-Comms-API-Version` header. Missing, empty, `0`, or `1`
 * values → legacy (v1) shape. Anything ≥ 2 → strip legacy fields.
 */
function isV2OrHigher(header: string | undefined): boolean {
  if (!header) return false;
  const parsed = parseInt(header, 10);
  return Number.isFinite(parsed) && parsed >= 2;
}

/**
 * Internal API endpoints for communications room management.
 * All routes are guarded by InternalJwtGuard (service-to-service auth).
 */
@ApiTags('Rooms')
@ApiBearerAuth('internal-jwt')
@Controller('internal/v1/rooms')
@UseGuards(InternalJwtGuard)
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  /**
   * Idempotently provisions a communications room for a domain context.
   */
  @Post('provision')
  @ApiOperation({
    summary: 'Provision a communications room',
    description:
      'Idempotently creates a Matrix chat room and the appropriate Janus audio/video ' +
      'rooms based on the specified mode. Safe to call multiple times — returns the ' +
      'existing room if already provisioned. Rejects mode changes on existing rooms.',
  })
  @ApiResponse({ status: 201, description: 'Room provisioned (or already existed). Returns roomId and status.' })
  @ApiResponse({ status: 400, description: 'Validation error on request body.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid internal service JWT.' })
  @ApiResponse({ status: 409, description: 'Room already exists with a different mode (mode is immutable).' })
  async provision(@Body() dto: ProvisionRoomDto) {
    return this.roomsService.provision(dto);
  }

  /**
   * Marks a room as ACTIVE when the domain session starts.
   */
  @Post(':contextId/activate')
  @ApiOperation({
    summary: 'Activate a provisioned room',
    description:
      'Transitions a room from PROVISIONED → ACTIVE. Call this when the ' +
      'domain entity (meeting, session, conversation, etc.) formally begins. ' +
      'Publishes a `communications.room.activated` event on RabbitMQ.',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiResponse({ status: 201, description: 'Room is now ACTIVE.' })
  @ApiResponse({ status: 400, description: 'Room is not in PROVISIONED state.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid internal service JWT.' })
  @ApiResponse({ status: 404, description: 'No room found for the given appId/contextType/contextId.' })
  async activate(
    @Param('contextId') contextId: string,
    @Body() dto: RoomLifecycleDto,
  ) {
    return this.roomsService.activate(contextId, dto.appId, dto.contextType);
  }

  /**
   * Marks a room as CLOSED when the domain session ends.
   */
  @Post(':contextId/close')
  @ApiOperation({
    summary: 'Close an active room',
    description:
      'Transitions a room to CLOSED. Destroys the Janus VideoRoom, best-effort ' +
      'logs out all Matrix sessions so members cannot continue reading chat, and ' +
      'publishes a `communications.room.closed` event.',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiResponse({ status: 201, description: 'Room is now CLOSED.' })
  @ApiResponse({ status: 400, description: 'Room is already CLOSED or ARCHIVED.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid internal service JWT.' })
  @ApiResponse({ status: 404, description: 'No room found for the given appId/contextType/contextId.' })
  async close(
    @Param('contextId') contextId: string,
    @Body() dto: RoomLifecycleDto,
  ) {
    return this.roomsService.close(contextId, dto.appId, dto.contextType);
  }

  /**
   * Authorizes a user for a room and returns session credentials.
   * The calling service must have already verified domain-level permissions.
   */
  @Post(':contextId/authorize-user')
  @ApiOperation({
    summary: 'Authorize a user and return session credentials',
    description:
      "Provisions (or looks up) the user's Matrix identity, adds them to the " +
      'Matrix room, and returns scoped access tokens for chat, audio, and video. ' +
      'A 10-second per-user cooldown suppresses duplicate Matrix side-effects on ' +
      'rapid re-connection. The caller must validate domain-level permissions ' +
      'before invoking this endpoint.',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiResponse({
    status: 201,
    description:
      'Session credentials returned. Each capability (chat, audioBridge, videoRoom) ' +
      'has a `status` field ("available" | "unavailable") for graceful degradation.',
  })
  @ApiResponse({ status: 400, description: 'Room is CLOSED or ARCHIVED.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid internal service JWT.' })
  @ApiResponse({ status: 403, description: 'User session was previously invalidated (kicked).' })
  @ApiResponse({ status: 404, description: 'No room found for the given appId/contextType/contextId.' })
  async authorizeUser(
    @Param('contextId') contextId: string,
    @Body() dto: AuthorizeUserDto,
    @Headers(API_VERSION_HEADER) apiVersionHeader?: string,
  ) {
    const session = await this.roomsService.authorizeUser(contextId, dto);
    if (isV2OrHigher(apiVersionHeader)) {
      stripLegacySessionFields(session);
    }
    return session;
  }

  // Chat history proxy removed — clients paginate directly against Matrix
  // using the user-scoped access token returned from /authorize-user.

  // ── Kick ───────────────────────────────────────────────────────────────────

  /**
   * Kick a participant from the AudioBridge room.
   */
  @Post(':contextId/kick-audio')
  @ApiOperation({
    summary: 'Kick a participant from the AudioBridge',
    description:
      'Resolves the Janus participant by matching the display name convention ' +
      '`DisplayName|domainUserId`, then issues a kick. Cannot target HARDWARE handles ' +
      '(physical room equipment).',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiResponse({ status: 201, description: 'Participant kicked. Returns `{ success: true }`.' })
  @ApiResponse({ status: 400, description: 'Room is not ACTIVE, has no AudioBridge, or Janus is unreachable.' })
  @ApiResponse({ status: 403, description: 'Attempted to target a HARDWARE handle.' })
  @ApiResponse({ status: 404, description: 'Participant not found in AudioBridge room.' })
  async kickAudioParticipant(
    @Param('contextId') contextId: string,
    @Body() dto: MicControlDto,
  ) {
    return this.roomsService.kickAudioParticipant(
      contextId,
      dto.appId,
      dto.contextType,
      dto.domainUserId,
    );
  }

  /**
   * Kick a participant from the VideoRoom.
   */
  @Post(':contextId/kick-video')
  @ApiOperation({
    summary: 'Kick a participant from the VideoRoom',
    description:
      'Resolves the Janus video participant by display name convention ' +
      '`DisplayName|domainUserId`, then issues a kick. Cannot target HARDWARE handles.',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiResponse({ status: 201, description: 'Participant kicked. Returns `{ success: true }`.' })
  @ApiResponse({ status: 400, description: 'Room is not ACTIVE, has no VideoRoom, or Janus is unreachable.' })
  @ApiResponse({ status: 403, description: 'Attempted to target a HARDWARE handle.' })
  @ApiResponse({ status: 404, description: 'Participant not found in VideoRoom.' })
  async kickVideoParticipant(
    @Param('contextId') contextId: string,
    @Body() dto: MicControlDto,
  ) {
    return this.roomsService.kickVideoParticipant(
      contextId,
      dto.appId,
      dto.contextType,
      dto.domainUserId,
    );
  }

  /**
   * Invalidate a user's session for a room context.
   * Prevents the user from re-authorizing (reconnecting) to this room.
   */
  @Post(':contextId/invalidate-session')
  @ApiOperation({
    summary: 'Invalidate a user session',
    description:
      "Sets `leftAt` on the user's membership record. Any subsequent call to " +
      '`/authorize-user` for this user in this context will return 403. ' +
      'Used when a participant is removed from a session (e.g. ejected by a moderator).',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiResponse({ status: 201, description: 'Session invalidated. Returns `{ success: true }`.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid internal service JWT.' })
  @ApiResponse({ status: 404, description: 'User or membership not found.' })
  async invalidateSession(
    @Param('contextId') contextId: string,
    @Body() dto: MicControlDto,
  ) {
    return this.roomsService.invalidateUserSession(
      contextId,
      dto.appId,
      dto.contextType,
      dto.domainUserId,
    );
  }

  // ── Mic Control ───────────────────────────────────────────────────────────

  /**
   * Mute a single participant in the AudioBridge room.
   */
  @Post(':contextId/mute')
  @ApiOperation({
    summary: 'Mute a participant in the AudioBridge',
    description:
      'Resolves the participant by display name and issues a server-side mute ' +
      'via Janus. Cannot target HARDWARE handles.',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiResponse({ status: 201, description: 'Participant muted. Returns `{ success: true }`.' })
  @ApiResponse({ status: 400, description: 'Room is not ACTIVE or has no AudioBridge.' })
  @ApiResponse({ status: 403, description: 'Attempted to target a HARDWARE handle.' })
  @ApiResponse({ status: 404, description: 'Participant not found in AudioBridge room.' })
  async muteParticipant(
    @Param('contextId') contextId: string,
    @Body() dto: MicControlDto,
  ) {
    return this.roomsService.muteParticipant(
      contextId,
      dto.appId,
      dto.contextType,
      dto.domainUserId,
    );
  }

  /**
   * Unmute a single participant in the AudioBridge room.
   */
  @Post(':contextId/unmute')
  @ApiOperation({
    summary: 'Unmute a participant in the AudioBridge',
    description:
      'Resolves the participant by display name and lifts the server-side mute ' +
      'via Janus. Cannot target HARDWARE handles.',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiResponse({ status: 201, description: 'Participant unmuted. Returns `{ success: true }`.' })
  @ApiResponse({ status: 400, description: 'Room is not ACTIVE or has no AudioBridge.' })
  @ApiResponse({ status: 403, description: 'Attempted to target a HARDWARE handle.' })
  @ApiResponse({ status: 404, description: 'Participant not found in AudioBridge room.' })
  async unmuteParticipant(
    @Param('contextId') contextId: string,
    @Body() dto: MicControlDto,
  ) {
    return this.roomsService.unmuteParticipant(
      contextId,
      dto.appId,
      dto.contextType,
      dto.domainUserId,
    );
  }

  /**
   * Mute ALL participants in the AudioBridge room.
   */
  @Post(':contextId/mute-room')
  @ApiOperation({
    summary: 'Mute all participants in the AudioBridge',
    description:
      'Applies a server-side mute to every participant in the AudioBridge room. ' +
      'Used for emergency mute, moderator lockdown, and room adjournment.',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiResponse({ status: 201, description: 'All participants muted. Returns `{ success: true }`.' })
  @ApiResponse({ status: 400, description: 'Room is not ACTIVE or has no AudioBridge.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid internal service JWT.' })
  async muteRoom(
    @Param('contextId') contextId: string,
    @Body() dto: RoomLifecycleDto,
  ) {
    return this.roomsService.muteRoom(contextId, dto.appId, dto.contextType);
  }

  /**
   * List all participants in the AudioBridge room with their mute state.
   */
  @Get(':contextId/participants')
  @ApiOperation({
    summary: 'List AudioBridge participants',
    description: 'Returns all current participants in the AudioBridge room with their Janus ID, display name, and mute state.',
  })
  @ApiParam({ name: 'contextId', description: 'The domain entity ID used when provisioning the room.' })
  @ApiQuery({ name: 'appId', description: 'Consumer application identifier.' })
  @ApiQuery({ name: 'contextType', description: 'Domain entity type (e.g. "meeting").' })
  @ApiResponse({
    status: 200,
    description: 'Array of participants: `[{ id: number, display: string, muted: boolean }]`.',
  })
  @ApiResponse({ status: 400, description: 'Room is not ACTIVE or has no AudioBridge.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid internal service JWT.' })
  async listParticipants(
    @Param('contextId') contextId: string,
    @Query('appId') appId: string,
    @Query('contextType') contextType: string,
  ) {
    return this.roomsService.listAudioParticipants(contextId, appId, contextType);
  }
}
