# 02 — End-to-End API Flow

Identical lifecycle to chat and video — only the `mode` and the fields
you read from the session response differ. All comms endpoints require
an internal JWT with `aud: "communications-service"`.

## 1. Provision (once per domain context)

```
POST /internal/v1/rooms/provision
```
```json
{
  "appId": "myapp",
  "contextType": "VOICE_CALL",
  "contextId": "<uuid>",
  "title": "Team standup",
  "mode": "IN_PERSON"
}
```

`IN_PERSON` tells comms to create only the AudioBridge (no VideoRoom).
Idempotent — re-running returns the existing room.

## 2. Activate when the call begins

```
POST /internal/v1/rooms/:contextId/activate
```
```json
{ "appId": "myapp", "contextType": "VOICE_CALL" }
```

## 3. Authorize each user as they join

```
POST /internal/v1/rooms/:contextId/authorize-user
```
```json
{
  "appId": "myapp",
  "contextType": "VOICE_CALL",
  "domainUserId": "<user-uuid>",
  "displayName": "Jane Doe",
  "roles": ["PARTICIPANT"]
}
```

Returns the session response — the audio-relevant fields are in
`audioBridge`:

```json
{
  "roomId": "<comms-room-uuid>",
  "status": "ACTIVE",
  "chat": { "status": "available", "...": "..." },
  "audioBridge": {
    "status": "available",
    "roomId": 56789,
    "wsUrl": "wss://janus.example.com/ws"
  },
  "videoRoom": null,
  "modeImmutable": true
}
```

| Field | Meaning |
|---|---|
| `audioBridge.status` | `"available"` or `"unavailable"` — always branch on this |
| `audioBridge.roomId` | Integer Janus AudioBridge room id — pass to the `join` request |
| `audioBridge.wsUrl` | Janus WebSocket URL |

When Janus is unreachable, `audioBridge` comes back as
`{ "status": "unavailable", "reason": "..." }` and the client should
show a disabled UI.

Note: `iceServers` lives under `videoRoom` in the response. For
`IN_PERSON` rooms there is no `videoRoom`, so the client's Janus SDK
falls back to whatever default ICE config it was initialized with (or
you can fetch ICE config from a separate `GET` on your own backend if
needed). In practice most Janus SDKs handle audio-only flows fine with
the default `stun:stun.l.google.com:19302`.

## 4. Client connects to Janus directly

The client:

1. Opens a WebSocket to `audioBridge.wsUrl`
2. Creates a Janus session, attaches to the `janus.plugin.audiobridge` plugin
3. Joins `audioBridge.roomId` with display name `DisplayName|domainUserId`
4. Sends an SDP offer configured for **audio only**
5. Receives the mixed Opus stream from the server

No subscribers — AudioBridge uses a single plugin handle that does both
send and receive.

## 5. Mute / Kick (moderators)

```
POST /internal/v1/rooms/:contextId/mute          { domainUserId }
POST /internal/v1/rooms/:contextId/unmute        { domainUserId }
POST /internal/v1/rooms/:contextId/mute-room
POST /internal/v1/rooms/:contextId/kick-audio    { domainUserId }
POST /internal/v1/rooms/:contextId/invalidate-session { domainUserId }
GET  /internal/v1/rooms/:contextId/participants
```

Server-enforced — comms tells Janus to mute/unmute/kick and the client
can't bypass it. See [05-moderation.md](05-moderation.md).

## 6. Close when the call ends

```
POST /internal/v1/rooms/:contextId/close
```

Comms destroys the Janus AudioBridge room and publishes
`communications.room.closed`.

## RabbitMQ Events Emitted

Same as chat and video — fanout exchange (default
`comms_events_fanout`):

- `communications.room.provisioned`
- `communications.room.activated`
- `communications.room.closed`
