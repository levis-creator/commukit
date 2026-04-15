import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';

/**
 * Result of provisioning SIP credentials for a domain user.
 *
 * `password` is only set when a new password was minted (first-time
 * provisioning or rotation). On subsequent calls returning a cached
 * username, `password` is null and the caller should keep whatever it
 * already has on file.
 */
export interface SipCredentialsResult {
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

  /** Reserved usernames that consumer-supplied domainUserIds must never collide with. */
  private static readonly RESERVED_USERNAMES = new Set([
    'janus',
    'kamailio',
    'comms-bot',
    'admin',
    'root',
  ]);

  constructor(@Optional() private readonly prisma?: PrismaService) {
    this.domain = process.env.SIP_DOMAIN ?? 'comms.local';
    this.registrarHost = process.env.SIP_REGISTRAR_HOST ?? 'comms-kamailio';
    this.registrarPort = Number(process.env.SIP_REGISTRAR_PORT ?? '5060');
    const transport = (process.env.SIP_TRANSPORT ?? 'udp').toLowerCase();
    this.transport = transport === 'tcp' || transport === 'tls' ? transport : 'udp';
    this.publicHost = process.env.SIP_PUBLIC_HOST?.trim() || null;
    this.logger.log(
      `SipService configured: domain=${this.domain} registrar=${this.registrarHost}:${this.registrarPort}/${this.transport}`,
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
  ): {
    status: 'available';
    username: string;
    password: string;
    registrar: string;
    domain: string;
    transport: 'udp' | 'tcp' | 'tls';
    roomUri?: string;
  } {
    const host = this.publicHost ?? this.registrarHost;
    const descriptor: ReturnType<SipService['buildSessionDescriptor']> = {
      status: 'available',
      username: creds.username,
      password: creds.password,
      registrar: `sip:${host}:${this.registrarPort};transport=${this.transport}`,
      domain: this.domain,
      transport: this.transport,
    };
    if (roomContextId) {
      descriptor.roomUri = `sip:room-${roomContextId}@${this.domain}`;
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
      return { username, password: null };
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
    return { username, password: newPassword };
  }

  /**
   * Removes a user's SIP credentials from Kamailio. Best-effort; failures
   * are logged but never throw, mirroring the Matrix logout pattern.
   */
  async deprovisionUser(username: string): Promise<void> {
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
    return require('crypto')
      .createHash('md5')
      .update(`${username}:${realm}:${password}`)
      .digest('hex');
  }

  /** HA1B = MD5(username@realm:realm:password). Used by some SIP clients. */
  private computeHa1b(username: string, realm: string, password: string): string {
    return require('crypto')
      .createHash('md5')
      .update(`${username}@${realm}:${realm}:${password}`)
      .digest('hex');
  }
}
