import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { RedisService } from '../redis/redis.service';

/**
 * MatrixService — owns all Matrix Synapse interactions for the communications layer.
 *
 * Responsibilities:
 *   - Bot account lifecycle (register / login on startup, refresh on 401)
 *   - Room creation and alias management
 *   - Member user provisioning (register / login / token issuance)
 *   - Room invitations and auto-join
 *   - Per-member logout when sessions are torn down
 *
 * Graceful fallback: if Synapse is unreachable, all methods return null/empty
 * and log a warning so callers can report "unavailable" in the session response.
 *
 * Security notes:
 *   - Member passwords are randomly generated and persisted via
 *     [MatrixService.ensureUserToken], which exposes them to the caller so
 *     they can be stored in the application DB.
 *   - Bot token is refreshed transparently on HTTP 401.
 *   - All Matrix HTTP calls have a hard timeout to prevent request stalls.
 */
@Injectable()
export class MatrixService implements OnModuleInit {
  private readonly logger = new Logger(MatrixService.name);

  private static readonly HTTP_TIMEOUT_MS = 10_000;
  private static readonly ROOM_CACHE_MAX = 2_000;
  private static readonly TOKEN_CACHE_MAX = 5_000;
  private static readonly INVITE_FLAG_TTL = 60 * 60 * 24; // 24h

  readonly serverUrl: string;
  readonly publicServerUrl: string;
  readonly serverName: string;
  private readonly botUsername: string;
  private readonly botPassword: string;
  private readonly registrationSharedSecret: string;

  private available = false;
  private botAccessToken: string | null = null;
  private botRefreshInFlight: Promise<void> | null = null;

  private readonly roomCache = new _BoundedMap<string, string>(
    MatrixService.ROOM_CACHE_MAX,
  );
  private readonly memberTokenCache = new _BoundedMap<string, string>(
    MatrixService.TOKEN_CACHE_MAX,
  );

