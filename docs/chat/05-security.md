# 05 — Security Notes

## Access Tokens

- Matrix access tokens returned by `authorize-user` are **per-user** and
  scoped to that user's Matrix account. They are invalidated by
  `closeRoom`, `invalidate-session`, and kick operations.
- Never proxy a user's token to another user or log it.
- The **bot token** is never returned to clients. It lives only inside
  comms-service for admin operations (room creation, invites, registration).

## Shared Secrets

| Secret | Purpose | Must match across |
|---|---|---|
| `INTERNAL_SERVICE_SECRET` | Signs internal JWTs between consumer backends and comms | All comms replicas + every consumer backend |
| `MATRIX_REGISTRATION_SHARED_SECRET` | HMAC for `/_synapse/admin/v1/register` | comms + Synapse `homeserver.yaml` |
| `MATRIX_BOT_PASSWORD` | Bot login credential | comms replicas + whatever was used when the bot account was first created on Synapse |

Rotating any of these requires a coordinated restart. Mismatched values
cause `M_USER_IN_USE` on bot startup or signature verification failures on
internal calls.

## Room Privacy

Rooms are created as `private_chat` with:

- `history_visibility: joined` — users only see messages sent **after** they
  joined. Late joiners cannot read backfill.
- `guest_access: forbidden` — no unauthenticated access.

If you need full-history visibility for late joiners, change the preset in
`matrix.service.ts:ensureRoom`. Note that this weakens the privacy guarantee
— think carefully before flipping it.

## Session Invalidation

Three mechanisms invalidate a user's Matrix session:

1. **`POST /invalidate-session`** — marks the membership row's `leftAt` and
   logs the user out of Matrix. Future `authorizeUser` calls for that
   `(room, user)` pair return `403`.
2. **Kick (`/kick-audio`, `/kick-video`)** — removes from Janus; the caller
   typically follows up with `invalidate-session` to also block chat.
3. **`closeRoom`** — logs out every active member in bulk.

All three emit audit events to `communication_audit_logs`.

## Audit Trail

Every state-changing operation writes to `communication_audit_logs`:

- `ROOM_PROVISIONED`, `ROOM_ACTIVATED`, `ROOM_CLOSED`
- `USER_AUTHORIZED`, `SESSION_INVALIDATED`
- `MIC_MUTED`, `MIC_UNMUTED`, `ROOM_MUTED`
- `PARTICIPANT_KICKED_AUDIO`, `PARTICIPANT_KICKED_VIDEO`

Audit writes are best-effort — if the DB write fails the primary operation
still succeeds, but a loud error log preserves enough context to reconstruct
the row from application logs.

## What Comms Does NOT Protect Against

- **Domain-level authorization** (e.g. "is this user actually allowed in
  this meeting / ticket / classroom?") is the calling service's
  responsibility. Comms trusts the internal JWT and the `domainUserId` it
  carries.
- **Client-side token storage.** Once the client receives a Matrix access
  token, it's up to the client to store it securely (e.g.
  `flutter_secure_storage`).
