# 07 — Troubleshooting

## General Symptoms (Both Providers)

| Symptom | Likely cause |
|---|---|
| `videoRoom: { status: "unavailable", reason: "..." }` | Media provider down or misconfigured. Check comms `/health`. |
| `videoRoom: { status: "unavailable", reason: "VideoRoom not provisioned" }` | Room mode is `IN_PERSON` (audio-only). Re-provision with `HYBRID` or `REMOTE`. |
| `403 Session invalidated for this context` on re-auth | User was kicked and had their session invalidated. Expected. |
| `409 Room already provisioned with mode X` | Attempted mode change. Modes are immutable; close the old room and create a new context. |
| Echo / feedback in the audio | Two clients on the same physical device joined the same room. Or hardware has no echo cancellation — mute the physical room's mic when passing the floor. |

## LiveKit-Specific Issues

| Symptom | Likely cause |
|---|---|
| `401` or "token expired" when connecting | Participant token has a 15-min TTL. Re-call `authorize-user` to get a fresh token. |
| "room not found" error on connect | Room was closed or never provisioned. Check `communication_rooms` for `status = ACTIVE` and a non-null `videoRoomId`. |
| No remote tracks appearing | Check that both participants have `canPublish` and `canSubscribe` in their token claims. Verify `adaptiveStream: true` is set on the `Room` constructor. |
| Poor quality / stuttering video | Check network conditions. LiveKit uses adaptive bitrate by default. Ensure `dynacast: true` is enabled. For very constrained networks, reduce the capture resolution. |
| Connection fails behind corporate firewall | LiveKit has built-in TURN but it must be reachable. Verify the LiveKit server's TURN port (443/TCP) is not blocked. |
| Simulcast layers not working | Ensure the publisher is sending at a high enough resolution (720p+). Simulcast is only effective when the source has enough pixels to downscale. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` mismatch | Comms mints tokens the server rejects. Check that both values match between comms `.env` and the LiveKit server config. |

## Janus-Specific Issues

| Symptom | Likely cause |
|---|---|
| `videoRoom: { status: "unavailable", reason: "Janus service unreachable" }` | Janus Gateway down or `JANUS_HTTP_URL` wrong. Check comms `/health`. |
| Client connects but sees no remote video | Subscribe step missing. Check that you handle `publishers` in both the initial `joined` event and subsequent `event` messages. |
| Local video works, remote participants can't see you | You're not publishing. Check `configure` request includes `audio: true, video: true` and the SDP offer carries media lines. |
| Connection stalls on ICE gathering | TURN creds missing or wrong. Verify `iceServers` in the session response contains TURN entries, and that the TURN server is reachable from the client. |
| Works on WiFi, fails on cellular | Symmetric NAT — needs TURN (not just STUN). Switch to `turns:` over 443 if cellular carriers block UDP. |
| Kick returns 404 "participant not found" | Client display name doesn't follow `DisplayName\|domainUserId`. Fix the client or expect fuzzy-match warnings. |
| Cannot kick a user — `403 Cannot target HARDWARE handle` | Tried to moderate a reserved `\|HARDWARE` participant. Refuse by design. |
| Participants see each other briefly then drop | Janus ICE restart loop — usually a TURN misconfiguration. Check coturn logs. |
| Quality drops with many participants | Normal SFU bandwidth scaling. Enable simulcast on publishers and let subscribers pick lower layers. |
| Janus session timeout / detached unexpectedly | Janus has a default session timeout (60s). Ensure the client sends keepalive messages on the WebSocket. |
| Room cache stale after Janus restart | Comms caches room IDs in Redis. If Janus restarts and loses rooms, re-provision or restart comms to clear the cache. |

## Diagnostics Checklist

When video is broken for a specific user:

1. `GET /health` on comms-service — is media provider connectivity up?
2. Query `communication_rooms` for the context — is `status = ACTIVE`?
   Is `videoRoomId` non-null?
3. Query `communication_memberships` for the user — is `leftAt` null?
4. Query `communication_audit_logs` filtered by `roomId` — look for a
   recent `USER_AUTHORIZED` for this user followed by a later
   `SESSION_INVALIDATED` or `PARTICIPANT_KICKED_VIDEO`.
5. Call `GET /internal/v1/rooms/:id/participants` — does the user appear?
   If yes, they're in the room at the media provider level.
6. Check the client console for connection errors:
   - **LiveKit:** Look for token errors, room-not-found, or
     `SignalClient` connection failures.
   - **Janus:** Check ICE candidate gathering — are `host` / `srflx` /
     `relay` candidates appearing?
7. **Janus only:** Check coturn logs for allocation requests from the
   client's IP.
8. Check media provider logs for errors on the corresponding room.

## Common Client-Side Gotchas

### Both providers

- **Not handling disconnects / teardown** — leaks connections and peer
  resources. Always call `room.disconnect()` (LiveKit) or
  `videoroom.detach()` + `janus.destroy()` (Janus) on unmount.
- **Forgetting to call `end` / `hangup`** — the room stays `ACTIVE`
  indefinitely. Always pair `start` with `close` in your lifecycle.
- **Not branching on `videoRoom.status`** — if `"unavailable"`, show a
  fallback UI instead of attempting to connect.

### LiveKit-specific

- **Not awaiting `room.connect()`** — publishing before connected throws.
- **Ignoring token refresh** — for long sessions, re-authorize before the
  15-min token expires or rely on the SDK's automatic reconnect.

### Janus-specific

- **Forgetting to set `display`** — without `Name|domainUserId` the
  server falls back to substring matching, which can target the wrong
  user when names collide.
- **Not handling `publishers` updates** — new joiners aren't
  automatically attached. You must subscribe when the `event` message
  arrives with a non-empty `publishers` array.
- **Reusing a session across calls** — Janus plugin handles are
  room-scoped. Create a fresh handle per room.

## Reference Files

| File | What it does |
|---|---|
| `src/rooms/rooms.service.ts` | Orchestration, lifecycle, moderation dispatch |
| `src/janus/janus.service.ts` | Janus VideoRoom provisioning, participant lookup, ICE config |
| `src/livekit/livekit.service.ts` | LiveKit room creation, token minting, participant management |
| `src/rooms/rooms.controller.ts` | Internal REST surface |
| `src/auth/internal-jwt.guard.ts` | Service-to-service JWT verification |
| `prisma/schema.prisma` | The four comms tables |
| `docs/chat/` | Chat capability (Matrix Synapse) |
| `docs/INTEGRATION_GUIDE.md` | Broader 8-step onboarding (chat + audio + video) |
