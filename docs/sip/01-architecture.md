# 01 — Architecture

## Stack Overview

```
┌──────────────┐  internal JWT  ┌────────────────────────┐
│ Consumer app │ ─────────────▶ │ communications-service │
│  backend     │                │  (rooms + SipService)  │
└──────┬───────┘                └───────────┬────────────┘
       │ scoped session                     │ credentials +
       │ (chat, audio, video, sip)          │ admin APIs
       ▼                                    ▼
┌──────────────┐                  ┌────────────────────┐
│ Web client   │ ────WebRTC────▶  │ Janus AudioBridge  │
└──────────────┘                  │      (mixer)       │
                                  └─────────┬──────────┘
                                            │ plain-RTP
                                            │ participant
┌──────────────┐                            │
│ SIP softphone │ ──REGISTER──┐    ┌───────────────────┐
│ (Linphone,   │              │    │ Janus SIP plugin  │
│  Zoiper, …)  │ ───INVITE───▶│    │ (registered as    │
└──────────────┘              │    │  janus@comms.local)│
                              ▼    └─────────▲─────────┘
                       ┌─────────────┐       │
                       │  Kamailio   │───────┘
                       │ (registrar  │  routes INVITE
                       │  + proxy)   │  to Janus
                       └──────┬──────┘
                              │ DIGEST auth
                              ▼
                       ┌──────────────┐
                       │  Postgres    │
                       │ subscriber   │
                       │    table     │
                       └──────────────┘
```

## The Four Pieces

1. **Kamailio (`comms-kamailio` container)** — a 12 MB alpine sidecar
   that acts as the SIP registrar and proxy. Authenticates softphones
   via SIP DIGEST against the shared `subscriber` table in the comms
   Postgres. Routes INVITEs whose To-URI matches `room-*@<domain>` to
   the registered Janus SIP bridge. Rejects all other INVITEs with 404
   — no PSTN, no federation.

2. **Janus SIP plugin** — already shipped with the canyan/janus-gateway
   image. Registers itself with Kamailio as `sip:janus@<domain>` so
   Kamailio can forward room INVITEs to it. When an INVITE arrives, the
   plugin accepts the call and bridges the audio into the appropriate
   AudioBridge room as a plain-RTP participant. (Phase 4 NestJS wiring
   is pending — see `docs/sip/README.md#whats-not-in-v1`.)

3. **comms-service `SipService`** — issues SIP credentials per domain
   user alongside the existing Matrix credential flow. Credentials are
   minted lazily on first authorize, persisted to
   `communication_users.sipUsername` / `.sipPassword`, and written to
   Kamailio's `subscriber` table so DIGEST auth can use them.

4. **PostgreSQL** — shared database. Comms-service writes `subscriber`
   rows via raw SQL (the table isn't in our Prisma schema; it belongs
   to Kamailio). Kamailio reads `subscriber` for REGISTER auth and
   writes `location` for active contact bindings. The boundary is
   clean: comms-service writes credentials, Kamailio writes bindings,
   neither touches the other's tables.

## Room URI Scheme

Each comms room with an AudioBridge gets a SIP URI of the form:

```
sip:room-<contextId>@<SIP_DOMAIN>
```

Example: for a `SITTING` context with id `4f8a2b31-...`, the URI is
`sip:room-4f8a2b31-...@comms.local`. The `room-` prefix is how
Kamailio's routing logic recognizes an INVITE as a room-join request
vs. a user-to-user call (the latter is not supported).

## Credential Lifecycle

Mirrors the Matrix credential lifecycle in `MatrixService`:

```
First authorize → SipService.ensureUserCredentials()
                  ├─ generate comms_<16chars> username
                  ├─ generate random 24-byte password
                  ├─ compute HA1 + HA1B hashes
                  ├─ UPSERT into subscriber table (Kamailio)
                  ├─ persist to communication_users (Prisma)
                  └─ return creds in session response

Subsequent       → return cached creds from communication_users
authorize          ├─ best-effort re-upsert into subscriber
                   └─ no password rotation unless explicitly asked
```

Consumer apps can call `POST /internal/v1/users/sip-credentials`
outside the room flow to mint credentials for a settings screen where
the user pairs their softphone once and never touches it again.

## What's Already Wired vs What's Pending

**Wired (v1):**
- All schema changes
- `SipService` credential issuance (database path)
- Kamailio subscriber table writes (raw SQL via Prisma)
- Kamailio sidecar + config
- Janus SIP plugin config file + volume mount
- Session response `sip` field
- `/users/sip-credentials` standalone endpoint
- Health endpoint `sip` status
- Docker Compose profile gating

**Pending (Phase 4 follow-up):**
- `JanusService.ensureSipBridgeRegistered()` — long-lived registrar handle
- `JanusService.acceptInboundSipCall()` — `incomingcall` event handling
- `JanusService.hangupSipCall()` — teardown + Redis state
- HTTP long-poll worker for async SIP event correlation
- Wiring `SIP_CALL_*` audit log keys in `RoomsService`
- AudioBridge plain-RTP participant attach on accept

These can be built without breaking anything that's already in place.
`SipService` stays stable; `JanusService` grows a new section alongside
its existing AudioBridge and VideoRoom code.

See the approved plan at
`/home/levi/.claude/plans/prancy-hugging-popcorn.md` — Phase 4 — for
the exact request sequence the follow-up needs to implement.
