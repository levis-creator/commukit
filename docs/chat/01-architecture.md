# 01 — Architecture

## Stack Overview

```
┌──────────────┐   internal JWT    ┌────────────────────────┐
│ Consumer app │ ────────────────▶ │ communications-service │
│  backend     │                   │  (owns Matrix & Janus) │
└──────────────┘                   └───────────┬────────────┘
       │                                       │ admin API
       │ returns session                       │ (bot token)
       ▼                                       ▼
┌──────────────┐   direct CS-API    ┌────────────────────────┐
│  Client app  │ ─────────────────▶ │   Matrix Synapse       │
│  (Flutter)   │   user token       │   (chat backend)       │
└──────────────┘                    └────────────────────────┘
```

- **Matrix Synapse** is the chat backend. Messages, rooms, membership, history
  — all persisted by Synapse in its own PostgreSQL database.
- **communications-service** is the only component that talks to Synapse's
  admin API. It provisions rooms, creates shadow users, and hands out scoped
  access tokens.
- **Consumer backend** (your app) never sees Matrix. It authenticates
  service-to-service via internal JWT and asks comms for a session on behalf of
  a domain user.
- **Client app** receives a Matrix `accessToken` + `roomId` + `serverUrl` and
  talks to Synapse CS-API directly for send / sync / history / typing.

## Data Model

Comms-service owns four tables (see `prisma/schema.prisma`):

| Table | Purpose |
|-------|---------|
| `communication_users` | Shadow Matrix identity per domain user. Stores `domainUserId`, generated `matrixUserId` (`@comms_<16chars>:<server>`), random `matrixPassword`, and last-pushed `matrixDisplayName`. |
| `communication_rooms` | One row per `(appId, contextType, contextId)`. Holds `matrixRoomId`, Janus room IDs, `mode` (IN_PERSON/HYBRID/REMOTE/CHAT), and lifecycle `status`. |
| `communication_memberships` | Which users are authorized for which rooms. `leftAt` marks invalidated sessions. |
| `communication_audit_logs` | Immutable trail: `ROOM_PROVISIONED`, `USER_AUTHORIZED`, `SESSION_INVALIDATED`, kick/mute events, etc. |

Comms-service does **not** store message content — Synapse does. See
[04-persistence.md](04-persistence.md) if you need a local copy.

## Room Lifecycle

```
PROVISIONED ──activate──▶ ACTIVE ──close──▶ CLOSED
     │                                          ▲
     └──────────────── close ───────────────────┘
```

- **PROVISIONED** — room exists in comms + Matrix, nobody is allowed in yet.
- **ACTIVE** — users can be authorized and join.
- **CLOSED** — no new authorizations; every active member is logged out of
  Matrix so cached tokens stop working.

`mode` is **immutable**. Attempting to re-provision with a different mode
raises `409 Conflict`.

## Caching & Hot-Path Guards

- **Token cache** — Matrix access tokens per user are cached in Redis at
  `comms:matrix:token:<domainUserId>` and in a bounded in-memory LRU.
- **Room cache** — resolved Matrix room IDs cached at
  `comms:matrix:room:<appId>:<contextId>`.
- **Invite flag** — `comms:matrix:invite:<roomId>:<matrixUserId>` with 24h TTL
  prevents replicas from re-inviting the same user on every call.
- **Authorize cooldown** — 10s Redis key suppresses Matrix side-effects
  (invite, join, setDisplayName) on rapid re-auth while still returning valid
  credentials.
- **Display-name drift** — Matrix `PUT profile/displayname` only fires when
  the stored `matrixDisplayName` differs from the incoming one.
- **Bot-token refresh** — single-flighted on Matrix 401 responses.
