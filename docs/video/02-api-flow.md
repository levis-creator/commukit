# 02 — End-to-End API Flow

This is what happens, in order, from room creation to teardown. All comms
endpoints require an internal JWT with `aud: "communications-service"`.

The overall shape is identical to chat — comms offers one lifecycle for
every capability. The video-specific parts are which `mode` you pick and
which fields you read from the session response.

## 1. Provision (once per domain context)

```
POST /internal/v1/rooms/provision
```
```json
{
  "appId": "myapp",
  "contextType": "CALL",
  "contextId": "<uuid>",
  "title": "Standup",
  "mode": "REMOTE"
}
```

For video you'll typically use `REMOTE` (video-only) or `HYBRID`
(audio + video). Comms creates the media room via the configured provider
(LiveKit or Janus), stores the row, and publishes
`communications.room.provisioned`. Idempotent.

## 2. Activate when the call begins

```
POST /internal/v1/rooms/:contextId/activate
```
```json
{ "appId": "myapp", "contextType": "CALL" }
```

## 3. Authorize each user as they join

```
POST /internal/v1/rooms/:contextId/authorize-user
```
```json
{
  "appId": "myapp",
  "contextType": "CALL",
  "domainUserId": "<user-uuid>",
  "displayName": "Jane Doe",
  "roles": ["PARTICIPANT"]
}
```

Returns the **session response**. The shape of `videoRoom.credentials`
depends on the active media provider.

### With LiveKit (default)

```json
{
  "roomId": "<comms-room-uuid>",
  "status": "ACTIVE",
  "chat": { "status": "available", "...": "..." },
  "audioBridge": null,
  "videoRoom": {
    "status": "available",
    "credentials": {
      "provider": "livekit",
      "room": "comms-a1b2c3d4",
      "url": "wss://livekit.example.com",
      "token": "<jwt-participant-token>",
      "iceServers": []
    }
  },
  "modeImmutable": true
}
```

LiveKit has built-in TURN so `iceServers` is typically empty — the
client SDK handles connectivity automatically.

### With Janus

```json
{
  "roomId": "<comms-room-uuid>",
  "status": "ACTIVE",
  "chat": { "status": "available", "...": "..." },
  "audioBridge": null,
  "videoRoom": {
    "status": "available",
    "credentials": {
      "provider": "janus",
      "roomId": 12345,
      "wsUrl": "wss://janus.example.com/ws",
      "iceServers": [
        { "urls": ["stun:stun.example.com:3478"] },
        {
          "urls": ["turn:turn.example.com:3478?transport=udp"],
          "username": "u1",
          "credential": "p1"
        }
      ]
    }
  },
  "modeImmutable": true
}
```

Fields you care about for video:

| Field | LiveKit | Janus |
|---|---|---|
| `videoRoom.status` | `"available"` or `"unavailable"` — always branch on this | Same |
| `videoRoom.credentials.provider` | `"livekit"` | `"janus"` |
| `videoRoom.credentials.room` | Room name (string, e.g. `comms-a1b2c3d4`) | N/A |
| `videoRoom.credentials.url` | LiveKit server URL | N/A |
| `videoRoom.credentials.token` | JWT participant token (15-min expiry) | N/A |
| `videoRoom.credentials.roomId` | N/A | Integer Janus VideoRoom id |
| `videoRoom.credentials.wsUrl` | N/A | Janus WebSocket URL |
| `videoRoom.credentials.iceServers` | Usually empty (built-in TURN) | Pass to `RTCPeerConnection` |

When the media provider is unreachable, `videoRoom` comes back as
`{ "status": "unavailable", "reason": "..." }` and the client should
show a "video unavailable" UI rather than crash.

## 4. Client connects to the media provider directly

The client never calls comms again during the session. Connection differs
by provider.

### With LiveKit (default)

1. Use the LiveKit client SDK (`livekit_client` for Flutter, `livekit-client` for web)
2. Call `Room.connect(credentials.url, credentials.token)`
3. Publish local audio/video tracks
4. Subscribe to remote tracks via SDK event handlers

Participant identity is embedded in the JWT token metadata — no display
name convention needed.

### With Janus

1. Opens a WebSocket to `credentials.wsUrl`
2. Creates a Janus session, attaches to the `janus.plugin.videoroom` plugin
3. Joins `credentials.roomId` as a **publisher** with display name
   `DisplayName|domainUserId` (see [05-moderation.md](05-moderation.md))
4. Creates an SDP offer, configures `iceServers`, publishes audio + video
5. Subscribes to every other publisher the `joined` event lists, and to
   new publishers announced via `publishers` events

Janus SDK choice is up to you — `janus-gateway.js` for web,
`janus_client` for Dart/Flutter, or any library that speaks the Janus
WebSocket protocol.

## 5. Mute / Kick (moderators)

Comms exposes internal endpoints your backend can call on behalf of a
moderator. See [05-moderation.md](05-moderation.md) for full details.

```
POST /internal/v1/rooms/:contextId/mute          { domainUserId }
POST /internal/v1/rooms/:contextId/unmute        { domainUserId }
POST /internal/v1/rooms/:contextId/mute-room
POST /internal/v1/rooms/:contextId/kick-audio    { domainUserId }
POST /internal/v1/rooms/:contextId/kick-video    { domainUserId }
POST /internal/v1/rooms/:contextId/invalidate-session { domainUserId }
GET  /internal/v1/rooms/:contextId/participants
```

`mute` / `unmute` operate on the AudioBridge (for HYBRID rooms). In
`REMOTE` rooms audio travels via the VideoRoom itself; clients mute
locally — if you need server-enforced muting for `REMOTE` rooms, use
`kick-video` + re-authorize.

## 6. Close when the call ends

```
POST /internal/v1/rooms/:contextId/close
```

Comms destroys the media room (best-effort) and publishes
`communications.room.closed`. Cached sessions are invalidated.

## RabbitMQ Events Emitted

| Event | When |
|---|---|
| `communications.room.provisioned` | After a new room is created |
| `communications.room.activated` | On status transition to ACTIVE |
| `communications.room.closed` | On status transition to CLOSED |

Published to a fanout exchange (default `comms_events_fanout`, override
via `RMQ_EXCHANGE`).
