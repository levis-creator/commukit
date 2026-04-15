# 07 — Troubleshooting

## Symptom → Cause Table

| Symptom | Likely cause |
|---|---|
| `videoRoom: { status: "unavailable", reason: "Janus service unreachable" }` | Janus Gateway down or `JANUS_HTTP_URL` wrong. Check comms `/health`. |
| `videoRoom: { status: "unavailable", reason: "VideoRoom not provisioned" }` | Room mode is `IN_PERSON` (audio-only). Re-provision with `HYBRID` or `REMOTE`. |
| Client connects but sees no remote video | Subscribe step missing. Check that you handle `publishers` in both the initial `joined` event and subsequent `event` messages. |
| Local video works, remote participants can't see you | You're not publishing. Check `configure` request includes `audio: true, video: true` and the SDP offer carries media lines. |
| Connection stalls on ICE gathering | TURN creds missing or wrong. Verify `iceServers` in the session response contains TURN entries, and that the TURN server is reachable from the client. |
| Works on WiFi, fails on cellular | Symmetric NAT — needs TURN (not just STUN). Switch to `turns:` over 443 if cellular carriers block UDP. |
| `403 Session invalidated for this context` on re-auth | User was kicked and had their session invalidated. Expected. |
| `409 Room already provisioned with mode X` | Attempted mode change. Modes are immutable; close the old room and create a new context. |
| Kick returns 404 "participant not found" | Client display name doesn't follow `DisplayName\|domainUserId`. Fix the client or expect fuzzy-match warnings. |
| Cannot kick a user — `403 Cannot target HARDWARE handle` | Tried to moderate a reserved `\|HARDWARE` participant. Refuse by design. |
| Echo / feedback in the audio | Two clients on the same physical device joined the same room. Or hardware has no echo cancellation — mute the physical room's mic when passing the floor. |
| Participants see each other briefly then drop | Janus ICE restart loop — usually a TURN misconfiguration. Check coturn logs. |
| Quality drops with many participants | Normal SFU bandwidth scaling. Enable simulcast on publishers and let subscribers pick lower layers. |

## Diagnostics Checklist

When video is broken for a specific user:

1. `GET /health` on comms-service — is Janus connectivity up?
2. Query `communication_rooms` for the context — is `status = ACTIVE`?
   Is `janusVideoRoomId` non-null?
3. Query `communication_memberships` for the user — is `leftAt` null?
4. Query `communication_audit_logs` filtered by `roomId` — look for a
   recent `USER_AUTHORIZED` for this user followed by a later
   `SESSION_INVALIDATED` or `PARTICIPANT_KICKED_VIDEO`.
5. Call `GET /internal/v1/rooms/:id/participants` — does the user's
   display appear? If yes, they're in the room at the Janus level.
6. Check the client console for ICE candidate gathering — are
   `host` / `srflx` / `relay` candidates appearing?
7. Check coturn logs for allocation requests from the client's IP.
8. Check Janus logs for SDP negotiation errors on the corresponding
   room id.

## Common Client-Side Gotchas

- **Forgetting to set `display`** — without `Name|domainUserId` the
  server falls back to substring matching, which can target the wrong
  user when names collide.
- **Not handling `publishers` updates** — new joiners aren't
  automatically attached. You must subscribe when the `event` message
  arrives with a non-empty `publishers` array.
- **Not detaching on unmount** — leaks a Janus session and a WebRTC
  peer connection. Always call `videoroom.detach()` and `janus.destroy()`
  on teardown.
- **Reusing a session across calls** — Janus plugin handles are
  room-scoped. Create a fresh handle per room.
- **Forgetting to call `end` / `hangup`** — the room stays `ACTIVE`
  indefinitely. Always pair `start` with `close` in your lifecycle.

## Reference Files

| File | What it does |
|---|---|
| `src/rooms/rooms.service.ts` | Orchestration, lifecycle, moderation dispatch |
| `src/janus/janus.service.ts` | VideoRoom provisioning, participant lookup, ICE config |
| `src/rooms/rooms.controller.ts` | Internal REST surface |
| `src/auth/internal-jwt.guard.ts` | Service-to-service JWT verification |
| `prisma/schema.prisma` | The four comms tables |
| `docs/chat/` | Chat capability (Matrix Synapse) |
| `docs/INTEGRATION_GUIDE.md` | Broader 8-step onboarding (chat + audio + video) |
