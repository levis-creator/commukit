# 06 — Security & Privacy

## Access Control

- AudioBridge rooms are private. Only users your backend explicitly
  authorizes via `authorize-user` can obtain the Janus room
  coordinates.
- Room IDs are integers Janus generates. Don't rely on obscurity —
  rely on the membership table. A leaked room id is still useless to
  anyone not already authorized, because Janus enforces the room's
  PIN / allowed-list as comms configures it.
- `invalidate-session` is the primary mechanism for removing a user.
  After it runs, `authorize-user` for that `(room, user)` pair returns
  `403`, and the client's cached coordinates stop working because the
  participant has been kicked server-side.

## TURN Credentials

AudioBridge clients use the same TURN/STUN configuration as the video
capability:

- Set `JANUS_ICE_SERVERS`, `JANUS_TURN_USERNAME`, `JANUS_TURN_CREDENTIAL`
  on comms-service. These are included in session responses that carry
  a `videoRoom` entry.
- For pure `IN_PERSON` rooms, the session response has `videoRoom:
  null`, so `iceServers` isn't carried. In practice voice-only clients
  work fine with the default `stun:stun.l.google.com:19302`, but if you
  need TURN for audio on restrictive networks you can:
  - Configure the Janus client SDK with your own `iceServers` array
    pulled from your backend config.
  - Or pick `HYBRID` mode (with video off client-side) to get the full
    ICE server list inside the session response.

## Media Privacy

- Audio between clients and Janus is **SRTP-encrypted** (DTLS-SRTP
  handshake). Janus terminates the encryption — it has to, because it's
  doing the mix. This is standard for server-mixer audio; it's not
  true end-to-end encryption.
- For true E2EE voice, you'd need a mesh topology (no mixer) and
  Insertable Streams / SFrame. Comms-service doesn't provide this.
- If you're building a product where E2EE is a hard requirement (legal
  privilege, activist communication, health data), AudioBridge is not
  the right choice — consider a mesh P2P solution at a different layer.

## Recording

Comms-service does not record by default. AudioBridge supports
server-side recording of the mix:

1. Enable `record` on the AudioBridge plugin (either globally in
   `janus.plugin.audiobridge.jcfg` or per-room via the `create` request
   — requires a patch to `janus.service.ts`).
2. Mount a recording directory into the Janus container.
3. Janus writes a single Opus file per room containing the full mix.
4. Post-process with standard audio tools or `ffmpeg` to re-encode.

**You're getting one mixed file, not per-participant tracks.** If you
need per-speaker audio (for transcription, attribution, or isolated
editing), switch to `REMOTE` mode — VideoRoom records per-publisher.

### Consent and disclosure

Recording voice has legal implications that vary by jurisdiction. Before
enabling:

- Talk to your legal team — some jurisdictions require all-party
  consent, others one-party, others outright bans in certain contexts.
- Your UI must clearly disclose that recording is on before the user
  joins. A "recording in progress" indicator should be visible
  throughout.
- Store the consent event in an audit trail so you can prove
  disclosure later.

## Shared Secrets

| Secret | Purpose | Must match across |
|---|---|---|
| `INTERNAL_SERVICE_SECRET` | Signs internal JWTs | comms replicas + every consumer backend |
| `JANUS_TURN_USERNAME` / `JANUS_TURN_CREDENTIAL` | TURN credentials | comms + coturn |

Rotating these requires a coordinated restart.

## Session Invalidation Mechanisms

Three ways an audio session ends:

1. **`kick-audio` + `invalidate-session`** — removes from AudioBridge
   and blocks rejoin.
2. **`closeRoom`** — destroys the Janus AudioBridge room entirely.
   Everyone currently connected sees a `leaving` / `detached` event.
3. **Client disconnect** — if the client closes its Janus WebSocket,
   AudioBridge removes them automatically.

## What Comms Does NOT Protect Against

- **Domain-level authorization** — "is this user actually allowed in
  this voice room?" is your app's responsibility. Comms trusts the
  internal JWT and the `domainUserId` it carries.
- **Client-side credential storage.** Once coordinates are handed out,
  secure storage is the client's job.
- **Bandwidth abuse.** A malicious client can try to publish extremely
  loud audio. AudioBridge has a `volume_level` cap; Janus's
  `audiolevel_event` plugin can also detect and alert on pathological
  clients.

## Audit Trail

Every state change and moderation action writes to
`communication_audit_logs`. Writes are best-effort — a failing DB write
logs loudly but doesn't roll back the primary operation. Use the log
stream as a recovery path for any entries that didn't land.
