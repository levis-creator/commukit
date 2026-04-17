# 07 — Troubleshooting

## Symptom -> Cause Table

### General (both providers)

| Symptom | Likely cause |
|---|---|
| `audioBridge: { status: "unavailable", reason: "..." }` | Media provider down or misconfigured. Check comms `/health`. |
| `audioBridge: null` in the session response | Room mode is `REMOTE`. Audio travels inside the VideoRoom — there is no AudioBridge. |
| Server mute doesn't stick | Room isn't `ACTIVE` — mute requires `ACTIVE`. Or the participant joined after your mute call and was auto-unmuted; re-issue after they're in. |
| Unmute returns 404 intermittently | The user hasn't finished joining the audio room yet. Retry with backoff (300ms -> 600ms -> 900ms) before surfacing the error. |
| `403 Session invalidated for this context` on re-auth | User was kicked + session invalidated. Expected. |
| `409 Room already provisioned with mode X` | Attempted mode change. Modes are immutable — close the old room and create a new context. |
| `403 Cannot target HARDWARE handle` | Tried to moderate a reserved `\|HARDWARE` participant. Refused by design. |
| Echo / feedback | Two devices in the same physical room both joined with mics on. Use `mute-room` or rely on client-side echo cancellation. |
| Works on WiFi, fails on cellular | Symmetric NAT — needs TURN. See provider-specific sections below. |

### LiveKit-specific

| Symptom | Likely cause |
|---|---|
| `audioBridge: { status: "unavailable", reason: "LiveKit service unreachable" }` | LiveKit server down or `LIVEKIT_API_URL` wrong. Check comms `/health`. |
| Client gets `token expired` or `token not valid yet` | LiveKit participant token has a 15-min TTL. Re-call `authorize-user` to get a fresh token. Check clock skew between comms-service and LiveKit server. |
| `room not found` on connect | Room was closed or never activated. Verify the room is `ACTIVE` via the comms API. |
| Client connects but no audio | Microphone not enabled after connect. Call `room.localParticipant.setMicrophoneEnabled(true)` explicitly. |
| TURN/ICE failures with LiveKit | Check LiveKit server TURN config. Ensure `rtc.turn_servers` is set in `livekit.yaml` if clients are behind restrictive NATs. |
| Participant identity mismatch | The comms service sets identity via JWT metadata. If you see unexpected identities, check that `authorize-user` is being called with the correct `domainUserId`. |

### Janus-specific

| Symptom | Likely cause |
|---|---|
| `audioBridge: { status: "unavailable", reason: "Janus service unreachable" }` | Janus down or `JANUS_HTTP_URL` wrong. Check comms `/health`. |
| `audioBridge: { status: "unavailable", reason: "AudioBridge room not provisioned" }` | Room mode is `REMOTE` (video-only). Re-provision with `IN_PERSON` or `HYBRID`. |
| Client joins but hears silence | Either nobody else is unmuted, or the client forgot to attach the `onremotestream` callback to an `<audio>` element and call `.play()`. |
| Client can hear but can't be heard | Local stream permissions denied, or the SDP offer was created without audio. Check browser mic permissions. |
| Moderation returns `404 participant not found` | Client display name doesn't follow `Name\|domainUserId`. Fix the client or accept fuzzy-match warnings. |
| Audio quality drops | Check the publisher's upstream bandwidth. Opus in Janus can be capped via `default_bitrate` on the AudioBridge plugin — lower it for constrained networks. |
| One user sounds much louder than others | `volume_level` on that participant is higher. Use `configure` with `volume` to normalize per-participant gain. |
| Janus session timeout | Janus sessions expire after inactivity. Ensure the client sends keepalive messages on the WebSocket. |
| Room cache stale | Comms caches Janus room IDs in Redis. If Janus was restarted, the cache may reference rooms that no longer exist. Restart comms-service or wait for cache TTL. |
| WebSocket disconnects | Check network stability and Janus WebSocket transport config (`janus.transport.websockets.jcfg`). Increase `ws_logging` for debug output. |
| TURN needed for Janus audio-only | `IN_PERSON` mode doesn't include `iceServers` in the response. Configure the Janus client SDK with your own TURN config, or switch to `HYBRID`. |

## Diagnostics Checklist

When audio is broken for a specific user:

