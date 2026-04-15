/**
 * ChatProvider — backend-agnostic contract for the chat transport.
 *
 * Implemented today by `MatrixService` (Matrix Synapse). LiveKit does not
 * replace chat (LiveKit has no persistent chat), so Matrix is expected to
 * remain the default implementation even when the media provider changes.
 *
 * Alternative implementations could wrap Rocket.Chat, XMPP/ejabberd, or a
 * custom persistence-only chat store. They must preserve Matrix's semantics
 * around idempotent room creation, per-user token minting, and logout-on-close.
 */
export interface ChatUserToken {
  /** Homeserver-qualified user identifier (e.g. `@alice:example.org`). */
  matrixUserId: string;
  /** Client-side access token. Treated as a secret by the caller. */
  accessToken: string;
  /**
   * When non-null, the provider minted (or rotated) a new password on this
   * call. The caller persists it so subsequent `ensureUserToken` calls can
   * log in without triggering another rotation. `null` means reuse.
   */
  password: string | null;
}

export interface ChatProvider {
  /** Stable provider identifier used in the Phase 3 discriminated-union DTO. */
  readonly id: 'matrix' | string;

  /** Public chat server URL returned to clients. */
  readonly publicServerUrl: string;

  /** Homeserver domain name (e.g. `comms.local`). */
  readonly serverName: string;

  /** Whether the backend is currently reachable. */
  isAvailable(): boolean;

  /**
   * Idempotently ensures a chat room exists for the given (appId, contextId).
   * Returns the provider-native room ref (Matrix room id), or `null` when
   * unavailable or creation fails.
   */
  ensureRoom(
    appId: string,
    contextId: string,
    title: string,
  ): Promise<string | null>;

  /**
   * Ensures a chat user exists for the given domain user and returns a token.
   * `storedPassword` is the password the comms service has cached (or null
   * for first-time users). Implementations are free to rotate legacy
   * credentials transparently and return the new secret in `password`.
   */
  ensureUserToken(
    domainUserId: string,
    displayName: string,
    storedPassword: string | null,
  ): Promise<ChatUserToken | null>;

  /**
   * Updates a user's display name. Intended to be called only when the
   * cached display name differs from the requested one.
   */
  updateDisplayName(
    accessToken: string,
    userRef: string,
    displayName: string,
  ): Promise<boolean>;

  /**
   * Invites a user to a room and joins them. Implementations should be
   * idempotent — redundant invite/join calls must be cheap or no-op.
   */
  inviteAndJoin(
    roomRef: string,
    userRef: string,
    memberAccessToken: string,
  ): Promise<void>;

  /**
   * Logs a member out, invalidating their token so later authorize calls
   * have to re-login. Called from `RoomsService.close`.
   */
  logoutMember(domainUserId: string, accessToken: string): Promise<void>;
}
