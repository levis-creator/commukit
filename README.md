# Communications Service

A reusable, app-agnostic NestJS microservice for room-based communications. It gives any backend a small HTTP contract for provisioning rooms, authorizing users, and moderating sessions while delegating transport details to Matrix, Janus, and optional SIP infrastructure.

The service is multi-tenant. Many consumer apps can share one deployment and stay isolated by `appId`.

This repository lives inside the broader `vps-ke-parliament` workspace, but the communications-service is not Parliament-specific. Parliament is just one consumer of the service. The same API and deployment can be reused by other apps that need embedded chat, audio, video, or SIP-backed room access.

## What It Does

This service exists to hide the operational glue around embedded communications:

- Matrix Synapse for chat
- Janus Gateway for audio and video
- coturn for NAT traversal
- Kamailio plus the Janus SIP plugin for free softphone access

Your backend does not talk to Matrix or Janus directly. It talks to this service using an internal JWT. Your clients then connect directly to the returned chat and media backends using scoped credentials.

Important boundary: the communications-service is not a media relay. Once credentials are issued, media flows directly between the client and the transport backend.

Another important boundary: this service is a shared platform component, not an app feature module tied to Parliament. Consumer apps bring their own domain concepts, authorization rules, and UI; they only use this service for communications provisioning and session orchestration.

## When It Fits

Use it when you want:

- Private app-scoped chat rooms
- Room-based voice or video sessions
- Server-enforced audio moderation
- A reusable comms backbone shared across multiple apps
- A small REST API instead of embedding Matrix and Janus logic in every consumer
- One communications service that can support Parliament, another internal product, or a completely separate app with no Parliament-specific assumptions

Avoid it when you need:

- End-to-end encrypted media
- PSTN or carrier telephony
- Very large broadcast streaming
- A public or federated chat product

## Mental Model

```text
Your backend --internal JWT--> communications-service --admin APIs--> Matrix / Janus
Your client  <--scoped creds-- communications-service
Your client  --direct connect-----------------------> Matrix / Janus / TURN
```

Three rules matter most:

1. The unit of provisioning is a room, keyed by `(appId, contextType, contextId)`.
2. Room mode is immutable after provisioning.
3. Your backend owns domain authorization; this service trusts the caller.

Because rooms are keyed by app-level identifiers rather than Parliament-specific entities, the same service works for meetings, classrooms, customer support sessions, hearings, direct messages, or any other domain a consumer app defines.

## What Your Backend Still Owns

This service helps with transport and session lifecycle, but your app still owns:

- Domain-level authorization
- Call signalling such as ringing, decline, busy, and missed-call flows
- Moderator policy and role decisions
- Long-term archives, analytics, and recordings beyond what the transport stores

## Core Capabilities

- Room provisioning and lifecycle
- Unified session response for chat, audio, video, and optional SIP
- Per-capability graceful degradation
- Audio moderation: mute, unmute, mute-room, kick
- Video participant kick
- Session invalidation to block re-authorization
- Audit logging for state-changing operations
- RabbitMQ events for room provisioned, activated, and closed

## Capability Map

| Capability | Backend | Notes |
|---|---|---|
| Chat | Matrix Synapse | Private app-scoped rooms |
| Audio | Janus AudioBridge | Mixer model, server-enforced mute |
| Video | Janus VideoRoom | SFU model |
| SIP | Kamailio + Janus SIP plugin | Free softphone access, no PSTN |

## Documentation Map

Start with the capability README that matches your use case:

| Area | Path | Covers |
|---|---|---|
| Chat | [`docs/chat/README.md`](docs/chat/README.md) | Matrix rooms, provisioning, persistence options |
| Audio | [`docs/audio/README.md`](docs/audio/README.md) | AudioBridge architecture, voice flows, moderation |
| Video | [`docs/video/README.md`](docs/video/README.md) | VideoRoom flows, 1:1 and group video |
| SIP | [`docs/sip/README.md`](docs/sip/README.md) | Softphone credentials, registrar flow, troubleshooting |
| Providers | [`docs/PROVIDERS.md`](docs/PROVIDERS.md) | Pluggable provider model and current support limits |
| Onboarding | [`docs/INTEGRATION_GUIDE.md`](docs/INTEGRATION_GUIDE.md) | End-to-end integration overview |

## Quick Start

### Standalone Docker Deployment

From the service directory:

```bash
cd vps-ke-communications-service
cp .env.example .env
docker compose up -d
docker compose exec communications-service npx prisma migrate deploy
```

Verify:

```bash
curl http://localhost:3014/health
```

Typical healthy response on the default Janus path:

```json
{
  "status": "ok",
  "matrix": "connected",
  "janus": "connected",
  "sip": "disabled"
}
```

### Local Development

```bash
npm install
npx prisma generate
npx prisma migrate dev
npm run start:dev
```

For local non-Docker development, PostgreSQL, Redis, and RabbitMQ must already be running. Matrix and Janus are optional; capability status degrades cleanly when they are unavailable.

## Deployment Shape

### Always-On Core

These services are required in every deployment:

