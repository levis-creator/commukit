# 02 — End-to-End API Flow

This is what happens, in order, from room creation to teardown. All comms
endpoints require an internal JWT with `aud: "communications-service"`.

## 1. Provision (once per domain context)

```
POST /internal/v1/rooms/provision
```
```json
{
  "appId": "myapp",
  "contextType": "MEETING",
  "contextId": "<uuid>",
  "title": "Board meeting",
  "mode": "REMOTE"
}
```

Comms creates the Matrix room (private, `history_visibility: joined`,
guest access forbidden), stores the `CommunicationRoom` row, and publishes
`communications.room.provisioned` on RabbitMQ. Idempotent — safe to re-run.

## 2. Activate when the context begins

```
POST /internal/v1/rooms/:contextId/activate
```
```json
{ "appId": "myapp", "contextType": "MEETING" }
```

Publishes `communications.room.activated`.

## 3. Authorize each user as they open the screen

```
POST /internal/v1/rooms/:contextId/authorize-user
```
```json
{
  "appId": "myapp",
  "contextType": "MEETING",
  "domainUserId": "<user-uuid>",
  "displayName": "Jane Doe",
  "roles": ["PARTICIPANT"]
}
```

Comms does the following:

- Ensures a `CommunicationUser` (shadow Matrix account) exists.
- Logs in / registers via `/_synapse/admin/v1/register` (HMAC nonce auth).
- Caches the access token in Redis (`comms:matrix:token:<domainUserId>`).
- Invites the user to the Matrix room and auto-joins on their behalf
  (guarded by the 24h invite flag).
- Upserts a `CommunicationMembership` row.
- Returns the **session response**:

```json
{
  "roomId": "<comms-room-uuid>",
  "status": "ACTIVE",
  "chat": {
    "status": "available",
    "roomId": "!abc:server",
    "accessToken": "syt_...",
    "serverUrl": "https://matrix.example.com",
    "serverName": "example.com"
  },
  "audioBridge": null,
  "videoRoom": null,
  "modeImmutable": true
}
```

When Matrix is unreachable, `chat` comes back as
`{ "status": "unavailable", "reason": "..." }` and the client should degrade
gracefully.

## 4. Client talks to Matrix directly

Using the returned token the client hits the Synapse CS-API:

- `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txn}` — send
- `GET /_matrix/client/v3/sync` — live updates
- `GET /_matrix/client/v3/rooms/{roomId}/messages` — history pagination
- `PUT /_matrix/client/v3/rooms/{roomId}/typing/{userId}` — typing

## 5. Close when the context ends

```
POST /internal/v1/rooms/:contextId/close
```
```json
{ "appId": "myapp", "contextType": "MEETING" }
```

Comms logs out every active member (invalidating their cached tokens),
marks the room CLOSED, and publishes `communications.room.closed`.

## Additional Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /internal/v1/rooms/:id/invalidate-session` | Forcibly end a single user's session without closing the room. |
| `POST /internal/v1/rooms/:id/mute`, `/unmute`, `/mute-room` | Audio controls (see mic-control docs). |
| `GET /internal/v1/rooms/:id/participants` | Live Janus AudioBridge roster. |

## RabbitMQ Events Emitted

| Event | When |
|---|---|
| `communications.room.provisioned` | After a new room is created |
| `communications.room.activated` | On status transition to ACTIVE |
| `communications.room.closed` | On status transition to CLOSED |

Subscribe to these for async fan-out (notifications, analytics, archiving).
