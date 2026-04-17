# 06 — Security & Privacy

## Access Control

- Audio rooms are private. Only users your backend explicitly
  authorizes via `authorize-user` can obtain room credentials.
- `invalidate-session` is the primary mechanism for removing a user.
  After it runs, `authorize-user` for that `(room, user)` pair returns
  `403`.

### With LiveKit (default)

- Rooms are named `comms-{hash}` — opaque to clients.
- Access is controlled via short-lived JWT tokens (15-min expiry,
  HS256-signed with `LIVEKIT_API_SECRET`). A leaked token expires
  quickly and cannot be refreshed without going through
  `authorize-user` again.
- Participant identity is embedded in the JWT metadata by the comms
  service. Clients cannot forge or change their identity.
- LiveKit server validates the token on connect — no valid token, no
  access.

### With Janus

- Room IDs are integers Janus generates. Don't rely on obscurity —
  rely on the membership table. A leaked room id is still useless to
  anyone not already authorized, because Janus enforces the room's
  PIN / allowed-list as comms configures it.
- Participant identity relies on the `DisplayName|domainUserId` display
  name convention set by the client.

## Service-to-Service Auth

Both providers use the same internal JWT for service-to-service auth
between consumer backends and the comms service:

- Signed with `INTERNAL_SERVICE_SECRET` (HS256)
- `aud: "communications-service"`, short TTL (60s)
- Every internal endpoint requires a valid internal JWT

## TURN Credentials

Audio clients use the same TURN/STUN configuration as the video
capability:

### With LiveKit (default)

- LiveKit manages ICE/TURN configuration through its server config.
  Clients receive ICE server info as part of the connection handshake
  automatically.
- Set `LIVEKIT_TURN_URL`, `LIVEKIT_TURN_USERNAME`,
  `LIVEKIT_TURN_CREDENTIAL` in your LiveKit server config if needed.

### With Janus

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

- Audio between clients and the media server is encrypted in transit.
  - **LiveKit:** DTLS-SRTP for WebRTC tracks. LiveKit also supports
    end-to-end encryption via SFrame (Insertable Streams) if enabled.
  - **Janus:** DTLS-SRTP handshake. Janus terminates the encryption
    because it performs server-side mixing. This is not true E2E
    encryption.
- For true E2EE voice without server-side mixing, consider a mesh
  topology or LiveKit's E2EE mode. Standard AudioBridge mixing
  requires decryption at the server.

## Recording

Comms-service does not record by default. Recording capabilities depend
on the provider:

### With LiveKit (default)

- LiveKit supports server-side composite or track-based recording via
  its Egress API.
- Recording can be started programmatically or via LiveKit dashboard.
- Outputs to S3-compatible storage, GCS, or local filesystem.
- Supports per-track or composite recording.

### With Janus

1. Enable `record` on the AudioBridge plugin (either globally in
   `janus.plugin.audiobridge.jcfg` or per-room via the `create` request
   — requires a patch to `janus.service.ts`).
2. Mount a recording directory into the Janus container.
3. Janus writes a single Opus file per room containing the full mix.
4. Post-process with standard audio tools or `ffmpeg` to re-encode.

**With Janus you get one mixed file, not per-participant tracks.** If
you need per-speaker audio (for transcription, attribution, or isolated
editing), switch to `REMOTE` mode or use LiveKit's track-based
recording.

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
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit auth | comms-service + LiveKit server |
| `JANUS_TURN_USERNAME` / `JANUS_TURN_CREDENTIAL` | TURN credentials (Janus) | comms + coturn |

Rotating these requires a coordinated restart.

## Session Invalidation Mechanisms

Three ways an audio session ends:

1. **`kick-audio` + `invalidate-session`** — removes from the audio
   room and blocks rejoin.
2. **`closeRoom`** — destroys the audio room entirely. Everyone
   currently connected is disconnected.
3. **Client disconnect** — if the client disconnects, the provider
   removes them automatically.

Additionally, with LiveKit, token expiry (15 min) acts as a natural
session boundary. Clients must re-authorize to get a fresh token.

## What Comms Does NOT Protect Against

- **Domain-level authorization** — "is this user actually allowed in
  this voice room?" is your app's responsibility. Comms trusts the
  internal JWT and the `domainUserId` it carries.
- **Client-side credential storage.** Once credentials are handed out,
  secure storage is the client's job.
- **Bandwidth abuse.** A malicious client can try to publish extremely
  loud audio. Both providers offer volume controls and detection
  mechanisms to mitigate this.

## Audit Trail

Every state change and moderation action writes to
`communication_audit_logs`. Writes are best-effort — a failing DB write
logs loudly but doesn't roll back the primary operation. Use the log
stream as a recovery path for any entries that didn't land.
