# Janus Gateway -- Media Provider Guide

## 1. Overview

Janus Gateway is a proven, open-source WebRTC server used as the media backend
in the communications service. It provides two plugins relevant to this service:

- **AudioBridge** -- server-side audio mixing for multi-party conferencing.
  All participants' audio streams are mixed on the server and each client
  receives a single mixed stream minus their own contribution.
- **VideoRoom** -- an SFU (Selective Forwarding Unit) for video. Each
  publisher sends one stream; the server forwards it to all subscribers
  without transcoding.

Janus was the default media provider in v1.0. As of v1.1, **LiveKit is the
default** and Janus is available as an opt-in fallback. Set
`MEDIA_PROVIDER=janus` explicitly to activate it.

---

## 2. Prerequisites

| Component | Purpose |
|---|---|
| **Janus Gateway** (Docker or native build) | WebRTC media server |
| **coturn** | TURN/STUN relay for NAT traversal |
| **Node.js 20+** | Runtime for the communications service |
| **Redis** | Room cache and version tracking |
| **PostgreSQL** | Communications service database |

Docker is the recommended deployment path. The project ships a Compose profile
(`media`) that starts Janus and coturn together.

---

## 3. Environment Setup

Add these variables to `vps-ke-communications-service/.env`:

### Required

```bash
# Select Janus as the media backend (default is "livekit")
MEDIA_PROVIDER=janus

# Enable the Janus module (default is "false")
JANUS_ENABLED=true
```

### Janus connection

```bash
# Janus HTTP admin API (used by the comms service for room management)
JANUS_HTTP_URL=http://localhost:8088/janus

# Internal Janus WebSocket URL (used for health checks / fallback)
JANUS_WS_URL=ws://localhost:8188

# Public-facing WebSocket URL returned to clients in session credentials.
# Must be reachable from the end-user network.
JANUS_PUBLIC_WS_URL=wss://janus.example.org

# NAT 1:1 IP mapping (optional -- set when Janus is behind a static NAT)
JANUS_NAT_1_1=203.0.113.10
```

### ICE / TURN

```bash
# Comma-separated STUN and TURN URLs
JANUS_ICE_SERVERS=stun:stun.l.google.com:19302,turn:turn.example.org:3478

# TURN credentials (required when TURN URLs are present)
JANUS_TURN_USERNAME=myuser
JANUS_TURN_CREDENTIAL=mysecret
```

### coturn

```bash
TURN_USERNAME=myuser
TURN_PASSWORD=mysecret
TURN_REALM=example.org
```

### Docker Compose

Start Janus and coturn via the `media` profile:

```bash
COMPOSE_PROFILES=chat,media docker compose up -d
```

---

## 4. How It Works

The communications service interacts with Janus exclusively through the
**HTTP admin API**. There is no persistent WebSocket connection from the
service to Janus.

### Provisioning flow

```
Consumer app                Comms service              Janus Gateway
     |                           |                          |
     |-- POST /provision ------->|                          |
     |                           |-- POST /janus (create) ->|  ephemeral session
     |                           |-- attach audiobridge --->|
     |                           |-- { request: create } -->|  room created
     |                           |-- DELETE /session ------->|  session destroyed
     |                           |                          |
     |<-- 201 room provisioned --|                          |
```

1. The comms service creates an **ephemeral Janus session** via `POST /janus`.
2. It attaches a plugin handle (AudioBridge or VideoRoom) to the session.
3. It sends a `create` request through the handle to provision the room.
4. The session is immediately destroyed -- the service does not hold any
   long-lived Janus state.

### User authorization flow

```
Consumer app                Comms service              Client
     |                           |                       |
     |-- POST /authorize-user -->|                       |
     |<-- { roomId, wsUrl } -----|                       |
     |                           |                       |
     |          (pass credentials to client)              |
     |                           |                       |
     |                           |    connect WS ------->| Janus
     |                           |    attach plugin ----->|
     |                           |    join room --------->|
```

On `authorize-user`, the service returns the numeric `roomId` and the
public WebSocket URL. **Janus does not use tokens** -- clients connect
directly to the Janus WebSocket, attach a plugin handle, and join the
room by ID. Identity is established through the display name convention
(see section 6).

