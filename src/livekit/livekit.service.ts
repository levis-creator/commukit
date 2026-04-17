// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { RedisService } from '../redis/redis.service';
import type {
  AudioParticipant,
  IceServerConfig,
  MediaProvider,
  VideoParticipant,
} from '../providers/media-provider.interface';

interface LivekitTrackInfo {
  sid?: string;
  type?: string;
  muted?: boolean;
}

interface LivekitParticipantInfo {
  identity?: string;
  name?: string;
  tracks?: LivekitTrackInfo[];
}

@Injectable()
export class LivekitService implements MediaProvider, OnModuleInit, OnModuleDestroy {
  readonly id = 'livekit' as const;

  private readonly logger = new Logger(LivekitService.name);
  readonly wsUrl: string;

  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private available = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly redis: RedisService) {
    this.wsUrl =
      process.env.LIVEKIT_PUBLIC_URL ??
      process.env.LIVEKIT_URL ??
      'ws://localhost:7880';
    this.apiUrl = this.normalizeApiUrl(
      process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
    );
    this.apiKey = process.env.LIVEKIT_API_KEY ?? '';
    this.apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
  }

  async onModuleInit() {
    await this.tryConnect();
    this.healthTimer = setInterval(() => {
      void this.tryConnect();
    }, 30_000);
  }

  onModuleDestroy() {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  isAvailable(): boolean {
    return this.available;
  }

  buildIceServers(): IceServerConfig[] {
    const iceServersRaw =
      process.env.LIVEKIT_ICE_SERVERS ??
      process.env.JANUS_ICE_SERVERS ??
      'stun:stun.l.google.com:19302';
    const turnUsername =
      process.env.LIVEKIT_TURN_USERNAME ?? process.env.JANUS_TURN_USERNAME ?? '';
    const turnCredential =
      process.env.LIVEKIT_TURN_CREDENTIAL ??
      process.env.JANUS_TURN_CREDENTIAL ??
      '';

    const urls = iceServersRaw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const stunUrls = urls.filter((value) => value.startsWith('stun:'));
    const turnUrls = urls.filter((value) => value.startsWith('turn:'));

    const servers: IceServerConfig[] = [];
    if (stunUrls.length > 0) {
      servers.push({ urls: stunUrls });
    }
    if (turnUrls.length > 0 && turnUsername && turnCredential) {
      servers.push({
        urls: turnUrls,
        username: turnUsername,
        credential: turnCredential,
      });
    }

    return servers;
  }

  async ensureAudioBridgeRoom(
    contextId: string,
    knownRoomId?: number | null,
  ): Promise<number | null> {
    return this.ensureRoom(contextId, knownRoomId);
  }

  async ensureVideoRoom(
    contextId: string,
    knownRoomId?: number | null,
  ): Promise<number | null> {
    return this.ensureRoom(contextId, knownRoomId);
  }

  async destroyVideoRoom(
    contextId: string,
    knownRoomId?: number | null,
  ): Promise<void> {
    if (!this.available) return;

    const roomId =
      knownRoomId && knownRoomId > 0
        ? knownRoomId
        : this.contextIdToRoomId(contextId);
    await this.callTwirp('DeleteRoom', { room: this.roomNameFor(roomId) }).catch(
      (err) => {
        this.logger.warn(`Failed to destroy LiveKit room ${roomId}: ${err}`);
      },
    );
    if (this.redis.isReady()) {
      await this.redis.del(this.cacheKey(contextId));
    }
  }

  async listParticipants(roomId: number): Promise<AudioParticipant[]> {
    const participants = await this.listRoomParticipants(roomId);
    return participants.map((participant) => ({
      id: participant.identity ?? '',
      display: participant.name ?? participant.identity ?? '',
      muted: this.isParticipantAudioMuted(participant),
    }));
  }

  async listVideoParticipants(roomId: number): Promise<VideoParticipant[]> {
    const participants = await this.listRoomParticipants(roomId);
    return participants.map((participant) => ({
      id: participant.identity ?? '',
      display: participant.name ?? participant.identity ?? '',
    }));
  }

  async muteParticipant(
    roomId: number,
    participantId: string | number,
  ): Promise<boolean> {
    return this.setParticipantAudioMuted(roomId, participantId, true);
  }

  async unmuteParticipant(
    roomId: number,
    participantId: string | number,
  ): Promise<boolean> {
    return this.setParticipantAudioMuted(roomId, participantId, false);
  }

  async muteRoom(roomId: number): Promise<boolean> {
    const participants = await this.listRoomParticipants(roomId);
    for (const participant of participants) {
      if (participant.identity) {
        await this.setParticipantAudioMuted(roomId, participant.identity, true);
      }
    }
    return true;
  }

  async kickAudioParticipant(
    roomId: number,
    participantId: string | number,
  ): Promise<boolean> {
    await this.removeParticipant(roomId, participantId);
    return true;
  }

  async kickVideoParticipant(
    roomId: number,
    participantId: string | number,
  ): Promise<boolean> {
    await this.removeParticipant(roomId, participantId);
    return true;
  }

  async createParticipantToken(args: {
    roomId: number;
    identity: string;
    name: string;
    metadata?: Record<string, unknown>;
    roomAdmin?: boolean;
  }): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return sign(
      {
        iss: this.apiKey,
        sub: args.identity,
        nbf: nowSeconds - 10,
        exp: nowSeconds + 15 * 60,
        name: args.name,
        metadata: args.metadata ? JSON.stringify(args.metadata) : undefined,
        video: {
          room: this.roomNameFor(args.roomId),
          roomJoin: true,
          roomAdmin: !!args.roomAdmin,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
        },
      },
      this.apiSecret,
      { algorithm: 'HS256', jwtid: this.tx() },
    );
  }

  roomNameFor(roomId: number): string {
    return `comms-${roomId}`;
  }

  private async ensureRoom(
    contextId: string,
    knownRoomId?: number | null,
  ): Promise<number | null> {
    if (!this.available) return null;

    const cacheKey = this.cacheKey(contextId);
    if (this.redis.isReady()) {
      const cached = await this.redis.get(cacheKey);
      if (cached) return Number(cached);
    }

    const roomId =
      knownRoomId && knownRoomId > 0
        ? knownRoomId
        : this.contextIdToRoomId(contextId);

    try {
      await this.callTwirp('CreateRoom', {
        name: this.roomNameFor(roomId),
        emptyTimeout: Number(process.env.LIVEKIT_EMPTY_TIMEOUT ?? '300'),
        maxParticipants: Number(process.env.LIVEKIT_MAX_PARTICIPANTS ?? '200'),
      });
      if (this.redis.isReady()) {
        await this.redis.set(cacheKey, String(roomId));
      }
      return roomId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('already exists')) {
        this.logger.error(`Failed to ensure LiveKit room for ${contextId}: ${message}`);
        return null;
      }
      if (this.redis.isReady()) {
        await this.redis.set(cacheKey, String(roomId));
      }
      return roomId;
    }
  }

  private async listRoomParticipants(
    roomId: number,
  ): Promise<LivekitParticipantInfo[]> {
    if (!this.available) return [];
    const response = await this.callTwirp('ListParticipants', {
      room: this.roomNameFor(roomId),
    }).catch(() => ({ participants: [] }));
    return Array.isArray(response?.participants) ? response.participants : [];
  }

  private async setParticipantAudioMuted(
    roomId: number,
    participantId: string | number,
    muted: boolean,
  ): Promise<boolean> {
    if (!this.available) throw new Error('LiveKit unavailable');

    const identity = String(participantId);
    const participants = await this.listRoomParticipants(roomId);
    const participant = participants.find((entry) => entry.identity === identity);
    if (!participant?.identity) {
      throw new Error(`LiveKit participant ${identity} not found in room ${roomId}`);
    }

    const audioTracks = (participant.tracks ?? []).filter((track) =>
      this.isAudioTrack(track),
    );
    for (const track of audioTracks) {
      if (!track.sid) continue;
      await this.callTwirp('MutePublishedTrack', {
        room: this.roomNameFor(roomId),
        identity: participant.identity,
        trackSid: track.sid,
        muted,
      });
    }
    return true;
  }

  private async removeParticipant(
    roomId: number,
    participantId: string | number,
  ): Promise<void> {
    if (!this.available) throw new Error('LiveKit unavailable');
    await this.callTwirp('RemoveParticipant', {
      room: this.roomNameFor(roomId),
      identity: String(participantId),
    });
  }

  private isParticipantAudioMuted(participant: LivekitParticipantInfo): boolean {
    const audioTracks = (participant.tracks ?? []).filter((track) =>
      this.isAudioTrack(track),
    );
    return audioTracks.length > 0 && audioTracks.every((track) => !!track.muted);
  }

  private isAudioTrack(track: LivekitTrackInfo): boolean {
    return (track.type ?? '').toUpperCase() === 'AUDIO';
  }

  private async tryConnect(): Promise<void> {
    if (!this.apiKey || !this.apiSecret) {
      if (this.available) {
        this.available = false;
      }
      this.logger.warn(
        'LiveKit credentials not configured. Media capability will report unavailable.',
      );
      return;
    }

    try {
      await this.callTwirp('ListRooms', {});
      if (!this.available) {
        this.available = true;
        this.logger.log(`LiveKit connected at ${this.apiUrl}`);
      }
    } catch {
      if (this.available) {
        this.available = false;
        this.logger.warn(`LiveKit unreachable at ${this.apiUrl}. Calls will be disabled.`);
      }
    }
  }

  private normalizeApiUrl(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch {
      return rawUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '');
    }
  }

  private async callTwirp(method: string, body: Record<string, unknown>): Promise<any> {
    const response = await fetch(
      `${this.apiUrl}/twirp/livekit.RoomService/${method}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.createServerToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LiveKit ${method} failed (${response.status}): ${text}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private async createServerToken(): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return sign(
      {
        iss: this.apiKey,
        nbf: nowSeconds - 10,
        exp: nowSeconds + 60,
        video: {
          roomCreate: true,
          roomList: true,
          roomAdmin: true,
        },
        sip: {
          admin: true,
          call: true,
        },
      },
      this.apiSecret,
      { algorithm: 'HS256', jwtid: this.tx() },
    );
  }

  private contextIdToRoomId(input: string): number {
    let h = 5381;
    for (let i = 0; i < input.length; i += 1) {
      h = (h * 33) ^ input.charCodeAt(i);
    }
    const roomId = (h >>> 0) & 0x7fffffff;
    return roomId === 0 ? 1 : roomId;
  }

  private cacheKey(contextId: string): string {
    return `comms:livekit:room:${contextId}`;
  }

  private tx(): string {
    return `livekit_${Math.random().toString(36).slice(2, 10)}`;
  }
}
