import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MEDIA_PROVIDER } from '../providers/tokens';
import type { MediaProvider } from '../providers/media-provider.interface';
import { sign } from 'jsonwebtoken';

/**
 * Result of provisioning SIP credentials for a domain user.
 *
 * `password` is only set when a new password was minted (first-time
 * provisioning or rotation). On subsequent calls returning a cached
 * username, `password` is null and the caller should keep whatever it
 * already has on file.
 */
export interface SipCredentialsResult {
  provider: 'janus' | 'livekit';
  username: string;
  password: string | null;
}

/**
 * SipService — issues SIP credentials per domain user and exposes the
 * runtime config needed by the Janus SIP bridge and consumer apps.
 *
 * Lifecycle parallels MatrixService.ensureUserToken — credentials are
 * lazily provisioned on first authorization, persisted to the
 * `communication_users` table, and reused on subsequent calls.
 *
 * Kamailio writes:
 * - The Kamailio sidecar reads its `subscriber` table from the same
 *   PostgreSQL database (created by `infra/kamailio/init.sql`). When
 *   we mint a new SIP credential, we must INSERT into that table so
 *   the softphone can authenticate via DIGEST.
 * - Implementation note: the actual write to the `subscriber` table
 *   happens via raw SQL through the Prisma client because the table
 *   isn't part of our Prisma schema (it belongs to Kamailio).
 *
 * This is a deliberately small surface area. The Janus SIP plugin
 * integration (registrar handle, long-poll event correlation, inbound
 * call accept) lives in JanusService alongside the existing AudioBridge
 * and VideoRoom logic.
 */
@Injectable()
export class SipService {
  private readonly logger = new Logger(SipService.name);

  /** Public-facing SIP domain (e.g. `comms.local`). Embedded in URIs. */
  readonly domain: string;
  /** Hostname of the Kamailio registrar (Docker network or DNS). */
  readonly registrarHost: string;
  /** Registrar port (default 5060). */
  readonly registrarPort: number;
  /** Transport: udp / tcp / tls. */
  readonly transport: 'udp' | 'tcp' | 'tls';
  /** Optional override for the registrar URL exposed to softphones. */
  readonly publicHost: string | null;
  readonly provider: 'janus' | 'livekit';
  readonly livekitSipHost: string;
  readonly livekitSipPort: number;
  readonly livekitSipTransport: 'udp' | 'tcp' | 'tls';
  private readonly livekitApiUrl: string;
  private readonly livekitApiKey: string;
  private readonly livekitApiSecret: string;
  private readonly livekitSharedUsername: string;
  private readonly livekitSharedPassword: string;
  private livekitSipConfigured = false;