---

## 5. Room Mapping

The `contextId` (a UUID string from the consumer domain) is converted to a
numeric Janus room ID using a **DJB2 XOR hash** truncated to 31 bits:

```typescript
private contextIdToRoomId(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  const roomId = (h >>> 0) & 0x7fffffff;
  return roomId === 0 ? 1 : roomId;
}
```

The 31-bit cap ensures the value fits in a PostgreSQL `INT` column.

### Caching

Room IDs are cached at two levels:

1. **In-memory** -- `Map<string, number>` inside `JanusService`, keyed by
   `audio:<contextId>` or `video:<contextId>`.
2. **Redis** -- under keys like `comms:janus:audio:<version>:<contextId>`.

The `<version>` segment is a timestamp string generated each time the service
reconnects to Janus. When Janus restarts, the version changes, and all
previous cache entries become invisible (effectively invalidated) without
requiring an explicit purge.

---

## 6. Participant Identity

Janus does not have built-in user authentication. Participant identity is
resolved through a **display name convention** that all clients MUST follow.

### Format

```
<DisplayName>|<domainUserId>
```

**Example:** `Jane Doe|7f3c1b2e-9a4d-4f8a-b123-456789abcdef`

The server splits the display string on `|` and uses the **last segment**
as the `domainUserId`. This mapping is used by moderation endpoints
(mute, unmute, kick) to resolve a domain user ID to a Janus participant ID.

### Fallback behavior

If no exact `|`-delimited match is found, the service falls back to a
**substring search** on `domainUserId` within the display string. This
fallback works but logs a warning:

```
Resolved participant <userId> via fuzzy match in room <roomId>.
Client should set display to "DisplayName|<userId>" for reliable matching.
```

### HARDWARE handles

Display names containing `|HARDWARE` are **reserved** for physical room
microphones, embedded speakers, and other chamber equipment. These handles
are immune to all moderation commands. Attempting to mute, unmute, or kick
a HARDWARE handle returns `403 Forbidden`.

---

## 7. AudioBridge vs VideoRoom

Which Janus plugin(s) are provisioned depends on the room's `mode` field:

| Room mode | AudioBridge | VideoRoom | Notes |
|---|---|---|---|
| `IN_PERSON` | Yes | No | Server-side audio mixing only. Participants are physically present. |
| `HYBRID` | Yes | Yes | Audio mixed on server; video forwarded via SFU for remote participants. |
| `REMOTE` | No | Yes | Audio travels inside the VideoRoom (no separate AudioBridge). |

The room mode is set at provision time and cannot be changed while the room
is `ACTIVE`.

---

## 8. ICE / TURN

WebRTC requires ICE candidates to establish peer connections. When clients
are behind NATs or firewalls, a TURN relay is needed.

### Configuration

The ICE server list is built from environment variables at runtime:

```bash
JANUS_ICE_SERVERS=stun:stun.l.google.com:19302,turn:turn.example.org:3478
JANUS_TURN_USERNAME=myuser
JANUS_TURN_CREDENTIAL=mysecret
```

STUN URLs are returned without credentials. TURN URLs are returned with
the configured username and credential. The full `iceServers` array is
included in the VideoRoom session response so clients do not need local
ICE configuration.

### coturn deployment

coturn must be deployed separately. The project ships a Docker Compose
service and configuration under `coturn/`. Default ports:

- `3478` -- STUN/TURN (UDP and TCP)
- `49160-49200` -- TURN relay range

---

## 9. SIP with Janus

The communications service supports **free, self-hosted SIP** via a
Kamailio + Janus SIP plugin bridge into AudioBridge rooms.

### Architecture

```
Softphone --> Kamailio --> Janus SIP plugin --> AudioBridge room
                              (rtpengine proxies the media)
```

### Configuration

```bash
SIP_ENABLED=true
SIP_DOMAIN=sip.example.org
SIP_KAMAILIO_URL=sip:kamailio.local:5060
```

### Dial plan

Softphones register with Kamailio and dial:

