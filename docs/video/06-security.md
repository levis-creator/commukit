# 06 — Security & Privacy

## Service-to-Service Authentication

Both providers use the same internal JWT for service-to-service auth
between your backend and comms-service:

| Secret | Purpose | Must match across |
|---|---|---|
| `INTERNAL_SERVICE_SECRET` | Signs internal JWTs (`aud: "communications-service"`) | comms replicas + every consumer backend |

## Media Provider Security

### With LiveKit (default)

LiveKit uses **JWT participant tokens** for all access control:

- Comms-service mints a participant token (HS256, signed with
  `LIVEKIT_API_SECRET`) when `authorize-user` is called.
- Tokens expire after **15 minutes**. Clients must re-authorize to get a
  fresh token if the session outlasts the TTL (the LiveKit SDK handles
  reconnection automatically when configured).
- Each token is **room-scoped** — it grants access to exactly one room.
- Permissions are encoded in token claims:
  - `canPublish`: can send audio/video tracks
  - `canSubscribe`: can receive other participants' tracks
  - `canPublishData`: can send data messages
- Participant identity (`domainUserId`) is embedded in the token — it
  cannot be spoofed by the client.
- LiveKit has **built-in TURN** so no separate coturn is needed. Media
  connectivity works behind NAT/firewalls without extra configuration.

Secrets to protect:

| Secret | Purpose |
|---|---|
| `LIVEKIT_API_KEY` | Identifies the comms-service to LiveKit |
| `LIVEKIT_API_SECRET` | Signs participant tokens — compromise = full room access |

### With Janus

Janus does not use per-user access tokens. Access control is based on
**room membership** enforced by comms-service:

- Comms only returns VideoRoom coordinates to users authorized via
  `authorize-user`.
- `invalidate-session` is the primary mechanism for revoking access. A
  client with stale coordinates cannot rejoin once the membership row
  is marked `leftAt`.
- Room IDs are integers Janus generates — don't rely on obscurity.

Janus requires a separate **coturn** TURN server for NAT traversal:

| Secret | Purpose | Must match across |
|---|---|---|
| `JANUS_TURN_USERNAME` / `JANUS_TURN_CREDENTIAL` | TURN long-term creds | comms + coturn |

## TURN Credentials

### With LiveKit (default)

Built-in TURN — no separate credentials to manage. LiveKit negotiates
TURN internally.

### With Janus

The ICE servers array returned in the session response includes TURN
credentials that your clients will use to relay media when direct or
reflexive candidates fail:

- **Rotate TURN credentials** regularly. coturn supports
  time-limited credentials via HMAC; configure comms's
  `JANUS_TURN_USERNAME` / `JANUS_TURN_CREDENTIAL` to match whatever
  scheme your TURN server expects.
- **TLS TURN (turns:)** is recommended for production — it passes
  through strict corporate firewalls that block UDP and TCP.
- **Never expose TURN credentials to unauthenticated users**. The
  session endpoint is already authenticated; don't embed the creds in
  public HTML.

## Media Privacy

Both providers operate as an SFU — media is **SRTP-encrypted between
each client and the server**. The SFU terminates DTLS and re-encrypts
per subscriber. This is standard SFU behavior; it is not true
end-to-end encryption.

- For true E2EE you'd need Insertable Streams / SFrame at the client
  level. Comms-service doesn't provide this out of the box.
- Rooms are private: only users your backend explicitly authorizes can
  join. The media server is not directly reachable from the public
  internet without valid credentials (LiveKit token or Janus room
  coordinates returned in the session).

### LiveKit specifics

- LiveKit supports adaptive bitrate and simulcast by default, which
  limits bandwidth abuse without explicit configuration.
- Room names are opaque hashed strings (`comms-{hash}`) — not
  guessable.

### Janus specifics

- Configure `bitrate` / `bitrate_cap` on the VideoRoom plugin to
  enforce a bandwidth ceiling against malicious high-bitrate publishers.

## Session Invalidation Mechanisms

Three ways a user's video session ends:

1. **`kick-video` + `invalidate-session`** — removes from the media room
   and blocks future `authorize-user` calls. Use this for enforced
   expulsion.
2. **`closeRoom`** — destroys the media room entirely. All connected
   clients are disconnected.
3. **Client disconnect** — if the client disconnects, the provider
   removes them automatically. No server call needed.

## Recording

Comms-service does **not** record by default.

### With LiveKit

LiveKit supports server-side composite and track recording via its
Egress API. To enable, configure `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`
and call the Egress RPC from your service. Produces MP4/WebM directly.

### With Janus

Janus ships with a post-processing tool (`janus-pp-rec`) and supports
per-publisher RTP recording hooks:

1. Edit `janus.plugin.videoroom.jcfg` to set `record = true` on the
   rooms you care about (or pass `record: true` in the `create` request
   from within comms — requires a patch to `janus.service.ts`).
2. Mount a recording directory into the Janus container.
3. Run `janus-pp-rec` after the fact to produce WebM/MP4.

Before enabling recording with either provider, consult your legal team —
recording rules vary by jurisdiction, especially for 1:1 calls and
cross-border participants. Make sure your UI discloses recording clearly
and captures consent.

## What Comms Does NOT Protect Against

- **Domain-level authorization** (e.g. "is this user actually allowed in
  this call?") is the calling service's responsibility. Comms trusts the
  internal JWT and the `domainUserId` it carries.
- **Client-side credential storage.** Once the client receives session
  credentials, secure storage is the client's job (e.g.
  `flutter_secure_storage`, iOS Keychain, encrypted prefs).
- **Bandwidth abuse.** LiveKit handles this via adaptive bitrate. For
  Janus, configure `bitrate_cap` on the VideoRoom plugin.

## Audit Trail

Same table as chat and moderation: `communication_audit_logs`. Every
`USER_AUTHORIZED`, kick, mute, and lifecycle transition lands here.
Audit writes are best-effort but log loudly on failure so the row can be
reconstructed from application logs.