  constructor(private readonly redis: RedisService) {
    this.serverUrl = (process.env.MATRIX_SERVER_URL ?? 'http://localhost:8020').replace(/\/$/, '');
    this.publicServerUrl = (process.env.MATRIX_PUBLIC_SERVER_URL ?? this.serverUrl).replace(/\/$/, '');
    this.serverName = process.env.MATRIX_SERVER_NAME ?? 'comms.local';
    this.botUsername = process.env.MATRIX_BOT_USERNAME ?? 'comms-bot';

    const rawBotPassword = process.env.MATRIX_BOT_PASSWORD;
    if (!rawBotPassword) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'MATRIX_BOT_PASSWORD is required in production — refusing to start with a default password.',
        );
      }
      this.logger.warn(
        'MATRIX_BOT_PASSWORD not set — falling back to insecure default. Do NOT run this config in production.',
      );
    }
    this.botPassword = rawBotPassword ?? 'comms-bot-secret';

    const rawRegSecret = process.env.MATRIX_REGISTRATION_SHARED_SECRET;
    if (!rawRegSecret && process.env.NODE_ENV === 'production') {
      throw new Error(
        'MATRIX_REGISTRATION_SHARED_SECRET is required in production — refusing to start with a default.',
      );
    }
    this.registrationSharedSecret = rawRegSecret ?? 'change-me-registration-secret';
  }

  onModuleInit() {
    // Fire-and-forget — never block app startup waiting for Synapse.
    // Matrix will become available once the bot login succeeds (may retry on rate-limit).
    void this.init();
  }

  private async init() {
    try {
      const versions = await this.httpGet('/_matrix/client/versions');
      if (!versions?.versions) {
        this.logger.warn('Matrix Synapse not reachable. Chat will be disabled.');
        return;
      }
      await this.ensureBotAccount();
      this.available = true;
      this.logger.log(
        `Matrix Synapse connected at ${this.serverUrl} · bot: @${this.botUsername}:${this.serverName}`,
      );
    } catch (err) {
      this.logger.warn(
        `Matrix init failed: ${err instanceof Error ? err.message : err}. Chat will be disabled.`,
      );
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  // ── Room management ────────────────────────────────────────────────────────

  /**
   * Idempotently ensures a Matrix room exists for a given [appId]/[contextId]
   * pair. The alias is prefixed with a short hash of [appId] so two consumer
   * apps can use overlapping contextId namespaces without colliding on the
   * Matrix homeserver.
   *
   * Returns the Matrix roomId (e.g. `!abc123:comms.local`), or null.
   */
  async ensureRoom(
    appId: string,
    contextId: string,
    title: string,
  ): Promise<string | null> {
    if (!this.available || !this.botAccessToken) return null;

    const scopedKey = `${appId}:${contextId}`;
    const cacheKey = `comms:matrix:room:${scopedKey}`;
    if (this.redis.isReady()) {
      const cached = await this.redis.get(cacheKey);
      if (cached) return cached;
    }
    if (this.roomCache.has(scopedKey)) {
      return this.roomCache.get(scopedKey)!;
    }

    const alias = this.buildRoomAlias(appId, contextId);
    const fullAlias = `#${alias}:${this.serverName}`;

    try {
      const resolved = await this.httpGet(
        `/_matrix/client/v3/directory/room/${encodeURIComponent(fullAlias)}`,
      );
      if (resolved?.room_id) {
        this.cacheRoom(scopedKey, cacheKey, resolved.room_id);
        return resolved.room_id;
      }
    } catch {
      // Room doesn't exist — create below
    }

    try {
      const created = await this.httpPost(
        '/_matrix/client/v3/createRoom',
        {
          room_alias_name: alias,
          name: title || `Communications Room ${contextId.slice(0, 8)}`,
          topic: 'Managed by the Communications Service',
          preset: 'private_chat',
          visibility: 'private',
          initial_state: [
            { type: 'm.room.history_visibility', content: { history_visibility: 'joined' } },
            { type: 'm.room.guest_access', content: { guest_access: 'forbidden' } },
          ],
        },
        { asBot: true },
      );

      const roomId = created?.room_id as string | undefined;
      if (!roomId) throw new Error('No room_id in createRoom response');

      this.cacheRoom(scopedKey, cacheKey, roomId);
      this.logger.log(
        `Matrix room created for ${appId}/${contextId}: ${roomId}`,
      );
      return roomId;
    } catch (err) {
      this.logger.error(
        `Failed to create Matrix room for ${appId}/${contextId}: ${err}`,
      );
      return null;
    }
  }

  /**
   * Builds a Matrix room alias local-part of the form
   * `comms-<4-char-appHash>-<16-char-context>`. The app hash keeps aliases
   * from colliding across consumer apps that use overlapping contextId
   * namespaces (e.g. two apps both using UUIDs).
   */
  private buildRoomAlias(appId: string, contextId: string): string {
    const appHash = createHmac('sha256', 'comms-room-alias')
      .update(appId)
      .digest('hex')
      .slice(0, 4);
    const contextPart = contextId.replace(/-/g, '').slice(0, 16).toLowerCase();
    return `comms-${appHash}-${contextPart}`;
  }

  // ── User provisioning ──────────────────────────────────────────────────────

  /**
   * Ensures a Matrix user exists for a domain user and returns an access token.
   *
   * [storedPassword] is the random password the comms service keeps on file
   * for this user. Pass `null` for legacy users created under the old
   * deterministic-password scheme; this method will migrate them automatically
   * and return the newly-generated password so the caller can persist it.
   *
   * Returns `{ accessToken, matrixUserId, password }` on success, or null when
   * Matrix is unavailable. `password` is only set when a new random password
   * was generated (first-time registration OR legacy migration).
   */
  async ensureUserToken(
    domainUserId: string,
    displayName: string,
    storedPassword: string | null,
  ): Promise<{
    accessToken: string;
    matrixUserId: string;
    password: string | null;
  } | null> {
    if (!this.available) return null;

    const cacheKey = `comms:matrix:token:${domainUserId}`;
    const username = `comms_${domainUserId.replace(/-/g, '').slice(0, 16)}`;
    const matrixUserId = `@${username}:${this.serverName}`;

    // Fast path: cached token. The caller is expected to have already decided
    // whether a displayname refresh is needed (see RoomsService), so this
    // method no longer pokes Matrix on every authorize call.
    if (this.redis.isReady()) {
      const cached = await this.redis.get(cacheKey);
      if (cached) return { accessToken: cached, matrixUserId, password: null };
    }
    if (this.memberTokenCache.has(domainUserId)) {
      const cached = this.memberTokenCache.get(domainUserId)!;
      return { accessToken: cached, matrixUserId, password: null };
    }

    // Try login with the stored password first.
    if (storedPassword) {
      try {
        const token = await this.loginUser(username, storedPassword);
        if (token) {
          this.cacheToken(domainUserId, cacheKey, token);
          return { accessToken: token, matrixUserId, password: null };
        }
      } catch {
        // Fall through to legacy / register.
      }
    }

    // Legacy fallback — migrate away from the deterministic scheme.
    const legacyPassword = `mp_${domainUserId}`;
    try {
      const token = await this.loginUser(username, legacyPassword);
      if (token) {
        // Rotate off the legacy password: generate a random one and change it.
        const newPassword = this.generatePassword();
        const rotated = await this.changePassword(
          username,
          token,
          legacyPassword,
          newPassword,
        );
        if (rotated) {
          // Re-login with the new password to obtain a fresh token bound to it.
          const fresh = await this.loginUser(username, newPassword);
          if (fresh) {
            this.cacheToken(domainUserId, cacheKey, fresh);
            return { accessToken: fresh, matrixUserId, password: newPassword };
          }
        }
        // Rotation failed — keep the token but don't upgrade the password.
        this.cacheToken(domainUserId, cacheKey, token);
        return { accessToken: token, matrixUserId, password: null };
      }
    } catch {
      // Not registered at all — fall through to register.
    }

    // First-time registration — always with a random password.
    try {
      const newPassword = this.generatePassword();
      const token = await this.registerUser(username, newPassword, displayName);
      if (token) {
        this.cacheToken(domainUserId, cacheKey, token);
        return { accessToken: token, matrixUserId, password: newPassword };
      }
    } catch (err) {
      this.logger.warn(`Failed to get Matrix token for user ${domainUserId}: ${err}`);
    }

    return null;
  }

  /**
   * Updates a user's Matrix display name. Intended to be called by the rooms
   * service only when the stored name differs from the new one.
   */
  async updateDisplayName(
    accessToken: string,
    matrixUserId: string,
    displayName: string,
  ): Promise<boolean> {
    try {
      await this.httpPut(
        `/_matrix/client/v3/profile/${encodeURIComponent(matrixUserId)}/displayname`,
        { displayname: displayName },
        { accessToken },
      );
      return true;
    } catch (err) {
      this.logger.warn(`Matrix setDisplayName failed for ${matrixUserId}: ${err}`);
      return false;
    }
  }

  /**
   * Invites a Matrix user to a room and auto-joins them. Uses a Redis-backed
   * flag so multiple replicas don't re-invite the same user on every request.
   * Parallelizes invite + join for lower latency.
   */
  async inviteAndJoin(
    roomId: string,
    matrixUserId: string,
    memberAccessToken: string,
  ): Promise<void> {
    if (!this.available || !this.botAccessToken) return;

    const flagKey = `comms:matrix:invite:${roomId}:${matrixUserId}`;
    if (this.redis.isReady()) {
      const acquired = await this.redis.setIfAbsent(
        flagKey,
        '1',
        MatrixService.INVITE_FLAG_TTL,
      );
      if (!acquired) return; // Another replica or recent request already handled this.
    }

    const invitePromise = this.httpPost(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { user_id: matrixUserId },
      { asBot: true },
    ).catch((err: unknown) =>
      this.logger.warn(`Matrix invite failed for ${matrixUserId}: ${err}`),
    );

    const joinPromise = this.httpPost(
      `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      {},
      { accessToken: memberAccessToken },
    ).catch((err: unknown) =>
      this.logger.warn(`Matrix joinRoom failed for ${matrixUserId}: ${err}`),
    );

    await Promise.all([invitePromise, joinPromise]);
  }

  /**
   * Logs out a member's Matrix session, invalidating the cached access token
   * so a later authorize call will have to log in again. Used when a room is
   * closed so members can't keep reading the Matrix room after the session
   * ends.
   */
  async logoutMember(domainUserId: string, accessToken: string): Promise<void> {
    try {
      await this.httpPost(
        '/_matrix/client/v3/logout',
        {},
        { accessToken },
      );
    } catch (err) {
      this.logger.debug(`Matrix logout failed for ${domainUserId}: ${err}`);
    }
    this.memberTokenCache.delete(domainUserId);
    if (this.redis.isReady()) {
      await this.redis.del(`comms:matrix:token:${domainUserId}`);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private cacheRoom(contextId: string, cacheKey: string, roomId: string) {
    this.roomCache.set(contextId, roomId);
    if (this.redis.isReady()) {
      this.redis.set(cacheKey, roomId).catch(() => {});
    }
  }

  private cacheToken(domainUserId: string, cacheKey: string, token: string) {
    this.memberTokenCache.set(domainUserId, token);
    if (this.redis.isReady()) {
      this.redis.set(cacheKey, token).catch(() => {});
    }
  }

  private generatePassword(): string {
    // 32 bytes of entropy, hex-encoded. Well above Matrix minimums.
    return randomBytes(32).toString('hex');
  }

  private async ensureBotAccount(): Promise<void> {
    // 1. Try login first — covers restarts where the bot account already exists.
    //    Retry up to 3 times if Synapse rate-limits us (M_LIMIT_EXCEEDED).
    const token = await this.loginWithRetry(this.botUsername, this.botPassword);
    if (token) {
      this.botAccessToken = token;
      return;
    }

    // 2. Login returned no token — attempt registration (first-time setup).
    const nonce = await this.getNonce();
    const mac = this.computeRegistrationMac(nonce, this.botUsername, this.botPassword, false);

    const res = await this.httpPost('/_synapse/admin/v1/register', {
      nonce,
      username: this.botUsername,
      password: this.botPassword,
      admin: false,
      mac,
    });

    if (res?.access_token) {
      this.botAccessToken = res.access_token;
    } else if (res?.errcode === 'M_USER_IN_USE') {
      throw new Error(
        `Bot account @${this.botUsername}:${this.serverName} already exists but login failed. ` +
        `Check MATRIX_BOT_PASSWORD in .env matches the password used when the account was first created.`,
      );
    } else {
      throw new Error(`Bot registration failed: ${JSON.stringify(res)}`);
    }
  }

  /**
   * Single-flighted bot-token refresh: if multiple callers hit a 401 at the
   * same time, only one reconnection runs and the rest wait on its promise.
   */
  private async refreshBotToken(): Promise<void> {
    if (this.botRefreshInFlight) return this.botRefreshInFlight;
    this.botRefreshInFlight = (async () => {
      try {
        this.botAccessToken = null;
        await this.ensureBotAccount();
      } finally {
        this.botRefreshInFlight = null;
      }
    })();
    return this.botRefreshInFlight;
  }

  private async loginWithRetry(username: string, password: string, maxAttempts = 3): Promise<string | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await this.httpPost('/_matrix/client/v3/login', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      });

      if (res?.access_token) return res.access_token;

      if (res?.errcode === 'M_LIMIT_EXCEEDED') {
        const waitMs = (res.retry_after_ms as number | undefined) ?? 5_000;
        this.logger.warn(
          `Matrix login rate-limited (attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms`,
        );
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        continue;
      }

      // Any other failure (wrong password, etc.) — return null immediately.
      return null;
    }
    return null;
  }

  private async loginUser(username: string, password: string): Promise<string | null> {
    const res = await this.httpPost('/_matrix/client/v3/login', {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
    });
    return res?.access_token ?? null;
  }

  private async registerUser(username: string, password: string, displayName: string): Promise<string | null> {
    const nonce = await this.getNonce();
    const mac = this.computeRegistrationMac(nonce, username, password, false);
    const res = await this.httpPost('/_synapse/admin/v1/register', {
      nonce,
      username,
      password,
      displayname: displayName,
      admin: false,
      mac,
    });
    return res?.access_token ?? null;
  }

  /**
   * Rotates a user's Matrix password via the authenticated `/account/password`
   * endpoint. Returns true on success.
   *
   * [username] must be the Matrix local-part of the account being rotated —
   * NOT the bot username. Matrix user-interactive auth requires the
   * identifier to match the session owner, and this method is called to
   * rotate *member* credentials during legacy migration.
   */
  private async changePassword(
    username: string,
    accessToken: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    try {
      await this.httpPost(
        '/_matrix/client/v3/account/password',
        {
          new_password: newPassword,
          logout_devices: false,
          auth: {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: username },
            password: oldPassword,
          },
        },
        { accessToken },
      );
      return true;
    } catch (err) {
      this.logger.debug(`Matrix password rotation failed for ${username}: ${err}`);
      return false;
    }
  }

  private async getNonce(): Promise<string> {
    const res = await this.httpGet('/_synapse/admin/v1/register');
    return res?.nonce ?? '';
  }

  private computeRegistrationMac(nonce: string, username: string, password: string, admin: boolean): string {
    const hmac = createHmac('sha1', this.registrationSharedSecret);
    hmac.update(nonce);
    hmac.update('\x00');
    hmac.update(username);
    hmac.update('\x00');
    hmac.update(password);
    hmac.update('\x00');
    hmac.update(admin ? 'admin' : 'notadmin');
    return hmac.digest('hex');
  }

  // ── HTTP helpers (hardened) ────────────────────────────────────────────────

  private async httpGet(path: string, accessToken?: string): Promise<any> {
    return this.request('GET', path, undefined, { accessToken });
  }

  private async httpPost(
    path: string,
    body: Record<string, any>,
    options?: { asBot?: boolean; accessToken?: string },
  ): Promise<any> {
    return this.request('POST', path, body, options);
  }

  private async httpPut(
    path: string,
    body: Record<string, any>,
    options?: { asBot?: boolean; accessToken?: string },
  ): Promise<any> {
    return this.request('PUT', path, body, options);
  }

  /**
   * Unified HTTP worker:
   *   - Enforces a hard timeout via AbortController.
   *   - Throws on non-2xx with the Matrix errcode/body attached.
   *   - On 401 with a bot-originated request, transparently refreshes the
   *     bot token and retries once.
   */
  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: Record<string, any> | undefined,
    options: { asBot?: boolean; accessToken?: string } = {},
    attempt = 0,
  ): Promise<any> {
    const token = options.accessToken ?? (options.asBot ? this.botAccessToken : undefined);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      MatrixService.HTTP_TIMEOUT_MS,
    );

    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        throw new Error(`Matrix ${method} ${path} timed out after ${MatrixService.HTTP_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    clearTimeout(timer);

    // Transparent bot-token refresh on 401 (once).
    if (res.status === 401 && options.asBot && attempt === 0) {
      await this.refreshBotToken();
      return this.request(method, path, body, options, attempt + 1);
    }

    const text = await res.text().catch(() => '');
    const parsed = text ? this.tryParseJson(text) : null;

    if (!res.ok) {
      const errcode = parsed?.errcode ?? '';
      const errmsg = parsed?.error ?? text;
      throw new MatrixHttpError(
        res.status,
        errcode,
        `Matrix ${method} ${path} → ${res.status}${errcode ? ` ${errcode}` : ''}: ${errmsg}`,
      );
    }

    return parsed;
  }

  private tryParseJson(text: string): any | null {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

/** Error thrown by MatrixService HTTP helpers on non-2xx responses. */
export class MatrixHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly errcode: string,
    message: string,
  ) {
    super(message);
    this.name = 'MatrixHttpError';
  }
}

/**
 * Tiny bounded LRU. Keeps the last [max] insertion-ordered entries — on
 * overflow, evicts the oldest. Good enough for our hot-path caches and
 * avoids pulling in an extra dependency.
 */
class _BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Refresh insertion order so this entry moves to the "most recent" slot.
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }
}