```
sip:room-<contextId>@<SIP_DOMAIN>
```

The `SipBridgeService` validates the caller against the comms database,
resolves the target AudioBridge room, and bridges the call.

### Important notes

- This is **free and self-hosted** -- no PSTN gateway, no per-minute costs.
- SIP is **only compatible with `MEDIA_PROVIDER=janus`**. Setting
  `SIP_ENABLED=true` with `MEDIA_PROVIDER=livekit` causes the bridge to
  refuse to start and the health endpoint reports `sip: "incompatible-media"`.
- Media bridging between the SIP plugin and AudioBridge uses rtpengine. See
  `docs/sip/01-architecture.md` for the full topology.

---

## 10. Client SDK Integration

### Flutter (`janus_client`)

```dart
import 'package:janus_client/janus_client.dart';

// 1. Connect to Janus WebSocket
final session = JanusSession(
  url: credentials.wsUrl,  // from authorize-user response
);
await session.connect();

// 2. Attach AudioBridge plugin
final audioBridge = await session.attach(JanusPlugins.AUDIO_BRIDGE);

// 3. Join the room with the required display name convention
await audioBridge.send(message: {
  'request': 'join',
  'room': credentials.roomId,
  'display': '$displayName|$domainUserId',  // CRITICAL
});

// 4. Send keepalives to prevent 60s session timeout
Timer.periodic(Duration(seconds: 25), (_) {
  session.keepAlive();
});
```

For VideoRoom, the pattern is the same -- attach `JanusPlugins.VIDEO_ROOM`,
join with the same display name convention, then publish/subscribe as needed.

### Web (`janus-gateway.js`)

```javascript
import Janus from 'janus-gateway';

Janus.init({ debug: 'all' });

const janus = new Janus({
  server: credentials.wsUrl,
  iceServers: credentials.iceServers,
  success: () => {
    // Attach AudioBridge plugin
    janus.attach({
      plugin: 'janus.plugin.audiobridge',
      success: (handle) => {
        handle.send({
          message: {
            request: 'join',
            room: credentials.roomId,
            display: `${displayName}|${domainUserId}`,  // CRITICAL
          },
        });
      },
    });
  },
});

// Send keepalives every 25 seconds
setInterval(() => janus.keepAlive(), 25000);
```

---

## 11. Troubleshooting

### "Session timeout"

Janus sessions expire after **60 seconds** of inactivity. Clients must send
keepalive messages at an interval shorter than this (recommended: 25s).

### "Room not found" after Janus restart

The in-memory and Redis room caches include a version key that is regenerated
each time the comms service reconnects to Janus. After a Janus restart, the
comms service detects the reconnection within 30 seconds (health poll
interval), invalidates the cache, and re-creates rooms on the next provision
or authorize request. No manual action is needed.

### "WebSocket disconnected"

- Verify `JANUS_WS_URL` points to the correct host and port (`8188` by default).
- Ensure `JANUS_PUBLIC_WS_URL` is set to a URL reachable from the client
  network (not `localhost` in production).
- Check firewall rules for port `8188` (or your configured WS port).

### Health endpoint shows `media: "unreachable"`

The comms service polls Janus via `GET /janus/info` every 30 seconds. If
this endpoint does not respond, the media provider is marked unavailable and
all audio/video capabilities report `status: "unavailable"` in session
responses.

Common causes:
- Janus container is not running (`docker ps` to check).
- `JANUS_HTTP_URL` is misconfigured (default: `http://localhost:8088/janus`).
- Network policy or firewall blocking port `8088`.

### "Participant not found for mute/kick"

The client did not set the display name using the `DisplayName|domainUserId`
convention. Without the `|`-delimited suffix, the server cannot resolve the
domain user ID to a Janus participant ID. The fuzzy fallback (substring match)
may work but is unreliable and logs a warning.

Fix: ensure every client sets their Janus display name to
`<DisplayName>|<domainUserId>` before joining the room.

### "Cannot target HARDWARE handle" (403)

The target participant's display name contains `|HARDWARE`, identifying it as
physical room equipment. These handles are protected from moderation commands
to prevent cutting audio for an entire physical chamber.
