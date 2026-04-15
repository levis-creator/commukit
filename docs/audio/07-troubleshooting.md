# 07 — Troubleshooting

## Symptom → Cause Table

| Symptom | Likely cause |
|---|---|
| `audioBridge: { status: "unavailable", reason: "Janus service unreachable" }` | Janus down or `JANUS_HTTP_URL` wrong. Check comms `/health`. |
| `audioBridge: { status: "unavailable", reason: "AudioBridge room not provisioned" }` | Room mode is `REMOTE` (video-only). Re-provision with `IN_PERSON` or `HYBRID` if you need a separate AudioBridge. |
| `audioBridge: null` in the session response | Room mode is `REMOTE`. Audio travels inside the VideoRoom — there is no AudioBridge. |
| Client joins but hears silence | Either nobody else is unmuted, or the client forgot to attach the `onremotestream` callback to an `<audio>` element and call `.play()`. |
| Client can hear but can't be heard | Local stream permissions denied, or the SDP offer was created without audio. Check browser mic permissions. |
| Server mute doesn't stick | Room isn't `ACTIVE` — mute requires `ACTIVE`. Or the participant joined after your mute call and was auto-unmuted; re-issue after they're in. |
| Unmute returns 404 intermittently | The user hasn't finished joining the AudioBridge yet. Retry with backoff (300ms → 600ms → 900ms) before surfacing the error. |
| `403 Session invalidated for this context` on re-auth | User was kicked + session invalidated. Expected. |
| `409 Room already provisioned with mode X` | Attempted mode change. Modes are immutable — close the old room and create a new context. |
| Moderation returns `404 participant not found` | Client display name doesn't follow `Name\|domainUserId`. Fix the client or accept fuzzy-match warnings. |
| `403 Cannot target HARDWARE handle` | Tried to moderate a reserved `\|HARDWARE` participant. Refuse by design. |
| Echo / feedback | Two devices in the same physical room both joined the room with mics on. Use `mute-room` or rely on client-side echo cancellation. |
| Works on WiFi, fails on cellular | Symmetric NAT — needs TURN. If you're on `IN_PERSON` mode and aren't getting ICE servers, configure the client's Janus SDK with your own TURN config, or switch to `HYBRID`. |
| Audio quality drops | Check the publisher's upstream bandwidth. Opus in Janus can be capped via `default_bitrate` on the AudioBridge plugin — lower it for constrained networks. |
| One user sounds much louder than others | `volume_level` on that participant is higher. Use `configure` with `volume` to normalize per-participant gain. |

## Diagnostics Checklist

When audio is broken for a specific user:

1. `GET /health` on comms-service — is Janus connectivity up?
2. Query `communication_rooms` for the context — is `status = ACTIVE`
   and `janusAudioRoomId` non-null?
3. Query `communication_memberships` for the user — is `leftAt` null?
4. Query `communication_audit_logs` filtered by `roomId` — look for a
   recent `USER_AUTHORIZED` followed by a later `SESSION_INVALIDATED`
   or `PARTICIPANT_KICKED_AUDIO`.
5. Call `GET /internal/v1/rooms/:id/participants` — does the user's
   display appear in the roster? If yes, they're in the mixer.
6. Check the client console for ICE candidate gathering — look for at
   least `host` and `srflx` candidates.
7. Check Janus logs for SDP negotiation errors on the corresponding
   room id.

## Common Client-Side Gotchas

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

AudioBridge's mixing cost is linear in the number of **actively
speaking** participants, not total participants. Hundreds of listeners
with only a handful of speakers is cheap. Hundreds of simultaneous
speakers starts to load the mixer CPU.

Tips for large rooms:

- Pair AudioBridge with a client-side push-to-talk or raise-hand flow
  so only a few participants are unmuted at any given time.
- Use `mute-room` as a default and unmute individuals on demand — this
  is exactly the "grant the floor" pattern most large conference apps
  need.
- Monitor Janus's `audiobridge` event stream for CPU warnings.
- If you need true webinar scale (thousands of listeners), consider
  using AudioBridge for the speaker panel and a separate HLS/DASH
  re-stream for listeners — comms-service doesn't do this out of the
  box.

## Reference Files

| File | What it does |
|---|---|
| `src/rooms/rooms.service.ts` | Orchestration, lifecycle, moderation dispatch |
| `src/janus/janus.service.ts` | AudioBridge provisioning, participant lookup |
| `src/rooms/rooms.controller.ts` | Internal REST surface |
| `src/auth/internal-jwt.guard.ts` | Service-to-service JWT verification |
| `prisma/schema.prisma` | The four comms tables |
| `docs/chat/` | Chat capability (Matrix Synapse) |
| `docs/video/` | Video capability (Janus VideoRoom) |
| `docs/INTEGRATION_GUIDE.md` | Broader 8-step onboarding (chat + audio + video) |
