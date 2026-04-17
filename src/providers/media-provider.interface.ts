// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
/**
 * MediaProvider — backend-agnostic contract for the audio/video transport.
 *
 * Shipped implementations:
 * - `LivekitService` (LiveKit) — default, token-based auth, built-in SFU + mixer.
 * - `JanusService` (Janus Gateway) — opt-in fallback, AudioBridge + VideoRoom plugins.
 *
 * **Room ref type (`number`):** kept as `number` to match the existing DB storage
 * (`CommunicationRoom.audioRoomId` / `videoRoomId` mapped from the original
 * Janus int columns via Prisma `@map`). Providers that use string room names
 * (e.g. LiveKit) cast internally via a hash function.
 *
 * **SIP not included:** SIP bridging lives behind a separate `SipProvider`
 * interface because it is inherently coupled to the media backend's internal
 * RTP plumbing. See `sip-provider.interface.ts`.
 */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface AudioParticipant {
  id: string | number;
  display: string;
  muted: boolean;
}

export interface VideoParticipant {
  id: string | number;
  display: string;
}

export interface MediaProvider {
  /** Stable provider identifier used in the Phase 3 discriminated-union DTO. */
  readonly id: 'janus' | 'livekit' | string;

  /** Public WebSocket URL that clients use to connect to the media backend. */
  readonly wsUrl: string;

  /** Whether the backend is currently reachable. Drives graceful degradation. */
  isAvailable(): boolean;

  /** ICE server list returned to clients so they don't need local config. */
  buildIceServers(): IceServerConfig[];

  // ── Room lifecycle ────────────────────────────────────────────────────────

  /**
   * Idempotently ensures an audio room exists for the given context. When
   * `knownRoomId` is provided (e.g. from the DB), the provider will reconcile
   * the existing room rather than mint a new one. Returns `null` when the
   * backend is unavailable or provisioning fails.
   */
  ensureAudioBridgeRoom(
    contextId: string,
    knownRoomId?: number | null,
  ): Promise<number | null>;

  /** Same as `ensureAudioBridgeRoom`, for the video capability. */
  ensureVideoRoom(
    contextId: string,
    knownRoomId?: number | null,
  ): Promise<number | null>;

  /** Best-effort teardown of a video room. Invoked from `RoomsService.close`. */
  destroyVideoRoom(contextId: string, knownRoomId?: number | null): Promise<void>;

  // ── Mic / participant control ─────────────────────────────────────────────

  listParticipants(roomId: number): Promise<AudioParticipant[]>;
  listVideoParticipants(roomId: number): Promise<VideoParticipant[]>;

  muteParticipant(roomId: number, participantId: string | number): Promise<boolean>;
  unmuteParticipant(roomId: number, participantId: string | number): Promise<boolean>;
  muteRoom(roomId: number): Promise<boolean>;

  kickAudioParticipant(roomId: number, participantId: string | number): Promise<boolean>;
  kickVideoParticipant(roomId: number, participantId: string | number): Promise<boolean>;

  // ── Optional provider-specific methods ──────────────────────────────────

  /**
   * Maps a numeric room ID to the provider's native room name.
   * Falls back to `roomId.toString()` when not implemented (e.g. Janus uses int IDs directly).
   */
  roomNameFor?(roomId: number): string;

  /**
   * Generates a scoped participant access token for the given room.
   * Returns `null` when the provider does not use tokens (e.g. Janus — clients
   * connect via WebSocket with no pre-issued token).
   */
  createParticipantToken?(args: {
    roomId: number;
    identity: string;
    name: string;
    metadata?: Record<string, unknown>;
    roomAdmin?: boolean;
  }): Promise<string | null>;
}