1. `GET /health` on comms-service — is the media provider connectivity up?
2. Query `communication_rooms` for the context — is `status = ACTIVE`
   and `audioRoomId` non-null?
3. Query `communication_memberships` for the user — is `leftAt` null?
4. Query `communication_audit_logs` filtered by `roomId` — look for a
   recent `USER_AUTHORIZED` followed by a later `SESSION_INVALIDATED`
   or `PARTICIPANT_KICKED_AUDIO`.
5. Call `GET /internal/v1/rooms/:id/participants` — does the user
   appear in the roster? If yes, they're in the mixer.
6. **LiveKit:** Check LiveKit dashboard or API for room/participant
   state. Verify token hasn't expired.
7. **Janus:** Check client console for ICE candidate gathering — look
   for at least `host` and `srflx` candidates. Check Janus logs for SDP
   negotiation errors on the corresponding room id.

## Common Client-Side Gotchas

### LiveKit

- **Not enabling microphone after connect** — `Room.connect()` does not
  auto-publish audio. Call `setMicrophoneEnabled(true)` explicitly.
- **Stale tokens** — tokens expire after 15 minutes. If a user has been
  idle and tries to reconnect, they need a fresh `authorize-user` call.
- **Not handling `RoomEvent.Disconnected`** — implement reconnection
  logic. Re-authorize to get a new token if needed.
- **Mixing up client-side mute and server-side mute** — same issue as
  Janus. If the host muted you server-side, toggling your local mic
  won't re-open the track. Surface the distinction in your UI.

### Janus

- **Forgetting `display`** — without `Name|domainUserId` the server
  falls back to substring matching and may target the wrong user when
  names collide.
- **No `<audio>` element attached** — the mixed stream arrives but
  nothing plays. Attach to a hidden `<audio autoplay>` element and
  call `.play()` inside a user-gesture handler to satisfy browser
  autoplay policies.
- **Not detaching on leave** — leaks a Janus session. Always call
  `audiobridge.send({ message: { request: 'leave' } })`,
  `audiobridge.detach()`, and `janus.destroy()` on teardown.
- **Mixing up client-side mute and server-side mute** — if the host
  muted you server-side, your local `configure: { muted: false }`
  won't re-open the mix. Surface the distinction in your UI.
- **Joining before room is ACTIVE** — your authorize call may succeed
  but Janus will error on `join` if the plugin doesn't have the room
  yet. Always activate first.

## Scaling

Audio mixing cost is linear in the number of **actively speaking**
participants, not total participants. Hundreds of listeners with only a
handful of speakers is cheap.

Tips for large rooms:

- Pair audio with a client-side push-to-talk or raise-hand flow
  so only a few participants are unmuted at any given time.
- Use `mute-room` as a default and unmute individuals on demand — this
  is exactly the "grant the floor" pattern most large conference apps
  need.
- **LiveKit:** Scales horizontally across multiple nodes. Use LiveKit's
  built-in load balancing for large deployments.
- **Janus:** Monitor the AudioBridge event stream for CPU warnings.
  Hundreds of simultaneous speakers loads the mixer CPU.
- If you need true webinar scale (thousands of listeners), consider
  using the audio mixer for the speaker panel and a separate HLS/DASH
  re-stream for listeners — comms-service doesn't do this out of the
  box.

## Reference Files

| File | What it does |
|---|---|
| `src/rooms/rooms.service.ts` | Orchestration, lifecycle, moderation dispatch |
| `src/providers/media-provider.interface.ts` | Media provider interface (LiveKit and Janus implement this) |
| `src/livekit/livekit.service.ts` | LiveKit provider — room creation, token minting, moderation |
| `src/janus/janus.service.ts` | Janus provider — AudioBridge provisioning, participant lookup |
| `src/rooms/rooms.controller.ts` | Internal REST surface |
| `src/auth/internal-jwt.guard.ts` | Service-to-service JWT verification |
| `prisma/schema.prisma` | The four comms tables |
| `docs/chat/` | Chat capability (Matrix Synapse) |
| `docs/video/` | Video capability (LiveKit / Janus VideoRoom) |
| `docs/INTEGRATION_GUIDE.md` | Broader 8-step onboarding (chat + audio + video) |
| `docs/PROVIDERS.md` | Full provider abstraction documentation |