| Service | Role |
|---|---|
| `communications-service` | HTTP API and orchestration |
| `postgres` | Prisma-backed persistence |
| `redis` | Cooldowns, cache, transient coordination |
| `rabbitmq` | Room lifecycle event publishing |

With only the core running, the API still boots. Capability fields simply come back as unavailable with a reason.

### Optional Capability Profiles

The Docker Compose stack gates optional infrastructure behind profiles:

| Profile | Containers | Purpose | Main flag |
|---|---|---|---|
| `chat` | `synapse` | Matrix chat | `MATRIX_ENABLED=true` |
| `media` | `janus-gateway`, `coturn` | Janus audio and video | `JANUS_ENABLED=true` |
| `sip` | `kamailio` | SIP softphones into AudioBridge | `SIP_ENABLED=true` |
| `livekit` | `livekit` | Reserved infrastructure slot only | `MEDIA_PROVIDER=livekit` |

Examples:

```bash
# Chat only
COMPOSE_PROFILES=chat docker compose up -d

# Audio and video via Janus only
COMPOSE_PROFILES=media docker compose up -d

# Default shape from .env.example
COMPOSE_PROFILES=chat,media docker compose up -d

# Everything supported today, including SIP
COMPOSE_PROFILES=chat,media,sip docker compose up -d

# LiveKit infrastructure scaffold only
COMPOSE_PROFILES=chat,livekit docker compose up -d
```

## Current Support Matrix

The codebase is provider-oriented, but the practical support story today is:

| Media provider | SIP | Status |
|---|---|---|
| `janus` | off | Supported |
| `janus` | on | Supported |
| `livekit` | off | Infrastructure scaffold only; no shipped NestJS media adapter yet |
| `livekit` | on | Not supported; SIP bridge refuses boot with `incompatible-media` |

Why the last row fails: the only shipped SIP bridge is Janus-specific and can only route calls into a Janus AudioBridge. It cannot bridge into a LiveKit media plane.

## Configuration

See [`.env.example`](.env.example) for the full template. The most important groups are:

| Group | Variables |
|---|---|
| Service | `NODE_ENV`, `COMMS_SERVICE_PORT` |
| Capability toggles | `MATRIX_ENABLED`, `JANUS_ENABLED`, `SIP_ENABLED` |
| Provider selection | `MEDIA_PROVIDER`, `CHAT_PROVIDER` |
| Database | `DATABASE_URL` |
| Redis | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` |
| Messaging | `RABBITMQ_URL`, `RMQ_EXCHANGE`, `RMQ_QUEUE` |
| Auth | `INTERNAL_SERVICE_SECRET` |
| Matrix | `MATRIX_SERVER_URL`, `MATRIX_PUBLIC_SERVER_URL`, `MATRIX_SERVER_NAME`, `MATRIX_BOT_*` |
| Janus | `JANUS_HTTP_URL`, `JANUS_WS_URL`, `JANUS_PUBLIC_WS_URL`, `JANUS_ICE_SERVERS` |
| TURN | `TURN_USERNAME`, `TURN_PASSWORD`, `TURN_REALM`, `TURN_EXTERNAL_IP` |
| SIP | `SIP_DOMAIN`, `SIP_REGISTRAR_HOST`, `SIP_BRIDGE_USERNAME`, `SIP_BRIDGE_PASSWORD` |
| LiveKit scaffold | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |

## Health Semantics

`GET /health` is deliberately capability-aware. It tells you whether each optional backend is loaded and working.

Possible values:

- `connected`: capability loaded and reachable
- `unreachable`: capability loaded but backend unavailable
- `disabled`: capability intentionally not loaded
- `registered`: SIP bridge is live and registered
- `unregistered`: SIP enabled but registrar path not ready yet
- `incompatible-media`: SIP enabled, but current media provider cannot support the loaded SIP bridge

This endpoint is the fastest way to confirm whether you have a runtime problem or just a disabled feature.

## API Overview

All internal endpoints require:

- `Authorization: Bearer <token>`
- JWT audience `aud: "communications-service"`

### Room Lifecycle

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/internal/v1/rooms/provision` | Idempotently create a room for a domain context |
| `POST` | `/internal/v1/rooms/:contextId/activate` | Mark a room active |
| `POST` | `/internal/v1/rooms/:contextId/close` | Close a room |
| `POST` | `/internal/v1/rooms/:contextId/authorize-user` | Return user session credentials |

### Moderation and Control

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/internal/v1/rooms/:contextId/participants` | List audio participants |
| `POST` | `/internal/v1/rooms/:contextId/mute` | Mute one audio participant |
| `POST` | `/internal/v1/rooms/:contextId/unmute` | Unmute one audio participant |
| `POST` | `/internal/v1/rooms/:contextId/mute-room` | Mute the whole audio room |
| `POST` | `/internal/v1/rooms/:contextId/kick-audio` | Kick from AudioBridge |
| `POST` | `/internal/v1/rooms/:contextId/kick-video` | Kick from VideoRoom |
| `POST` | `/internal/v1/rooms/:contextId/invalidate-session` | Prevent future re-authorization |

### User SIP Endpoint

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/internal/v1/users/sip-credentials` | Fetch or mint softphone credentials for a user |

