/**
 * MediaProvider — backend-agnostic contract for the audio/video transport.
 *
 * Implemented today by `JanusService` (Janus Gateway). A future `LivekitService`
 * or `JitsiService` can implement the same contract without any changes in
 * `RoomsService` or its callers.
 *
 * **Room ref type (`number`):** kept as `number` in Phase 1 to match the existing
 * Janus storage (int rooms on `CommunicationRoom.janusAudioRoomId` /
 * `janusVideoRoomId`). The Phase 4 schema rename switches persistence to a
 * neutral string column; at that point this interface generalizes to `string`
 * and the Janus impl casts internally.
 *
 * **SIP not included:** SIP plugin operations stay on `JanusService` as
 * vendor-specific helpers because the SIP bridge is inherently Janus-only
 * (Kamailio → Janus SIP plugin → AudioBridge). See `sip-bridge.service.ts`.
 */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface AudioParticipant {
  id: number;
  display: string;
  muted: boolean;
}

export interface VideoParticipant {
  id: number;
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

  muteParticipant(roomId: number, participantId: number): Promise<boolean>;
  unmuteParticipant(roomId: number, participantId: number): Promise<boolean>;
  muteRoom(roomId: number): Promise<boolean>;

  kickAudioParticipant(roomId: number, participantId: number): Promise<boolean>;
  kickVideoParticipant(roomId: number, participantId: number): Promise<boolean>;
}
