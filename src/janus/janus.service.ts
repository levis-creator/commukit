// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import type { MediaProvider } from '../providers/media-provider.interface';

/**
 * JanusService — Janus Gateway implementation of the `MediaProvider` contract.
 *
 * Owns Janus Gateway AudioBridge + VideoRoom provisioning for the communications
 * layer. Provides idempotent room creation, health monitoring, and ICE server
 * config.
 *
 * Transport mapping (based on the room's mode):
 *   IN_PERSON → AudioBridge only
 *   HYBRID    → AudioBridge + VideoRoom
 *   REMOTE    → VideoRoom only
 *
 * **SIP plugin helpers** (below) are intentionally NOT part of `MediaProvider` —
 * SIP is Janus-specific and consumed directly by `SipBridgeService`.
 */
@Injectable()
export class JanusService implements MediaProvider, OnModuleInit, OnModuleDestroy {
  readonly id = 'janus' as const;

  private readonly logger = new Logger(JanusService.name);

  private readonly httpUrl: string;
  readonly wsUrl: string;

  private readonly roomCache = new Map<string, number>();
  private available = false;
  private janusVersion = '';
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly redis: RedisService) {
    this.httpUrl = this.normalizeHttpUrl(
      process.env.JANUS_HTTP_URL ?? 'http://localhost:8088/janus',
    );
    this.wsUrl =
      process.env.JANUS_PUBLIC_WS_URL ?? process.env.JANUS_WS_URL ?? 'ws://localhost:8188';
  }

  async onModuleInit() {
    await this.tryConnect();
    this.healthTimer = setInterval(() => this.tryConnect(), 30_000);
  }

  onModuleDestroy() {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Builds ICE server list from environment variables.
   * Included in the session response so clients don't need local config.
   */
  buildIceServers(): Array<{ urls: string[]; username?: string; credential?: string }> {
    const iceServersRaw = process.env.JANUS_ICE_SERVERS ?? 'stun:stun.l.google.com:19302';
    const turnUsername = process.env.JANUS_TURN_USERNAME ?? '';
    const turnCredential = process.env.JANUS_TURN_CREDENTIAL ?? '';

    const servers: Array<{ urls: string[]; username?: string; credential?: string }> = [];

    const urls = iceServersRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const stunUrls = urls.filter((u) => u.startsWith('stun:'));
    const turnUrls = urls.filter((u) => u.startsWith('turn:'));

    if (stunUrls.length > 0) {
      servers.push({ urls: stunUrls });
    }
    if (turnUrls.length > 0 && turnUsername && turnCredential) {
      servers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
    }

    return servers;
  }

  // ── AudioBridge ────────────────────────────────────────────────────────────

  async ensureAudioBridgeRoom(contextId: string, knownRoomId?: number | null): Promise<number | null> {
    if (!this.available) return null;

    const cacheKey = `comms:janus:audio:${this.janusVersion}:${contextId}`;

    if (this.redis.isReady()) {
      const cached = await this.redis.get(cacheKey);
      if (cached) return Number(cached);
    }

    if (this.roomCache.has(`audio:${contextId}`)) {
      return this.roomCache.get(`audio:${contextId}`)!;
    }

    const roomId = knownRoomId && knownRoomId > 0 ? knownRoomId : this.contextIdToRoomId(contextId);
    try {
      await this.withPluginHandle('janus.plugin.audiobridge', async (sessionId, handleId) => {
        const createRes = await this.httpPost(`/${sessionId}/${handleId}`, {
          janus: 'message',
          transaction: this.tx(),
          body: {
            request: 'create',
            room: roomId,
            description: `Communications audio room ${roomId}`,
            audiocodec: 'opus',
            is_private: false,
            record: false,
            permanent: false,
          },
        });
        const result = createRes?.plugindata?.data;
        if (result?.audiobridge === 'created') {
          this.logger.log(`Janus AudioBridge room ${roomId} created`);
        } else if (result?.error_code === 486) {
          this.logger.debug(`Janus AudioBridge room ${roomId} already exists`);
        } else {
          throw new Error(`Unexpected AudioBridge create response: ${JSON.stringify(result)}`);
        }
      });

      this.roomCache.set(`audio:${contextId}`, roomId);
      if (this.redis.isReady()) {
        await this.redis.set(cacheKey, String(roomId));
      }
      return roomId;
    } catch (err) {
      this.logger.error(`Failed to ensure AudioBridge room for ${contextId}: ${err}`);
      return null;
    }
  }

  // ── VideoRoom ──────────────────────────────────────────────────────────────

  async ensureVideoRoom(contextId: string, knownRoomId?: number | null): Promise<number | null> {
    if (!this.available) return null;

    const cacheKey = `comms:janus:video:${this.janusVersion}:${contextId}`;

    if (this.redis.isReady()) {
      const cached = await this.redis.get(cacheKey);
      if (cached) return Number(cached);
    }

    const roomId = knownRoomId && knownRoomId > 0 ? knownRoomId : this.contextIdToRoomId(contextId);
    try {
      await this.withPluginHandle('janus.plugin.videoroom', async (sessionId, handleId) => {
        const createRes = await this.httpPost(`/${sessionId}/${handleId}`, {
          janus: 'message',
          transaction: this.tx(),
          body: {
            request: 'create',
            room: roomId,
            description: `Communications video room ${roomId}`,
            publishers: 100,
            bitrate: 512000,
            audiocodec: 'opus',
            videocodec: 'vp8',
            record: false,
            is_private: false,
            notify_joining: true,
          },
        });
        const result = createRes?.plugindata?.data;
        if (result?.videoroom === 'created') {
          this.logger.log(`Janus VideoRoom ${roomId} created`);
        } else if (result?.error_code === 427) {
          this.logger.debug(`Janus VideoRoom ${roomId} already exists`);
        } else {
          throw new Error(`Unexpected VideoRoom create response: ${JSON.stringify(result)}`);
        }
      });

      if (this.redis.isReady()) {
        await this.redis.set(cacheKey, String(roomId));
      }
      return roomId;
    } catch (err) {
      this.logger.error(`Failed to ensure VideoRoom for ${contextId}: ${err}`);
      return null;
    }
  }

  async destroyVideoRoom(contextId: string, knownRoomId?: number | null): Promise<void> {
    if (!this.available) return;

    const roomId = knownRoomId && knownRoomId > 0 ? knownRoomId : this.contextIdToRoomId(contextId);
    try {
      await this.withPluginHandle('janus.plugin.videoroom', async (sessionId, handleId) => {
        await this.httpPost(`/${sessionId}/${handleId}`, {
          janus: 'message',
          transaction: this.tx(),
          body: { request: 'destroy', room: roomId },
        });
      });
      if (this.redis.isReady()) {
        await this.redis.del(`comms:janus:video:${this.janusVersion}:${contextId}`);
      }
      this.logger.log(`Janus VideoRoom ${roomId} destroyed for context ${contextId}`);
    } catch (err) {
      this.logger.warn(`Failed to destroy VideoRoom ${roomId}: ${err}`);
    }
  }

  // ── AudioBridge Mic Control ─────────────────────────────────────────────────

  /**
   * Mute a single participant in an AudioBridge room (server-side enforcement).
   * Returns true on success; throws on failure.
   */
  async muteParticipant(roomId: number, participantId: string | number): Promise<boolean> {
    if (!this.available) throw new Error('Janus Gateway unavailable');

    await this.withPluginHandle('janus.plugin.audiobridge', async (sessionId, handleId) => {
      const res = await this.httpPost(`/${sessionId}/${handleId}`, {
        janus: 'message',
        transaction: this.tx(),
        body: { request: 'mute', room: roomId, id: Number(participantId) },
      });
      const result = res?.plugindata?.data;
      if (result?.audiobridge !== 'success') {
        throw new Error(`AudioBridge mute failed: ${JSON.stringify(result)}`);
      }
    });

    this.logger.log(`Muted participant ${participantId} in AudioBridge room ${roomId}`);
    return true;
  }

  /**
   * Unmute a single participant in an AudioBridge room (server-side enforcement).
   * Returns true on success; throws on failure.
   */
  async unmuteParticipant(roomId: number, participantId: string | number): Promise<boolean> {
    if (!this.available) throw new Error('Janus Gateway unavailable');

    await this.withPluginHandle('janus.plugin.audiobridge', async (sessionId, handleId) => {
      const res = await this.httpPost(`/${sessionId}/${handleId}`, {
        janus: 'message',
        transaction: this.tx(),
        body: { request: 'unmute', room: roomId, id: Number(participantId) },
      });
      const result = res?.plugindata?.data;
      if (result?.audiobridge !== 'success') {
        throw new Error(`AudioBridge unmute failed: ${JSON.stringify(result)}`);
      }
    });

    this.logger.log(`Unmuted participant ${participantId} in AudioBridge room ${roomId}`);
    return true;
  }

  /**
   * Mute ALL participants in an AudioBridge room simultaneously.
   * Used for emergency mute, moderator lockdown, and room adjournment.
   */
  async muteRoom(roomId: number): Promise<boolean> {
    if (!this.available) throw new Error('Janus Gateway unavailable');

    await this.withPluginHandle('janus.plugin.audiobridge', async (sessionId, handleId) => {
      const res = await this.httpPost(`/${sessionId}/${handleId}`, {
        janus: 'message',
        transaction: this.tx(),
        body: { request: 'mute_room', room: roomId },
      });
      const result = res?.plugindata?.data;
      if (result?.audiobridge !== 'success') {
        throw new Error(`AudioBridge mute_room failed: ${JSON.stringify(result)}`);
      }
    });

    this.logger.log(`Muted all participants in AudioBridge room ${roomId}`);
    return true;
  }

  /**
   * List all participants in an AudioBridge room with their mute state.
   * Used to discover participant IDs and verify mute state.
   */
  async listParticipants(roomId: number): Promise<Array<{ id: number; display: string; muted: boolean }>> {
    if (!this.available) return [];

    let participants: Array<{ id: number; display: string; muted: boolean }> = [];
    await this.withPluginHandle('janus.plugin.audiobridge', async (sessionId, handleId) => {
      const res = await this.httpPost(`/${sessionId}/${handleId}`, {
        janus: 'message',
        transaction: this.tx(),
        body: { request: 'listparticipants', room: roomId },
      });
      const result = res?.plugindata?.data;
      if (result?.audiobridge !== 'participants') {
        throw new Error(`AudioBridge listparticipants failed: ${JSON.stringify(result)}`);
      }
      participants = (result.participants ?? []).map((p: any) => ({
        id: p.id,
        display: p.display ?? '',
        muted: !!p.muted,
      }));
    });

    return participants;
  }

  // ── AudioBridge Kick ────────────────────────────────────────────────────────

  /**
   * Kick a participant from an AudioBridge room.
   * The participant is immediately disconnected from the audio mix.
   */
  async kickAudioParticipant(roomId: number, participantId: string | number): Promise<boolean> {
    if (!this.available) throw new Error('Janus Gateway unavailable');

    await this.withPluginHandle('janus.plugin.audiobridge', async (sessionId, handleId) => {
      const res = await this.httpPost(`/${sessionId}/${handleId}`, {
        janus: 'message',
        transaction: this.tx(),
        body: { request: 'kick', room: roomId, id: Number(participantId) },
      });
      const result = res?.plugindata?.data;
      if (result?.audiobridge !== 'success') {
        throw new Error(`AudioBridge kick failed: ${JSON.stringify(result)}`);
      }
    });

    this.logger.log(`Kicked participant ${participantId} from AudioBridge room ${roomId}`);
    return true;
  }

  // ── VideoRoom Kick + List ──────────────────────────────────────────────────

  /**
   * Kick a participant from a VideoRoom.
   * The participant is immediately disconnected from the video session.
   */
  async kickVideoParticipant(roomId: number, participantId: string | number): Promise<boolean> {
    if (!this.available) throw new Error('Janus Gateway unavailable');

    await this.withPluginHandle('janus.plugin.videoroom', async (sessionId, handleId) => {
      const res = await this.httpPost(`/${sessionId}/${handleId}`, {
        janus: 'message',
        transaction: this.tx(),
        body: { request: 'kick', room: roomId, id: Number(participantId) },
      });
      const result = res?.plugindata?.data;
      if (result?.videoroom !== 'success') {
        throw new Error(`VideoRoom kick failed: ${JSON.stringify(result)}`);
      }
    });

    this.logger.log(`Kicked participant ${participantId} from VideoRoom ${roomId}`);
    return true;
  }

  /**
   * List all participants in a VideoRoom with their display names.
   * Used to resolve domain user IDs to Janus participant IDs for kick operations.
   */
  async listVideoParticipants(roomId: number): Promise<Array<{ id: number; display: string }>> {
    if (!this.available) return [];

    let participants: Array<{ id: number; display: string }> = [];
    await this.withPluginHandle('janus.plugin.videoroom', async (sessionId, handleId) => {
      const res = await this.httpPost(`/${sessionId}/${handleId}`, {
        janus: 'message',
        transaction: this.tx(),
        body: { request: 'listparticipants', room: roomId },
      });
      const result = res?.plugindata?.data;
      if (result?.videoroom !== 'participants') {
        throw new Error(`VideoRoom listparticipants failed: ${JSON.stringify(result)}`);
      }
      participants = (result.participants ?? []).map((p: any) => ({
        id: p.id,
        display: p.display ?? '',
      }));
    });

    return participants;
  }

  // ── SIP Plugin (low-level helpers) ─────────────────────────────────────────
  //
  // Unlike AudioBridge and VideoRoom which use per-operation ephemeral
  // sessions via `withPluginHandle`, the SIP plugin requires long-lived
  // state because SIP REGISTER and per-call handles outlive any single
  // HTTP request. The state itself (sessionId + handleIds + per-call
  // tracking) lives in SipBridgeService; JanusService only exposes the
  // thin HTTP helpers that the bridge composes into full flows.
  //
  // All methods return raw Janus responses and throw on non-2xx. The
  // caller is responsible for inspecting plugindata.data to interpret
  // plugin-specific fields (sip, audiobridge, etc.).

  /** Creates a new Janus session. Returns the sessionId. */
  async sipCreateSession(): Promise<string> {
    if (!this.available) throw new Error('Janus Gateway unavailable');
    const res = await this.httpPost('', { janus: 'create', transaction: this.tx() });
    const sessionId = res?.data?.id as string | undefined;
    if (!sessionId) throw new Error('Failed to create Janus SIP session');
    return sessionId;
  }

  /** Attaches a plugin (janus.plugin.sip or janus.plugin.audiobridge) to
   *  an existing session. Returns the handleId. */
  async sipAttachHandle(
    sessionId: string,
    plugin: 'janus.plugin.sip' | 'janus.plugin.audiobridge',
  ): Promise<string> {
    const res = await this.httpPost(`/${sessionId}`, {
      janus: 'attach',
      plugin,
      transaction: this.tx(),
    });
    const handleId = res?.data?.id as string | undefined;
    if (!handleId) throw new Error(`Failed to attach ${plugin}`);
    return handleId;
  }

  /** Sends a plugin message to a SIP handle. Returns the raw Janus
   *  response — async plugin events arrive separately via long-poll. */
  async sipSendMessage(
    sessionId: string,
    handleId: string,
    body: Record<string, any>,
    jsep?: Record<string, any>,
  ): Promise<any> {
    const payload: Record<string, any> = {
      janus: 'message',
      transaction: this.tx(),
      body,
    };
    if (jsep) payload.jsep = jsep;
    return this.httpPost(`/${sessionId}/${handleId}`, payload);
  }

  /** Long-polls for async events on a session. `maxev` caps how many
   *  events we pick up per call. Returns an array of events; empty
   *  array means the poll timed out with nothing new. */
  async sipLongPoll(sessionId: string, maxev = 5): Promise<any[]> {
    try {
      const res = await fetch(
        `${this.httpUrl}/${sessionId}?maxev=${maxev}`,
        { method: 'GET' },
      );
      if (!res.ok) {
        if (res.status === 404) {
          // Session expired — caller will recreate
          throw new Error('SIP session expired');
        }
        throw new Error(`Janus long-poll ${res.status}`);
      }
      const body = await res.json();
      // Janus long-poll returns either a single event object or an
      // array depending on server version. Normalize to array.
      if (Array.isArray(body)) return body;
      if (body && typeof body === 'object') return [body];
      return [];
    } catch (err) {
      throw err;
    }
  }

  /** Keepalive to prevent Janus from timing out the session (60s default). */
  async sipKeepalive(sessionId: string): Promise<void> {
    await this.httpPost(`/${sessionId}`, {
      janus: 'keepalive',
      transaction: this.tx(),
    });
  }

  /** Destroys a Janus session. Best-effort — errors are swallowed. */
  async sipDestroySession(sessionId: string): Promise<void> {
    await this.httpDelete(`/${sessionId}`).catch(() => {});
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async tryConnect(): Promise<void> {
    try {
      const info = await this.httpGet('/info');
      if (info?.janus !== 'server_info') return;

      if (!this.available) {
        this.available = true;
        this.janusVersion = Date.now().toString(36);
        this.roomCache.clear();
        if (this.redis.isReady()) {
          await this.redis.set('comms:janus:version', this.janusVersion);
        }
        this.logger.log(
          `Janus Gateway connected: ${info.name ?? 'unknown'} at ${this.httpUrl} (v${this.janusVersion})`,
        );
      }
    } catch {
      if (this.available) {
        this.available = false;
        this.roomCache.clear();
        this.logger.warn(`Janus Gateway unreachable at ${this.httpUrl}. Calls will be disabled.`);
      }
    }
  }

  private async withPluginHandle(
    plugin: string,
    callback: (sessionId: string, handleId: string) => Promise<void>,
  ): Promise<void> {
    const sessionRes = await this.httpPost('', { janus: 'create', transaction: this.tx() });
    const sessionId = sessionRes?.data?.id as string | undefined;
    if (!sessionId) throw new Error('Failed to create Janus session');

    try {
      const attachRes = await this.httpPost(`/${sessionId}`, {
        janus: 'attach',
        plugin,
        transaction: this.tx(),
      });
      const handleId = attachRes?.data?.id as string | undefined;
      if (!handleId) throw new Error(`Failed to attach ${plugin}`);
      await callback(sessionId, handleId);
    } finally {
      await this.httpDelete(`/${sessionId}`).catch(() => {});
    }
  }

  /**
   * Converts a context UUID to a stable numeric Janus room ID.
   * djb2 XOR hash truncated to 31 bits (fits PostgreSQL Int).
   */
  private contextIdToRoomId(input: string): number {
    let h = 5381;
    for (let i = 0; i < input.length; i += 1) {
      h = (h * 33) ^ input.charCodeAt(i);
    }
    const roomId = (h >>> 0) & 0x7fffffff;
    return roomId === 0 ? 1 : roomId;
  }

  private normalizeHttpUrl(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      if (url.pathname === '/' || url.pathname === '') {
        url.pathname = '/janus';
      }
      return url.toString().replace(/\/$/, '');
    } catch {
      return rawUrl.replace(/\/$/, '');
    }
  }

  /** HTTP request timeout for Janus admin API calls (ms). */
  private readonly httpTimeoutMs = 10_000;

  private async httpGet(path: string): Promise<any> {
    const res = await fetch(`${this.httpUrl}${path}`, {
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!res.ok) throw new Error(`Janus HTTP ${res.status} on GET ${path}`);
    return res.json();
  }

  private async httpPost(path: string, body: Record<string, any>): Promise<any> {
    const res = await fetch(`${this.httpUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!res.ok) throw new Error(`Janus HTTP ${res.status} on POST ${path}`);
    return res.json();
  }

  private async httpDelete(path: string): Promise<void> {
    await fetch(`${this.httpUrl}${path}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
  }

  private tx(): string {
    return `comms_${Math.random().toString(36).slice(2, 10)}`;
  }
}
