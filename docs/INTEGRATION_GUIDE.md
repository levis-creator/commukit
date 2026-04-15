# Communications Service — Integration Guide

This guide documents how any backend/app can integrate with the `vps-ke-communications-service` to add room-based chat and audio/video calls to their product.

---

## Prerequisites

- Network access to the communications-service (same Docker network or public URL)
- A shared `INTERNAL_SERVICE_SECRET` env var (same value configured in communications-service)
- Matrix Synapse and Janus Gateway reachable from the communications-service (not from your app)

---

## Step 1: Choose your app identity

Pick a unique `appId` string (e.g. `"county-assembly"`, `"committee-portal"`). This scopes all rooms and user mappings. No registration endpoint needed — just use it consistently in API calls.

---

## Step 2: Sign internal JWTs from your backend

Your backend must sign short-lived JWTs for service-to-service calls:

```typescript
import * as jwt from 'jsonwebtoken';

function signInternalToken(): string {
  return jwt.sign(
    { iss: 'your-backend-name' },
    process.env.INTERNAL_SERVICE_SECRET,
    { audience: 'communications-service', expiresIn: '60s' },
  );
}
```

Attach as `Authorization: Bearer <token>` header on all `/internal/v1/*` calls.

---

## Step 3: Provision rooms

When your domain creates a session, meeting, or conversation that needs communication:

```http
POST /internal/v1/rooms/provision
Authorization: Bearer <internal-jwt>
Content-Type: application/json

{
  "appId": "your-app-id",
  "contextType": "MEETING",
  "contextId": "<your-domain-uuid>",
  "title": "Budget Committee Meeting",
  "mode": "REMOTE"
}
```

**Response:**
```json
{ "roomId": "<comms-room-uuid>", "status": "PROVISIONED" }
```

This is **idempotent** — calling again with the same `appId + contextType + contextId` returns the existing room. Attempting to change the mode of an existing room returns `409 Conflict`.

### Room modes

| Mode | Chat (Matrix) | AudioBridge (Janus) | VideoRoom (Janus) | Typical use |
|------|:---:|:---:|:---:|---|
| `IN_PERSON` | Yes | Yes | No | Physical meeting room with audio mixing |
| `HYBRID` | Yes | Yes | Yes | Mixed in-person + remote participants |
| `REMOTE` | Yes | No | Yes | Fully remote video session |
| `CHAT` | Yes | No | No | 1-to-1 DMs, text-only channels |

> Room mode is **immutable** — provision a new room if the mode needs to change.

---

## Step 4: Manage room lifecycle

```http
POST /internal/v1/rooms/:contextId/activate
Authorization: Bearer <internal-jwt>
Content-Type: application/json

{ "appId": "your-app-id", "contextType": "MEETING" }
```

```http
POST /internal/v1/rooms/:contextId/close
Authorization: Bearer <internal-jwt>
Content-Type: application/json

{ "appId": "your-app-id", "contextType": "MEETING" }
```

**State machine:** `PROVISIONED` → `ACTIVE` → `CLOSED`

- Only `ACTIVE` rooms accept new user authorizations.
- `CLOSED` rooms are read-only — existing Matrix tokens retain read access until they expire.

For chat-only (`CHAT` mode) rooms such as DMs, you can activate immediately after provisioning and leave the room permanently `ACTIVE`.

---

## Step 5: Authorize users for a room

When a user in your app needs to join the room, your backend must first verify they're allowed (your domain rules), then call:

```http
POST /internal/v1/rooms/:contextId/authorize-user
Authorization: Bearer <internal-jwt>
Content-Type: application/json
X-Comms-API-Version: 2

{
  "appId": "your-app-id",
  "contextType": "MEETING",
  "domainUserId": "<user-uuid-in-your-system>",
  "displayName": "Jane Doe",
  "roles": ["PARTICIPANT"]
}
```

Set the `X-Comms-API-Version: 2` header to receive the **v2 response shape**
described below, in which each capability exposes a provider-tagged
`credentials` discriminated-union instead of the legacy flat fields. Omit
the header to receive the v1 shape (deprecated but still supported).

**v2 response:**
```json
{
  "roomId": "<comms-room-uuid>",
  "status": "ACTIVE",
  "chat": {
    "status": "available",
    "credentials": {
      "provider": "matrix",
      "roomId": "!xyz:your-domain.local",
      "accessToken": "syt_...",
      "serverUrl": "http://matrix-host:8020",
      "serverName": "your-domain.local"
    }
  },
  "audioBridge": null,
  "videoRoom": {
    "status": "available",
    "credentials": {
      "provider": "janus",
      "roomId": 789012,
      "wsUrl": "ws://janus-host:8188/janus",
      "iceServers": [
        { "urls": ["stun:stun.l.google.com:19302"] },
        { "urls": ["turn:turn-host:3478"], "username": "...", "credential": "..." }
      ]
    }
  },
  "modeImmutable": true
}
```

