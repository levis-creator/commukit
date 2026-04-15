# 06 — Troubleshooting

## Symptom → Cause Table

| Symptom | Likely cause |
|---|---|
| `chat: { status: "unavailable", reason: "Matrix service unreachable" }` | Synapse down or `MATRIX_SERVER_URL` wrong. Check `/health`. |
| `M_USER_IN_USE` during bot startup | `MATRIX_BOT_PASSWORD` doesn't match what Synapse has stored for the bot account. |
| `403 Session invalidated for this context` on re-auth | The user was kicked or the room was closed. Expected behavior. |
| `409 Room already provisioned with mode X` | Attempted mode change. Modes are immutable; close the old room and provision a new context. |
| User joins but can't see earlier messages | Expected — `history_visibility: joined`. See [05-security.md](05-security.md). |
| Display name not updating in Matrix | Comms skips the `PUT` when `matrixDisplayName` already matches. Inspect `communication_users` directly if you suspect drift. |
| Authorize call returns fast but no invite arrives | Hit the 10s authorize cooldown. Wait it out, or check the `comms:authorize:cooldown:*` Redis key. |
| `401 Unauthorized` on internal calls | Internal JWT `aud` not `communications-service`, or `INTERNAL_SERVICE_SECRET` mismatch. |
| Matrix `M_LIMIT_EXCEEDED` at startup | Synapse rate-limited bot login. Comms retries up to 3 times with backoff — usually self-heals. |

## Diagnostics Checklist

When chat is broken for a specific user:

1. `GET /health` on comms-service — is Matrix connectivity up?
2. Query `communication_rooms` for the context — status `ACTIVE`?
   `matrixRoomId` non-null?
3. Query `communication_memberships` for the user — `leftAt` null?
4. Query `communication_audit_logs` filtered by `roomId` — look for the
   most recent `USER_AUTHORIZED` and check for a later
   `SESSION_INVALIDATED` or kick.
5. Check Redis: `comms:matrix:token:<domainUserId>` — is the token cached?
6. Check comms-service logs for `Matrix POST` / `Matrix GET` warnings
   around the time of the failure.

## Reference Files

| File | What it does |
|---|---|
| `src/rooms/rooms.service.ts` | Orchestration, lifecycle, authorize cooldown |
| `src/matrix/matrix.service.ts` | All Synapse HTTP, token caching, bot lifecycle |
| `src/rooms/rooms.controller.ts` | Internal REST surface |
| `src/auth/internal-jwt.guard.ts` | Service-to-service JWT verification |
| `prisma/schema.prisma` | The four comms tables |
| `docs/INTEGRATION_GUIDE.md` | Broader 8-step onboarding (chat + audio + video) |
