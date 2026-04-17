# 01 — Architecture

## Stack Overview

The communications-service abstracts video behind a pluggable `MediaProvider`
interface. Two providers are shipped: **LiveKit** (default) and **Janus** (opt-in fallback).

### With LiveKit (default)

```
┌──────────────┐   internal JWT    ┌────────────────────────┐
│ Consumer app │ ────────────────▶ │ communications-service │
│  backend     │                   │  (owns LiveKit & Matrix)│
└──────────────┘                   └───────────┬────────────┘
       │                                       │ Twirp RPC API
       │ returns session (token)               │
       ▼                                       ▼
┌──────────────┐   direct WebSocket ┌────────────────────────┐
│  Client app  │ ─────────────────▶ │   LiveKit Server       │
│              │   (token auth,     │   (SFU, adaptive       │
│              │    publish/sub)    │    bitrate, TURN)      │
└──────────────┘                    └────────────────────────┘
```

- **LiveKit Server** runs as an SFU with adaptive bitrate and simulcast.
  Participants connect with a JWT token minted by the comms service.
- **communications-service** talks to LiveKit via Twirp RPC API.
- **Client app** receives a token + LiveKit URL and connects directly
  using `livekit-client` (Web) or `livekit_client` (Flutter).
- LiveKit has **built-in TURN** — no separate coturn needed.

### With Janus (opt-in fallback)

```
┌──────────────┐   internal JWT    ┌────────────────────────┐
│ Consumer app │ ────────────────▶ │ communications-service │
│  backend     │                   │  (owns Janus & Matrix) │
└──────────────┘                   └───────────┬────────────┘
       │                                       │ HTTP admin API
       │ returns session                       │
       ▼                                       ▼
┌──────────────┐   direct Janus WS  ┌────────────────────────┐
│  Client app  │ ─────────────────▶ │   Janus Gateway        │
│  (any SDK)   │   (publish/sub)    │   (VideoRoom SFU)      │
└──────────────┘          │         └───────────┬────────────┘
                          │ RTP/SRTP            │
                          ▼                     │
                    ┌─────────────┐             │
                    │   coturn    │ ◀───────────┘
                    │ (TURN/STUN) │
                    └─────────────┘
```

- **Janus Gateway** runs the VideoRoom plugin as an SFU. Every publisher
  sends one upstream; Janus forwards each track to every subscriber.
- **coturn** provides TURN/STUN relay for clients behind NAT.

## Why SFU (not mesh, not MCU)

| Model | What it is | Trade-off |
|---|---|---|
| **Mesh** | Every peer sends to every other peer directly | Simple, no server media cost, but upload bandwidth explodes past ~4 participants |
| **MCU** | Server mixes all streams into one composite | Cheap client-side, but expensive server CPU and loses per-participant layouts |
| **SFU** (what we use) | Server forwards each stream unchanged to every subscriber | Low server CPU, bandwidth scales linearly, each client picks its own layout |

SFU is the right default for group calls and 1:1 calls alike. For
1:1 calls, Janus still forwards both streams through the server — this
adds ~30ms vs pure mesh but gives you a consistent code path, working
TURN integration, and recording hooks for free.

## Data Model

Comms-service owns four tables (shared with chat — see
[../chat/01-architecture.md](../chat/01-architecture.md)):

| Table | Video-relevant fields |
|-------|---|
| `communication_users` | `domainUserId`, `displayName` — used to tag Janus participants so moderation can resolve domain users to Janus participant IDs. |
| `communication_rooms` | `mode` (IN_PERSON/HYBRID/REMOTE), `audioRoomId`, `videoRoomId`, `status`. |
| `communication_memberships` | Which users are authorized. `leftAt` marks invalidated sessions so kicked users can't rejoin. |
| `communication_audit_logs` | Every `USER_AUTHORIZED`, `PARTICIPANT_KICKED_VIDEO`, `PARTICIPANT_KICKED_AUDIO`, `MIC_MUTED`, etc. |

Comms-service does **not** store video content. Janus is transient by
default — when a room is destroyed the media is gone. If you need
recording, see [06-security.md](06-security.md#recording).

## Room Modes

Mode is chosen at provision time and **cannot be changed**. Pick based on
your domain:

| Mode | Audio | Video | Use case |
|---|---|---|---|
| `IN_PERSON` | AudioBridge | — | Physical room with mics, no cameras |
| `HYBRID` | AudioBridge | VideoRoom | Some participants physical, some remote |
| `REMOTE` | — | VideoRoom | All participants remote (group call, 1:1 call, webinar) |

For **1:1 calls**, use `REMOTE` and authorize exactly two users. The
client's UI is what makes it "feel" like a call — the server just sees
a two-participant room.

## Room Lifecycle

```
PROVISIONED ──activate──▶ ACTIVE ──close──▶ CLOSED
     │                                          ▲
     └──────────────── close ───────────────────┘
```

- **PROVISIONED** — Janus room created, nobody allowed to join yet.
- **ACTIVE** — users can be authorized and publish/subscribe.
- **CLOSED** — Janus VideoRoom is destroyed (`best-effort` — cleanup
  failures are logged but don't block the transition). Cached tokens are
  invalidated.

## ICE, STUN, and TURN

The session response includes an `iceServers` array the client hands
straight to `RTCPeerConnection`. Comms builds it from env vars on
comms-service:

- `JANUS_ICE_SERVERS` — comma-separated STUN/TURN URLs
- `JANUS_TURN_USERNAME` / `JANUS_TURN_CREDENTIAL` — TURN long-term creds

Default: `stun:stun.l.google.com:19302`. In production you should run
your own coturn and supply TURN URLs so clients behind symmetric NAT can
relay media.

```js
// Example iceServers returned to the client:
[
  { urls: ['stun:stun.example.com:3478'] },
  {
    urls: ['turn:turn.example.com:3478?transport=udp',
           'turn:turn.example.com:3478?transport=tcp'],
    username: 'timelimited-user',
    credential: 'hmac-derived-secret',
  },
]
```

## Participant Identity Convention

Janus doesn't know about your domain users — it only sees opaque
participant IDs. To make moderation work, clients **must** set their
Janus display name to:

```
<DisplayName>|<domainUserId>
```

e.g. `Jane Doe|7f3c1b2e-9a4d-4b56-8e1f-112233445566`. The server uses the
suffix after `|` to resolve `domainUserId → participant ID` for kick /
mute commands. A substring fallback exists for legacy clients but logs
a warning.

See [05-moderation.md](05-moderation.md) for the full convention.