Clients should **switch on `credentials.provider`** to pick the correct
transport. Today only `matrix` (chat) and `janus` (audio/video) are
emitted. When a LiveKit adapter ships, the audio/video credentials may
carry `provider: "livekit"` with a different field set (`room`, `url`,
`token`) — see [`PROVIDERS.md`](./PROVIDERS.md).

Each capability has its own `status` field. If the chat provider is down,
`chat.status` will be `"unavailable"` with a `reason`, but `videoRoom` may
still be `"available"`.

For `CHAT` mode rooms, `audioBridge` and `videoRoom` are always `null`.

A **10-second per-user cooldown** suppresses duplicate Matrix side-effects
(invite, room join) on rapid re-connection. Subsequent calls within the
window return the same credentials immediately.

### Legacy v1 response (deprecated)

Without the version header, the response still contains the flat fields
`chat.roomId`, `chat.accessToken`, `chat.serverUrl`, `chat.serverName`,
`audioBridge.roomId`, `audioBridge.wsUrl`, `videoRoom.roomId`,
`videoRoom.wsUrl`, `videoRoom.iceServers`. These are **deprecated** and
will be removed in a future release once all known consumers have
migrated. New integrations should send `X-Comms-API-Version: 2` from day
one.

---

## Step 6: Expose a session endpoint to your clients

Your backend should wrap the `authorize-user` call behind your own auth-gated endpoint:

```
GET /your-domain/:id/communications-session
```

This endpoint:
1. Authenticates the calling user (your JWT)
2. Checks domain-level authorization (e.g. is user invited to this meeting?)
3. Calls communications-service `authorize-user`
4. Returns the session package to the client

---

## Step 7: Consume the session in your client app

### Flutter example

```dart
// 1. Fetch session from YOUR backend
final session = await yourDataSource.getCommunicationsSession(meetingId);

// 2. Initialize chat (if available)
if (session.chat?.status == 'available') {
  matrixService.connectWithToken(
    session.chat!.serverUrl!,
    session.chat!.accessToken!,
  );
  await matrixService.joinRoom(session.chat!.roomId!);
  matrixService.startSync();
}

// 3. Initialize video call (if available)
if (session.videoRoom?.status == 'available') {
  await janusVideoService.joinRoom(
    session.videoRoom!.roomId!,
    session.videoRoom!.wsUrl!,
    displayName,
  );
}

// 4. Initialize audio (if available)
if (session.audioBridge?.status == 'available') {
  await janusAudioService.joinRoom(
    session.audioBridge!.roomId!,
    session.audioBridge!.wsUrl!,
    displayName,
  );
}
```

### Web (JavaScript) example

```javascript
const session = await fetch('/your-api/meetings/123/communications-session', {
  headers: { Authorization: `Bearer ${userToken}` },
}).then(r => r.json());

// Chat via Matrix JS SDK
if (session.chat?.status === 'available') {
  const matrixClient = sdk.createClient({
    baseUrl: session.chat.serverUrl,
    accessToken: session.chat.accessToken,
  });
  await matrixClient.joinRoom(session.chat.roomId);
  matrixClient.startClient();
}

// Video via Janus JS API
if (session.videoRoom?.status === 'available') {
  const janus = new Janus({
    server: session.videoRoom.wsUrl,
    iceServers: session.videoRoom.iceServers,
  });
  // Attach videoroom plugin and join room...
}
```

---

## Step 8: Chat history

Chat history is paginated **directly against Matrix** using the user-scoped `accessToken` returned by `/authorize-user`:

```
GET https://<matrix-server>/_matrix/client/v3/rooms/<roomId>/messages?dir=b&limit=50&from=<pageToken>
Authorization: Bearer <accessToken from authorize-user response>
```

This gives clients full access to the Matrix CS-API for pagination, search, and read receipts without routing traffic through the communications-service.

---

## Participant control (optional)

For meeting or call rooms, your backend can control Janus participants on behalf of moderators:

