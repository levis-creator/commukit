# 06 — Security & Privacy

## TURN Credentials

The ICE servers array returned in the session response includes TURN
credentials that your clients will use to relay media when direct or
reflexive candidates fail. A few things to keep in mind:

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

- Janus VideoRoom forwards media without transcoding. Media between
  clients is **SRTP-encrypted end-to-end with Janus as an intermediate
  hop** — the SFU terminates DTLS and re-encrypts per subscriber. This
  is standard SFU behavior; it's not true end-to-end encryption.
- For true E2EE you'd need Insertable Streams / SFrame at the client
  level. Comms-service doesn't provide this out of the box.
- Rooms are private: only users your backend explicitly authorizes can
  join. Janus is not reachable from the public internet — only via the
  WebSocket URL returned in the session, which comms can rotate.

## Access Token Scoping

- Unlike chat, Janus doesn't use per-user access tokens — the
  VideoRoom's access control is based on **room membership**. Comms
  enforces this by only returning the VideoRoom coordinates to
  authorized users and by validating membership on every
  `authorize-user` call.
- `invalidate-session` is the primary mechanism for removing a user's
  access. A client with stale coordinates cannot rejoin once the
  membership row is marked `leftAt`.
- Room IDs are not secret — they're integers Janus generates. Don't
  rely on obscurity. Rely on membership.

## Shared Secrets

| Secret | Purpose | Must match across |
|---|---|---|
| `INTERNAL_SERVICE_SECRET` | Signs internal JWTs | comms replicas + every consumer backend |
| `JANUS_TURN_USERNAME` / `JANUS_TURN_CREDENTIAL` | TURN long-term creds | comms + coturn (or your TURN server) |

Rotating these requires a coordinated restart.

## Session Invalidation Mechanisms

Three ways a user's video session ends:

1. **`kick-video` + `invalidate-session`** — removes from VideoRoom and
   blocks future `authorize-user` calls. Use this for enforced
   expulsion.
2. **`closeRoom`** — destroys the Janus VideoRoom entirely. Everyone
   currently subscribed sees `detached` / `hangup` events.
3. **Client disconnect** — if the client closes its Janus WebSocket,
   the VideoRoom removes them automatically. No server call needed.

## Recording

Comms-service does **not** record by default. Janus ships with a
post-processing tool (`janus-pp-rec`) and supports per-publisher RTP
recording hooks. To enable recording, you'd:

1. Edit `janus.plugin.videoroom.jcfg` to set `record = true` on the
   rooms you care about (or pass `record: true` in the `create` request
   from within comms — requires a patch to `janus.service.ts`).
2. Mount a recording directory into the Janus container.
3. Run `janus-pp-rec` after the fact to produce WebM/MP4.

Before enabling, consult your legal team — recording rules vary by
jurisdiction, especially for 1:1 calls and cross-border participants.
Make sure your UI discloses recording clearly and captures consent.

If you need recording, you may want to build an "archiver" service that
subscribes to RabbitMQ events, picks up completed recordings from disk,
and uploads them to object storage tied to your domain context id.

## What Comms Does NOT Protect Against

- **Domain-level authorization** (e.g. "is this user actually allowed in
  this call?") is the calling service's responsibility. Comms trusts the
  internal JWT and the `domainUserId` it carries.
- **Client-side credential storage.** Once the client receives the
  VideoRoom coordinates and TURN creds, secure storage is the client's
  job (e.g. `flutter_secure_storage`, iOS Keychain, encrypted prefs).
- **Bandwidth abuse.** A malicious client can try to publish extremely
  high bitrates. Configure Janus's `bitrate` / `bitrate_cap` on the
  VideoRoom plugin to enforce a ceiling.

## Audit Trail

Same table as chat and moderation: `communication_audit_logs`. Every
`USER_AUTHORIZED`, kick, mute, and lifecycle transition lands here.
Audit writes are best-effort but log loudly on failure so the row can be
reconstructed from application logs.
