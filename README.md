# Communications Service

A reusable NestJS microservice that provides room-based **chat**, **audio**, and **video** by abstracting [Matrix Synapse](https://matrix.org/docs/projects/server/synapse) (chat) and [Janus Gateway](https://janus.conf.meetecho.com/) (WebRTC audio/video) behind a small, app-owned REST contract.

Any backend — written in any language, on any framework — can provision rooms, authorize users, and receive session credentials without embedding Matrix or Janus-specific logic. The service is multi-tenant: many consumer apps can share a single deployment, isolated by `appId`.

---

## What This Server Is For

Real-time communication is hard to build well. Spinning up Matrix, Janus, coturn, and the glue between them — and then maintaining all of that as your app evolves — is months of work that has very little to do with your actual product.

This service collapses that work into a handful of HTTP calls:

- **Provision a room** for any domain context you care about (a meeting, a ticket, a classroom, a 1:1 call, a support thread).
- **Authorize a user** for that room and receive scoped credentials they can hand to a chat / WebRTC client.
- **Moderate** participants (mute, kick, mute-all, invalidate-session) with a server-enforced audit trail.
- **Close the room** when the context ends; cached tokens are invalidated and resources are released.

Your backend never touches Matrix or Janus directly. Your client talks to those services with the credentials this server hands out. **The communications-service is not a media relay** — once the client has the credentials, media flows directly between the client and Matrix/Janus.

### Who Should Use It

- Any team that wants chat, voice, or video in a product **without owning the Matrix/Janus operational burden**.
- Teams running multiple apps that should share one comms backbone.
- Products with real-time domain events (meetings, calls, sessions, classes, tickets) that need server-enforced moderation and an audit trail.

### When You Should NOT Use It

- You need **end-to-end encrypted** media. SFU/mixer architectures terminate encryption at the server. For true E2EE, look at mesh P2P or SFrame-based stacks.
- You need **massive broadcast scale** (10k+ concurrent listeners). Pair this service with a separate HLS/DASH re-streamer or a purpose-built platform.
- You need **PSTN telephony** (real phone numbers). Use a SIP trunk gateway or Twilio/etc. — out of scope here.
- You need **a chat platform users discover and federate with**. Matrix supports federation, but this service deliberately uses private rooms scoped to your app. It's an embedded primitive, not a standalone Matrix homeserver.

---

## What You Need to Know Before Using It

A short orientation so the rest of the docs make sense.

### Mental Model

```
┌────────────┐  internal JWT   ┌──────────────────────┐
│  Your app  │ ──────────────▶ │ communications-service │
│  backend   │                 │  (rooms / lifecycle)   │
└─────┬──────┘                 └──────────┬───────────┘
      │ scoped creds                      │ admin APIs
      ▼                                   ▼
┌────────────┐                  ┌──────────────────────┐
│ Your client │ ──── direct ───▶│ Matrix Synapse       │
│ (web/mobile)│ ──── direct ───▶│ Janus + coturn       │
└────────────┘                  └──────────────────────┘
```

Three rules to internalize:

1. **The unit of provisioning is a room.** Rooms are keyed by `(appId, contextType, contextId)`. There is no concept of "a call" or "a chat" at the API level — both are just rooms with different `mode` settings.
2. **Comms hands out credentials, not media.** Your backend authenticates with comms via internal JWT; comms returns Matrix tokens and Janus coordinates; your clients then connect to Matrix and Janus directly. Comms is never on the media path.
3. **Mode is immutable.** You pick `mode` at provision time and can't change it. Pick a new context (new `contextId`) if you need a different mode later.

### Things Your Backend Owns (Comms Does Not)

- **Domain authorization.** "Is this user actually allowed in this meeting?" Comms trusts whatever `domainUserId` your JWT carries. You decide who's allowed.
- **Signalling for calls.** Ringing a callee, declining, busy, missed-call notifications — comms doesn't do any of that. Your existing real-time channel (push, websocket, chat event) handles it.
- **Moderator privileges.** Comms enforces moderation commands but doesn't decide *who* is a moderator. Your backend gates the moderation endpoints on whatever role logic you already have.
- **Persistence of messages and recordings.** By default chat lives in Synapse, audio/video are transient. If you need a local archive, see [docs/chat/04-persistence.md](docs/chat/04-persistence.md) and [docs/audio/06-security.md#recording](docs/audio/06-security.md).

### Prerequisites

Before integrating, you should have:

- A **stable `appId`** for your application (a short identifier; scopes Matrix rooms and event filtering)
- A way to **sign JWTs** with `aud: "communications-service"` from your backend (any language with a JWT library)
- A **shared `INTERNAL_SERVICE_SECRET`** between your backend and comms-service (configured in both `.env` files)
- For media: a **TURN server** reachable from your clients in production (development can use the bundled coturn)
- For chat: nothing extra — comms-service brings its own Matrix Synapse

### Guarantees and Non-Guarantees

| Guaranteed | NOT guaranteed |
|---|---|
| Idempotent room provisioning | RabbitMQ event delivery (best-effort, fire-and-forget) |
| Server-enforced audio mute (AudioBridge mode) | Server-enforced video mute (SFU forwards unchanged) |
| Immutable audit log of all state changes | E2EE between participants — Janus terminates encryption |
| Graceful degradation when Matrix/Janus is down | Recovery of in-flight calls when Janus restarts |
| Scoped per-user Matrix tokens, invalidated on close | Recovery of cached credentials after `closeRoom` |

### Cost of an Integration

Realistically, a backend developer comfortable with HTTP + JWT can wire this into an existing app in **a day or two** for chat-only or audio-only, **two to four days** for full chat + audio + video including a moderation UI. Most of the work is on the client (Matrix SDK or Janus SDK setup), not the backend.

---

## Documentation

Capability-specific developer docs live in [`docs/`](docs/). Read the README in each folder first, then drill in:

| Capability | Index | Covers |
|---|---|---|
| **Chat** | [docs/chat/](docs/chat/README.md) | Matrix Synapse, room provisioning, persistence options |
| **Audio** | [docs/audio/](docs/audio/README.md) | Janus AudioBridge mixer, voice calls, server-enforced mute |
| **Video** | [docs/video/](docs/video/README.md) | Janus VideoRoom SFU, group video, 1-on-1 calls, moderation |
| **Onboarding** | [docs/INTEGRATION_GUIDE.md](docs/INTEGRATION_GUIDE.md) | Original 8-step end-to-end onboarding (chat + audio + video together) |

Each capability folder has the same shape: architecture → API flow → step-by-step integration → specialized topics → moderation → security → troubleshooting.

---

## Features

- **Room provisioning** — create rooms scoped by `appId` + `contextType` + `contextId`
- **Unified session** — one API call returns chat, audio, and video credentials with per-capability status
- **Multi-app support** — isolated by `appId`, no code changes needed to onboard new consumers
- **Graceful degradation** — each capability (chat, audioBridge, videoRoom) reports its own availability
- **ICE servers included** — STUN/TURN config returned in session response, clients don't need local config
- **Chat-only rooms** — `CHAT` mode provisions Matrix only (no Janus), for DMs and lightweight chat
- **Participant control** — server-side mute, unmute, kick, and room-wide mute via Janus
- **Audit trail** — all room lifecycle events are logged
- **RabbitMQ events** — publishes `communications.room.provisioned/activated/closed` on a configurable exchange

## Quick Start

### Standalone (with Docker)

This brings up the service with all dependencies (PostgreSQL, Redis, RabbitMQ, Matrix Synapse, Janus, coturn):

```bash
cd vps-ke-communications-service
cp .env.example .env     # or use the provided .env
docker compose up -d
```

Wait for all containers to be healthy, then run database migrations:

```bash
docker compose exec communications-service npx prisma migrate deploy
```

The service is now running at `http://localhost:3014`. Verify with:

```bash
curl http://localhost:3014/health
# {"status":"ok","matrix":"connected","janus":"connected"}
```

### Inside an existing monorepo

If running alongside other services that already provide Postgres / Redis / RabbitMQ, point comms at the shared infrastructure via `.env` and skip the standalone Docker stack. From a monorepo root that has the necessary npm scripts wired up:

```bash
npm run docker:dev:up    # Start shared Postgres, Redis, RabbitMQ
npm run dev:comms        # Start communications-service with hot-reload
```

### Local development (no Docker)

```bash
npm install
npx prisma generate
npx prisma migrate dev
npm run start:dev
```

Requires PostgreSQL, Redis, and RabbitMQ running locally. Matrix and Janus are optional — the service degrades gracefully if they're unavailable.

## Architecture

```
┌──────────────────┐     internal JWT      ┌──────────────────────────┐
│  Your Backend    │ ───────────────────►  │  communications-service  │
│  (any app)       │                       │                          │
│                  │ ◄── session ────────  │  Matrix ←→ chat          │
└──────────────────┘                       │  Janus  ←→ audio/video   │
                                           │  coturn ←→ NAT traversal │
         ┌─────────────┐                   └──────────────────────────┘
         │ Your Client  │                            ▲
         │ (Flutter/Web) │ ── direct with tokens ───┘
         └─────────────┘
```

**Your backend** provisions rooms and authorizes users via internal JWT-authenticated REST calls. The service returns scoped tokens. **Your clients** talk directly to Matrix (chat) and Janus (video/audio) using those tokens — the communications-service is not a relay.

## API Endpoints

All endpoints require an internal JWT (`Authorization: Bearer <token>`) with `aud: "communications-service"`.

### Room Lifecycle

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/internal/v1/rooms/provision` | Create a room for a domain context (idempotent) |
| `POST` | `/internal/v1/rooms/:contextId/activate` | Mark room ACTIVE |
| `POST` | `/internal/v1/rooms/:contextId/close` | Mark room CLOSED |
| `POST` | `/internal/v1/rooms/:contextId/authorize-user` | Get session credentials for a user |

### Participant Control

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/internal/v1/rooms/:contextId/participants` | List AudioBridge participants with mute state |
| `POST` | `/internal/v1/rooms/:contextId/mute` | Mute a single participant |
| `POST` | `/internal/v1/rooms/:contextId/unmute` | Unmute a single participant |
| `POST` | `/internal/v1/rooms/:contextId/mute-room` | Mute all participants |
| `POST` | `/internal/v1/rooms/:contextId/kick-audio` | Remove a participant from AudioBridge |
| `POST` | `/internal/v1/rooms/:contextId/kick-video` | Remove a participant from VideoRoom |
| `POST` | `/internal/v1/rooms/:contextId/invalidate-session` | Prevent a user from re-authorizing |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth required) |

### Session Response

```json
{
  "roomId": "uuid",
  "status": "ACTIVE",
  "chat": {
    "status": "available",
    "roomId": "!abc:comms.local",
    "accessToken": "syt_...",
    "serverUrl": "http://matrix:8020",
    "serverName": "comms.local"
  },
  "audioBridge": {
    "status": "available",
    "roomId": 123456,
    "wsUrl": "ws://janus:8188/janus"
  },
  "videoRoom": {
    "status": "available",
    "roomId": 789012,
    "wsUrl": "ws://janus:8188/janus",
    "iceServers": [
      { "urls": ["stun:stun.l.google.com:19302"] },
      { "urls": ["turn:turn:3478"], "username": "...", "credential": "..." }
    ]
  },
  "modeImmutable": true
}
```

For `CHAT` mode rooms, `audioBridge` and `videoRoom` are `null`.

### Room Modes

| Mode | Chat (Matrix) | AudioBridge (Janus) | VideoRoom (Janus) | Typical use |
|------|:---:|:---:|:---:|---|
| `IN_PERSON` | Yes | Yes | No | Physical meeting room with audio mixing |
| `HYBRID` | Yes | Yes | Yes | Mixed in-person + remote participants |
| `REMOTE` | Yes | No | Yes | Fully remote video session |
| `CHAT` | Yes | No | No | 1-to-1 DMs, text-only channels |

> Room mode is **immutable** — provision a new room if the mode needs to change.

## Example Usage Patterns

Common ways consumer apps map their domain concepts to rooms:

| Use case | Suggested `contextType` | Suggested `contextId` convention | Mode |
|----------|-------------------------|----------------------------------|------|
| Scheduled meeting / session | `meeting` | meeting UUID | `IN_PERSON`, `HYBRID`, or `REMOTE` |
| 1-to-1 audio call | `direct_call` | `call_<userA-id>_<userB-id>` (IDs sorted) | `IN_PERSON` |
| 1-to-1 video call | `direct_call` | `call_<userA-id>_<userB-id>` (IDs sorted) | `HYBRID` |
| 1-to-1 direct message | `direct_message` | `dm_<userA-id>_<userB-id>` (IDs sorted) | `CHAT` |
| Group / team channel | `channel` | channel UUID | `CHAT` |

Sorting user IDs for 1-to-1 contexts ensures the room is idempotent regardless of which user initiates it. `contextType` is a free-form string — use whatever makes sense in your domain.

## Data Model

| Table | Purpose |
|-------|---------|
| `communication_users` | Maps domain users to Matrix identities |
| `communication_rooms` | Room metadata, transport IDs, lifecycle status, and mode |
| `communication_memberships` | User-room authorization records (with optional `leftAt` for invalidation) |
| `communication_audit_logs` | Immutable event trail |

## Configuration

See [.env.example](.env.example) for all configuration options. Key groups:

| Group | Variables | Purpose |
|-------|-----------|---------|
| Service | `COMMS_SERVICE_PORT` | HTTP port (default: 3014) |
| Database | `DATABASE_URL` | PostgreSQL connection |
| Auth | `INTERNAL_SERVICE_SECRET` | Shared secret for internal JWT validation |
| RabbitMQ | `RABBITMQ_URL`, `RMQ_EXCHANGE`, `RMQ_QUEUE` | Message broker and exchange/queue names |
| Matrix | `MATRIX_SERVER_URL`, `MATRIX_PUBLIC_SERVER_URL`, `MATRIX_SERVER_NAME`, `MATRIX_BOT_*` | Synapse connection, domain, and bot credentials |
| Janus | `JANUS_HTTP_URL`, `JANUS_PUBLIC_WS_URL` | Gateway connection |
| ICE | `JANUS_ICE_SERVERS`, `JANUS_TURN_*` | STUN/TURN for WebRTC clients |
| TURN | `TURN_USERNAME`, `TURN_PASSWORD`, `TURN_EXTERNAL_IP` | coturn relay (standalone mode) |

All infrastructure naming is generic (`comms.local`, `comms-bot`, `comms_events_fanout`). When deploying inside an existing system, override `MATRIX_SERVER_NAME`, `MATRIX_BOT_USERNAME`, `RMQ_EXCHANGE`, and `RMQ_QUEUE` to match your environment.

## Docker Compose Services

When running standalone, `docker-compose.yml` starts 7 containers:

| Container | Image | Port |
|-----------|-------|------|
| `comms-service` | Built from Dockerfile | 3014 |
| `comms-postgres` | postgres:16-alpine | 5432 |
| `comms-redis` | redis:7-alpine | 6379 |
| `comms-rabbitmq` | rabbitmq:3-management-alpine | 5672 / 15672 |
| `comms-synapse` | matrixdotorg/synapse | 8020 |
| `comms-janus` | canyan/janus-gateway | 8088 / 8188 |
| `comms-coturn` | coturn/coturn | 3478 |

## Testing

```bash
npm test          # Run all unit tests
npm run test:cov  # With coverage
```

56 tests across 4 test suites:
- `rooms.service.spec.ts` — room provisioning, lifecycle, authorization, degradation
- `rooms.controller.spec.ts` — endpoint delegation, internal JWT validation
- `matrix.service.spec.ts` — room creation, user provisioning, invite dedup, messages
- `janus.service.spec.ts` — AudioBridge/VideoRoom creation, ICE config, health checks

## Integration Guide

For capability-focused step-by-step guides (with Express.js and Janus client examples), start at the relevant docs folder:

- [docs/chat/03-integration.md](docs/chat/03-integration.md)
- [docs/audio/03-integration.md](docs/audio/03-integration.md)
- [docs/video/03-integration.md](docs/video/03-integration.md)

For the original end-to-end onboarding doc covering all three together, see [docs/INTEGRATION_GUIDE.md](docs/INTEGRATION_GUIDE.md).

## Directory Structure

```
vps-ke-communications-service/
├── src/
│   ├── main.ts                  # HTTP + RabbitMQ bootstrap
│   ├── app.module.ts            # Root module
│   ├── auth/                    # Internal JWT guard
│   ├── database/                # Prisma client
│   ├── redis/                   # Redis cache
│   ├── matrix/                  # Matrix Synapse integration
│   ├── janus/                   # Janus Gateway integration
│   ├── rooms/                   # Core room management (controller, service, DTOs)
│   ├── messaging/               # RabbitMQ publisher
│   └── health/                  # Health check endpoint
├── prisma/
│   └── schema.prisma            # Database schema
├── infra/                       # Standalone infrastructure configs
│   ├── synapse/                 # Matrix homeserver config
│   ├── janus/                   # Janus gateway + transport configs
│   └── coturn/                  # TURN relay config
├── docs/
│   ├── INTEGRATION_GUIDE.md     # Original end-to-end onboarding
│   ├── chat/                    # Matrix-backed chat docs (8 files)
│   ├── audio/                   # AudioBridge / voice-call docs (8 files)
│   └── video/                   # VideoRoom / 1:1 + group video docs (8 files)
├── docker-compose.yml           # Standalone deployment (all dependencies)
├── Dockerfile                   # Production image
├── .env                         # Local dev configuration
├── .env.example                 # Configuration template
└── package.json
```

## Author

**Levis Nyingi** — [@levis-creator](https://github.com/levis-creator)

## License

UNLICENSED — Private project.