  /** Reserved usernames that consumer-supplied domainUserIds must never collide with. */
  private static readonly RESERVED_USERNAMES = new Set([
    'janus',
    'kamailio',
    'comms-bot',
    'admin',
    'root',
  ]);

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisService,
    @Optional() @Inject(MEDIA_PROVIDER) private readonly media?: MediaProvider,
  ) {
    this.domain = process.env.SIP_DOMAIN ?? 'comms.local';
    this.registrarHost = process.env.SIP_REGISTRAR_HOST ?? 'comms-kamailio';
    this.registrarPort = Number(process.env.SIP_REGISTRAR_PORT ?? '5060');
    const transport = (process.env.SIP_TRANSPORT ?? 'udp').toLowerCase();
    this.transport = transport === 'tcp' || transport === 'tls' ? transport : 'udp';
    this.publicHost = process.env.SIP_PUBLIC_HOST?.trim() || null;
    this.provider =
      ((process.env.MEDIA_PROVIDER ?? this.media?.id ?? 'janus')
        .trim()
        .toLowerCase() === 'livekit')
        ? 'livekit'
        : 'janus';
    this.livekitSipHost =
      process.env.LIVEKIT_SIP_HOST?.trim() ||
      this.hostnameFromUrl(
        process.env.LIVEKIT_PUBLIC_URL ?? process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
      ) ||
      'localhost';
    this.livekitSipPort = Number(process.env.LIVEKIT_SIP_PORT ?? '5060');
    const livekitTransport = (process.env.LIVEKIT_SIP_TRANSPORT ?? 'udp').toLowerCase();
    this.livekitSipTransport =
      livekitTransport === 'tcp' || livekitTransport === 'tls'
        ? livekitTransport
        : 'udp';
    this.livekitApiUrl = this.normalizeLivekitApiUrl(
      process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
    );
    this.livekitApiKey = process.env.LIVEKIT_API_KEY ?? '';
    this.livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? '';
    this.livekitSharedUsername =
      process.env.LIVEKIT_SIP_USERNAME?.trim() || 'comms_sip';
    this.livekitSharedPassword =
      process.env.LIVEKIT_SIP_PASSWORD?.trim() ||
      this.deriveLivekitSipPassword(process.env.INTERNAL_SERVICE_SECRET ?? 'change-me');
    this.logger.log(
      `SipService configured: provider=${this.provider} domain=${this.domain}`,
    );
  }

  /**
   * Returns the `SipSession` shape advertised in the comms session response.
   * Stable across all callers — used by both `authorizeUser` (in-flow) and
   * the standalone `/users/sip-credentials` endpoint.
   *
   * `roomContextId` is optional; when set, the response includes a
   * `roomUri` of the form `sip:room-<contextId>@<domain>`.
   */
  buildSessionDescriptor(
    creds: { username: string; password: string },
    roomContextId?: string | null,
    roomTarget?: string | null,
  ): {
    status: 'available';
    provider: 'janus' | 'livekit';
    username: string;
    password: string;
    registrar: string;
    domain: string;
    transport: 'udp' | 'tcp' | 'tls';
    roomUri?: string;
    credentials: {
      provider: 'janus' | 'livekit';
      username: string;
      password: string;
      registrar: string;
      domain: string;
      transport: 'udp' | 'tcp' | 'tls';
      roomUri?: string;
    };
  } {
    const isLivekit = this.provider === 'livekit';
    const host = isLivekit
      ? this.livekitSipHost
      : this.publicHost ?? this.registrarHost;
    const port = isLivekit ? this.livekitSipPort : this.registrarPort;
    const transport = isLivekit ? this.livekitSipTransport : this.transport;
    const roomUri = roomTarget
      ? `sip:${roomTarget}@${this.domain}`
      : roomContextId
        ? `sip:room-${roomContextId}@${this.domain}`
        : undefined;
    const descriptor: ReturnType<SipService['buildSessionDescriptor']> = {
      status: 'available',
      provider: this.provider,
      username: creds.username,
      password: creds.password,
      registrar: `sip:${host}:${port};transport=${transport}`,
      domain: this.domain,
      transport,
      credentials: {
        provider: this.provider,
        username: creds.username,
        password: creds.password,
        registrar: `sip:${host}:${port};transport=${transport}`,
        domain: this.domain,
        transport,
        roomUri,
      },
    };
    if (roomUri) {
      descriptor.roomUri = roomUri;
    }
    return descriptor;
  }

  /**
   * Idempotently issues SIP credentials for a domain user. First call mints
   * a random password and writes a row to Kamailio's `subscriber` table.
   * Subsequent calls return the existing credential.
   *
   * Returns null when the database is unavailable (graceful degradation;
   * the caller treats this as `sip: { status: 'unavailable' }`).
   */
  async ensureUserCredentials(
    appId: string,
    domainUserId: string,
    displayName: string,
    storedPassword: string | null,
    storedUsername: string | null,
  ): Promise<SipCredentialsResult | null> {
    if (this.provider === 'livekit') {
      const ready = await this.ensureLivekitInfrastructure();
      if (!ready) return null;
      return {
        provider: 'livekit',
        username: this.livekitSharedUsername,
        password: this.livekitSharedPassword,
      };
    }

    if (!this.prisma) {
      this.logger.warn('SipService.ensureUserCredentials called without Prisma — degrading');
      return null;
    }

    // Username scheme mirrors MatrixService: `comms_<16chars>` derived
    // from a hash of the domainUserId so it's stable across regenerations.
    const username = storedUsername ?? this.generateUsername(domainUserId);

    if (SipService.RESERVED_USERNAMES.has(username)) {
      this.logger.warn(
        `Refusing to provision SIP credentials for reserved username "${username}" (domainUserId=${domainUserId})`,
      );
      return null;
    }

    // If we already have a stored password, reuse it.
    if (storedUsername && storedPassword) {
      // Best-effort: ensure the Kamailio row still exists (idempotent).
      await this.upsertKamailioSubscriber(username, storedPassword).catch(
        (err) => this.logger.warn(`Kamailio subscriber upsert failed for ${username}: ${err}`),
      );
      return { provider: 'janus', username, password: null };
    }

    // First-time provisioning — mint a new password and write the
    // Kamailio subscriber row.
    const newPassword = this.generatePassword();
    try {
      await this.upsertKamailioSubscriber(username, newPassword);
    } catch (err) {
      this.logger.error(
        `Failed to provision SIP credentials for ${domainUserId}: ${err}`,
      );
      return null;
    }
    return { provider: 'janus', username, password: newPassword };
  }

  /**
   * Removes a user's SIP credentials from Kamailio. Best-effort; failures
   * are logged but never throw, mirroring the Matrix logout pattern.
   */
  async deprovisionUser(username: string): Promise<void> {
    if (this.provider === 'livekit') return;
    if (!this.prisma || !username) return;
    try {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM "subscriber" WHERE username = $1 AND domain = $2`,
        username,
        this.domain,
      );
    } catch (err) {
      this.logger.warn(`Kamailio subscriber delete failed for ${username}: ${err}`);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Builds a stable SIP username from the domain user id. Same shape as
   * MatrixService usernames so the two transports can be cross-referenced
   * by the operator if needed.
   */
  private generateUsername(domainUserId: string): string {
    const slug = domainUserId.replace(/-/g, '').slice(0, 16).toLowerCase();
    return `comms_${slug}`;
  }

  private generatePassword(): string {
    // 24 bytes of entropy is well above SIP DIGEST minimums and stays under
    // the 64-char limit some legacy softphones impose on password fields.
    return randomBytes(24).toString('hex');
  }

  /**
   * Writes (or refreshes) a row in Kamailio's `subscriber` table.
   *
   * Kamailio's standard schema has `username`, `domain`, `password`, and
   * (when DIGEST auth is enabled) precomputed `ha1` / `ha1b` columns.
   * We populate the plain-text `password` and the two HA1 hashes so the
   * registrar can authenticate without needing to recompute on every
   * REGISTER.
   *
   * The operation is idempotent: ON CONFLICT we update the password and
   * hashes in place. This is safe because the `subscriber` table has a
   * UNIQUE constraint on `(username, domain)`.
   */
  private async upsertKamailioSubscriber(
    username: string,
    password: string,
  ): Promise<void> {
    if (!this.prisma) return;
    const ha1 = this.computeHa1(username, this.domain, password);
    const ha1b = this.computeHa1b(username, this.domain, password);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "subscriber" (username, domain, password, ha1, ha1b)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username, domain) DO UPDATE
         SET password = EXCLUDED.password,
             ha1      = EXCLUDED.ha1,
             ha1b     = EXCLUDED.ha1b`,
      username,
      this.domain,
      password,
      ha1,
      ha1b,
    );
  }

  /** HA1 = MD5(username:realm:password). Standard SIP DIGEST. */
  private computeHa1(username: string, realm: string, password: string): string {
    return createHash('md5')
      .update(`${username}:${realm}:${password}`)
      .digest('hex');
  }

  /** HA1B = MD5(username@realm:realm:password). Used by some SIP clients. */
  private computeHa1b(username: string, realm: string, password: string): string {
    return createHash('md5')
      .update(`${username}@${realm}:${realm}:${password}`)
      .digest('hex');
  }

  async ensureLivekitInfrastructure(): Promise<boolean> {
    if (this.provider !== 'livekit') return false;
    if (this.livekitSipConfigured) return true;
    if (!this.livekitApiKey || !this.livekitApiSecret) {
      this.logger.warn('LiveKit SIP unavailable: missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET');
      return false;
    }

    const cacheKey = 'comms:livekit:sip:configured';
    if (this.redis?.isReady()) {
      const cached = await this.redis.get(cacheKey);
      if (cached === '1') {
        this.livekitSipConfigured = true;
        return true;
      }
    }

    try {
      await this.createLivekitInboundTrunkIfNeeded();
      await this.createLivekitDispatchRuleIfNeeded();
      this.livekitSipConfigured = true;
      if (this.redis?.isReady()) {
        await this.redis.set(cacheKey, '1');
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to configure LiveKit SIP: ${err}`);
      return false;
    }
  }

  private async createLivekitInboundTrunkIfNeeded(): Promise<void> {
    const name = process.env.LIVEKIT_SIP_TRUNK_NAME ?? 'comms-softphone-inbound';
    const body = {
      name,
      numbers: [],
      authUsername: this.livekitSharedUsername,
      authPassword: this.livekitSharedPassword,
      auth_username: this.livekitSharedUsername,
      auth_password: this.livekitSharedPassword,
    };

    await this.callLivekitSip('CreateSIPInboundTrunk', body).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already exists')) return;
      try {
        const existing = await this.callLivekitSip('ListSIPInboundTrunk', {});
        const items = existing?.items ?? existing?.inboundTrunks ?? [];
        if (Array.isArray(items) && items.some((item: any) => item.name === name)) {
          return;
        }
      } catch {
        // ignore and rethrow original
      }
      throw err;
    });
  }

  private async createLivekitDispatchRuleIfNeeded(): Promise<void> {
    const name = process.env.LIVEKIT_SIP_DISPATCH_RULE_NAME ?? 'comms-room-dispatch';
    const body = {
      rule: {
        dispatchRuleCallee: {
          roomPrefix: '',
          randomize: false,
        },
      },
      name,
    };

    await this.callLivekitSip('CreateSIPDispatchRule', body).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already exists')) return;
      try {
        const existing = await this.callLivekitSip('ListSIPDispatchRule', {});
        const items = existing?.items ?? existing?.dispatchRules ?? [];
        if (Array.isArray(items) && items.some((item: any) => item.name === name)) {
          return;
        }
      } catch {
        // ignore and rethrow original
      }
      throw err;
    });
  }

  private async callLivekitSip(
    method: string,
    body: Record<string, unknown>,
  ): Promise<any> {
    const response = await fetch(`${this.livekitApiUrl}/twirp/livekit.SIP/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.createLivekitServerToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LiveKit SIP ${method} failed (${response.status}): ${text}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private createLivekitServerToken(): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return sign(
      {
        iss: this.livekitApiKey,
        nbf: nowSeconds - 10,
        exp: nowSeconds + 60,
        sip: { admin: true, call: true },
        video: { roomAdmin: true, roomCreate: true },
      },
      this.livekitApiSecret,
      { algorithm: 'HS256' },
    );
  }

  private hostnameFromUrl(rawUrl: string): string | null {
    try {
      return new URL(rawUrl).hostname || null;
    } catch {
      return null;
    }
  }

  private normalizeLivekitApiUrl(rawUrl: string): string {
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

  private deriveLivekitSipPassword(seed: string): string {
    return createHash('sha256').update(`livekit-sip:${seed}`).digest('hex').slice(0, 32);
  }
}