### Health

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Unauthenticated health check |

## Session Response Shape

The authorization endpoint returns a unified object. Each capability may be:

- `null` because the room mode does not include it
- `available`
- `unavailable` with a reason

Example:

```json
{
  "roomId": "uuid",
  "status": "ACTIVE",
  "chat": {
    "status": "available",
    "roomId": "!abc:comms.local",
    "accessToken": "syt_...",
    "serverUrl": "http://matrix:8020",
    "serverName": "comms.local",
    "credentials": {
      "provider": "matrix",
      "roomId": "!abc:comms.local",
      "accessToken": "syt_...",
      "serverUrl": "http://matrix:8020",
      "serverName": "comms.local"
    }
  },
  "audioBridge": {
    "status": "available",
    "roomId": 123456,
    "wsUrl": "ws://janus:8188",
    "credentials": {
      "provider": "janus",
      "roomId": 123456,
      "wsUrl": "ws://janus:8188"
    }
  },
  "videoRoom": {
    "status": "available",
    "roomId": 789012,
    "wsUrl": "ws://janus:8188",
    "iceServers": [
      { "urls": ["stun:stun.l.google.com:19302"] }
    ],
    "credentials": {
      "provider": "janus",
      "roomId": 789012,
      "wsUrl": "ws://janus:8188",
      "iceServers": [
        { "urls": ["stun:stun.l.google.com:19302"] }
      ]
    }
  },
  "sip": {
    "status": "available",
    "username": "comms_user_1",
    "password": "secret",
    "registrar": "sip:comms.local:5060;transport=udp",
    "domain": "comms.local",
    "transport": "udp",
    "roomUri": "sip:room-session-123@comms.local"
  },
  "modeImmutable": true
}
```

### API Version Header

The service supports a migration-friendly response shape:

- v1 clients can keep reading legacy flat fields such as `roomId` and `wsUrl`
- v2 clients send `X-Comms-API-Version: 2` and receive the provider-tagged `credentials` shape without the legacy fields

## Room Modes

| Mode | Chat | Audio | Video | Typical use |
|---|:---:|:---:|:---:|---|
| `IN_PERSON` | Yes | Yes | No | Physical room with mixed audio |
| `HYBRID` | Yes | Yes | Yes | In-room plus remote attendees |
| `REMOTE` | Yes | No | Yes | Fully remote video session |
| `CHAT` | Yes | No | No | Direct messages or text-only channels |

Room mode is immutable. If your domain flow changes from text-only to video later, provision a new room under a new context.

## Example Domain Mapping

| Use case | Suggested `contextType` | Suggested `contextId` |
|---|---|---|
| Scheduled meeting | `meeting` | meeting UUID |
| Direct call | `direct_call` | stable pair key such as `call_<idA>_<idB>` |
| Direct message | `direct_message` | stable pair key such as `dm_<idA>_<idB>` |
| Team channel | `channel` | channel UUID |
| Support thread | `ticket` | ticket ID |

For 1:1 contexts, sort the user IDs before building the key so provisioning stays idempotent regardless of who initiated the interaction.

These are only examples. A Parliament hearing, a school class, a telehealth session, or a customer support room can all map into the same API as long as the consumer app provides stable `appId`, `contextType`, and `contextId` values.

## Data Model

Main tables:

| Table | Purpose |
|---|---|
| `communication_users` | Maps domain users to transport identities and SIP credentials |
| `communication_rooms` | Room metadata, lifecycle state, transport room IDs |
| `communication_memberships` | User-room authorization and invalidation state |
| `communication_audit_logs` | Immutable audit trail |

## Architecture Notes

- Chat is private and app-scoped, not a general Matrix product surface.
- Audio uses Janus AudioBridge, so mute is enforced server-side.
- Video uses Janus VideoRoom, so video mute is not enforced the same way audio mute is.
- SIP is opt-in and private to your deployment. It is not PSTN.
- Provider abstraction exists in the codebase, but only Janus and Matrix are actually shipped providers today.

## Testing

Useful scripts:

```bash
npm test
npm run test:cov
npm run lint
npm run build
```

The repository includes tests for core room flows, Matrix integration, Janus integration, and SIP bridge behavior.

## Project Layout

```text
vps-ke-communications-service/
  src/
    app.module.ts
    main.ts
    auth/
    common/
    database/
    health/
    janus/
    matrix/
    messaging/
    providers/
    redis/
    rooms/
    sip/
    users/
  prisma/
  infra/
    coturn/
    janus/
    kamailio/
    livekit/
    synapse/
  docs/
  docker-compose.yml
  .env.example
```

## Practical Caveats

- LiveKit support is not fully implemented yet, even though the repo contains scaffolding for it.
- SIP plus LiveKit is not supported in the current codebase.
- Graceful degradation is intentional. A booting server with unavailable capabilities is not necessarily broken.
- Closing a room invalidates access, but transport-specific in-flight behavior still depends on backend realities.

## License

UNLICENSED - Private project.