```http
# Mute a single participant
POST /internal/v1/rooms/:contextId/mute
{ "appId": "...", "contextType": "...", "domainUserId": "<uuid>" }

# Unmute a single participant
POST /internal/v1/rooms/:contextId/unmute
{ "appId": "...", "contextType": "...", "domainUserId": "<uuid>" }

# Mute everyone (e.g. at session start, during a presentation)
POST /internal/v1/rooms/:contextId/mute-room
{ "appId": "...", "contextType": "..." }

# Remove a participant from the AudioBridge
POST /internal/v1/rooms/:contextId/kick-audio
{ "appId": "...", "contextType": "...", "domainUserId": "<uuid>" }

# Remove a participant from the VideoRoom
POST /internal/v1/rooms/:contextId/kick-video
{ "appId": "...", "contextType": "...", "domainUserId": "<uuid>" }

# Permanently block a user from re-authorizing to this room
POST /internal/v1/rooms/:contextId/invalidate-session
{ "appId": "...", "contextType": "...", "domainUserId": "<uuid>" }

# List all AudioBridge participants with mute state
GET /internal/v1/rooms/:contextId/participants?appId=...&contextType=...
# → [{ "id": 123, "display": "Jane Doe|uuid", "muted": false }, ...]
```

These endpoints are only effective for rooms that have an active Janus session (modes `IN_PERSON`, `HYBRID`, or `REMOTE`). Calling them on `CHAT` mode rooms returns `400`.

---

## Common patterns

### 1-to-1 direct messages (DMs)

Use `CHAT` mode with a deterministic `contextId` to make the room idempotent and ensure both users always land in the same room:

```typescript
// Sort user IDs so the same pair always produces the same key,
// regardless of which user initiates the conversation
const [userA, userB] = [userId1, userId2].sort();
const contextId = `dm_${userA}_${userB}`;

// Provision once (idempotent)
await commsClient.provision({
  appId: 'your-app-id',
  contextType: 'direct_message',
  contextId,
  title: `DM: ${displayNameA} ↔ ${displayNameB}`,
  mode: 'CHAT',
});

// Activate immediately — DM rooms never close
await commsClient.activate(contextId, 'your-app-id', 'direct_message');

// Authorize each participant when they open the conversation
const session = await commsClient.authorizeUser(contextId, {
  appId: 'your-app-id',
  contextType: 'direct_message',
  domainUserId: currentUserId,
  displayName: currentUserName,
  roles: ['PARTICIPANT'],
});
```

### 1-to-1 direct calls

Use the same deterministic key pattern with `IN_PERSON` (audio only) or `HYBRID` (audio + video):

```typescript
const [userA, userB] = [callerId, calleeId].sort();
const contextId = `call_${userA}_${userB}`;

await commsClient.provision({
  appId: 'your-app-id',
  contextType: 'direct_call',
  contextId,
  title: `Call: ${callerName} → ${calleeName}`,
  mode: 'IN_PERSON', // or 'HYBRID' for video
});

await commsClient.activate(contextId, 'your-app-id', 'direct_call');
```

When the call ends, close the room so participants can no longer re-join:

```typescript
await commsClient.close(contextId, 'your-app-id', 'direct_call');
```

---

## Key design rules

1. **You own authorization.** The communications-service never decides who can join. Your backend must call `authorize-user` only for users who pass your domain checks.

2. **One identity per user.** A `domainUserId` maps to one Matrix identity across all room types within your app. If the same user joins a group meeting and a 1-to-1 DM, they use one Matrix account throughout.

3. **Room mode is immutable.** Once provisioned, a room's mode cannot change. Provision a new room if the mode changes (e.g. an in-person meeting switches to hybrid).

4. **Clients talk to Matrix/Janus directly.** The session response gives clients scoped tokens. Chat messages go directly to Matrix, video/audio goes directly to Janus. The communications-service is not a relay.

5. **Graceful degradation.** Always check `status` fields before initializing a transport. If one capability is down, the others still work independently.

6. **Short-lived internal tokens.** Internal JWTs should have `expiresIn: '60s'`. They're single-use for provisioning calls, not long-lived service accounts.

7. **CHAT mode never needs closing.** DM rooms are permanent. Only close rooms for time-bounded sessions (calls, meetings) when participants should no longer be able to join.

---

## Health check

```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "matrix": "connected",
  "janus": "connected"
}
```

If Matrix or Janus is unreachable, the respective field shows `"unreachable"` but the service remains up and continues processing requests for the available transports.

---

## RabbitMQ events

The communications-service publishes events on the `comms_events_fanout` exchange:

| Event | Payload |
|-------|---------|
| `communications.room.provisioned` | `{ roomId, appId, contextType, contextId, mode }` |
| `communications.room.activated` | `{ roomId, appId, contextType, contextId }` |
| `communications.room.closed` | `{ roomId, appId, contextType, contextId }` |

Subscribe to these if your other services need to react to room lifecycle changes (e.g. to start recording when a room activates).
