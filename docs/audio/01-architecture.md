# 01 — Architecture

## Stack Overview

The communications-service abstracts audio behind a pluggable `MediaProvider`
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
│              │   (token auth)     │   (audio compositor)   │
└──────────────┘                    └────────────────────────┘
```

- **LiveKit Server** handles audio mixing server-side. Participants
  connect with a JWT token minted by the comms service.
- **communications-service** talks to LiveKit via Twirp RPC API.
  It creates rooms, manages participants, and issues moderation commands.
- **Consumer backend** never sees LiveKit. It asks comms for a session.
- **Client app** receives a token + LiveKit URL and connects directly.
- LiveKit has **built-in TURN** — no separate coturn needed (though
  external TURN can be configured via `LIVEKIT_ICE_SERVERS`).

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
│              │   (one handle)     │   AudioBridge (mixer)  │
└──────────────┘          │         └───────────┬────────────┘
                          │ RTP/SRTP            │
                          ▼                     │
                    ┌─────────────┐             │
                    │   coturn    │ ◀───────────┘
                    │ (TURN/STUN) │
                    └─────────────┘
```

- **Janus Gateway** runs the AudioBridge plugin as a server-side audio
  mixer. Every participant sends audio upstream; Janus mixes everyone
  into a single Opus stream and sends the mix back.
- **coturn** provides TURN/STUN relay for clients behind NAT.

## Why a Mixer (Not SFU) for Audio

| Concern | Mixer (AudioBridge) | SFU (VideoRoom for audio) |
|---|---|---|
| Client bandwidth | Flat — one mixed stream | Scales linearly with participants |
| Client CPU | Low — decode one stream | Higher — decode N streams |
| Server CPU | Higher — real mixing work | Low — forward packets |
| Server-enforced mute | ✅ Yes, the server owns the mix | ❌ No, the SFU just forwards |
| Per-speaker level metering | Requires extra work | Native |
| Spatial audio | Hard | Natural |
| Recording | One file = the mix | Per-participant files |

For voice conferences, telephony, large audio rooms, and anywhere
server-side muting matters, **use AudioBridge**. For video calls where
you also want audio, the audio travels inside the VideoRoom alongside
video (so you pick `REMOTE` mode, not `HYBRID`, unless you specifically
want a separate AudioBridge).

## Room Modes — Which Mode Gives You Audio

Mode is chosen at provision time and **cannot be changed**.

| Mode | AudioBridge | VideoRoom | Use case |
|---|---|---|---|
| `IN_PERSON` | ✅ | — | Pure voice rooms, audio-only conferences, phone-call style UX |
| `HYBRID` | ✅ | ✅ | Audio handled separately from video (e.g. in-room mics + remote cameras) |
| `REMOTE` | — | ✅ | All-remote video calls; audio rides inside VideoRoom |

**When to pick `IN_PERSON` vs `REMOTE` for audio:**

- `IN_PERSON` → you want server-side mixing, server-enforced mute, and
  bandwidth efficiency. Voice-only calls, radio-style broadcast, or
  hybrid setups with physical hardware.
- `REMOTE` → you want integrated video with audio, and can live with
  client-side mute enforcement.

**1:1 voice calls** almost always want `IN_PERSON` — the mixer makes
server-enforced mute and clean recording trivial. See
[04-voice-calls.md](04-voice-calls.md).

## Data Model

Comms-service uses the same four tables as chat and video:

| Table | Audio-relevant fields |
|-------|---|
| `communication_users` | `domainUserId`, `displayName` — used to tag AudioBridge participants so moderation can resolve domain users to Janus participant IDs. |
| `communication_rooms` | `audioRoomId`, `mode`, `status`. |
| `communication_memberships` | Which users are authorized. `leftAt` marks invalidated sessions. |
| `communication_audit_logs` | Every `MIC_MUTED`, `MIC_UNMUTED`, `ROOM_MUTED`, `PARTICIPANT_KICKED_AUDIO`, etc. |

Comms-service does **not** store audio content. Janus is transient —
when a room is destroyed, any live audio is gone. For recording, see
[06-security.md](06-security.md).

## Room Lifecycle

```
PROVISIONED ──activate──▶ ACTIVE ──close──▶ CLOSED
     │                                          ▲
     └──────────────── close ───────────────────┘
```

- **PROVISIONED** — AudioBridge room created on Janus, nobody allowed
  to join yet.
- **ACTIVE** — users can be authorized and join the mix.
- **CLOSED** — Janus AudioBridge room is destroyed; cached sessions
  invalidated.

## Participant Identity Convention

Same as video — clients **must** set their Janus display to:

```
<DisplayName>|<domainUserId>
```

e.g. `Jane Doe|7f3c1b2e-9a4d-4b56-8e1f-112233445566`. Comms uses the
suffix after `|` to resolve `domainUserId → participant ID` for
mute/unmute/kick commands. A substring fallback exists for legacy
clients but logs a warning.

Displays containing `|HARDWARE` are reserved for physical room mics
(conference-room equipment). Comms refuses any moderation command that
would target `|HARDWARE` — muting the room's own microphone would cut
audio for everyone in the physical space.

## ICE / STUN / TURN

AudioBridge uses the same ICE server config as VideoRoom — the session
response's `iceServers` array applies to both. Comms builds it from
environment variables on comms-service; see
[../video/01-architecture.md](../video/01-architecture.md#ice-stun-and-turn)
for the full breakdown.
