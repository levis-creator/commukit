# 03 — Integration Guide (Step-by-Step with Examples)

How to wire a consumer app to chat, with runnable examples at each step.
The backend examples use **Express.js** (plain JavaScript, Node 18+). The
same shapes translate directly to any HTTP framework (Fastify, Koa, Hono,
NestJS, Go/Python/Java, etc.) — only the routing glue changes. Client
examples use Dart / Flutter, but any Matrix SDK works the same way.

---

## Prerequisites

- comms-service deployed and reachable on the internal network
- Matrix Synapse running, reachable by comms-service
- Shared secrets configured in comms-service `.env`:
  - `INTERNAL_SERVICE_SECRET` — for signing/verifying internal JWTs
  - `MATRIX_SERVER_NAME`, `MATRIX_SERVER_URL`, `MATRIX_PUBLIC_SERVER_URL`
  - `MATRIX_BOT_USERNAME`, `MATRIX_BOT_PASSWORD`
  - `MATRIX_REGISTRATION_SHARED_SECRET` (must match Synapse `homeserver.yaml`)

---

## Step 1 — Pick an `appId` and add config

Choose a short stable identifier, e.g. `"myapp"`. It scopes your Matrix room
aliases so they won't collide with other consumer apps sharing the same
Synapse homeserver.

In your consumer backend's `.env`:

```bash
COMMS_APP_ID=myapp
COMMUNICATIONS_SERVICE_URL=http://comms-service:3014
INTERNAL_SERVICE_SECRET=<same-value-as-comms-service>
```

---

## Step 2 — Write an internal JWT signer

Create a small helper that issues short-lived JWTs with
`aud: "communications-service"`. Comms verifies only the audience +
signature, so any issuer string is fine.

```js
// src/communications/internalToken.js
const jwt = require('jsonwebtoken');

const SECRET = process.env.INTERNAL_SERVICE_SECRET;
const APP_ID = process.env.COMMS_APP_ID || 'myapp';

function signInternalToken() {
  return jwt.sign(
    { iss: APP_ID },
    SECRET,
    { audience: 'communications-service', expiresIn: '60s' },
  );
}

module.exports = { signInternalToken };
```

---

## Step 3 — Build the HTTP client

Wrap each comms endpoint in a function. Return `null` on network failure so
callers can degrade gracefully when comms is down. Node 18+ has global
`fetch`; on older versions install `node-fetch`.

```js
// src/communications/commsClient.js
const { signInternalToken } = require('./internalToken');

const BASE_URL = (process.env.COMMUNICATIONS_SERVICE_URL || 'http://localhost:3014')
  .replace(/\/$/, '');
const APP_ID = process.env.COMMS_APP_ID || 'myapp';

async function post(path, body) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signInternalToken()}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[comms] POST ${path} → ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[comms] POST ${path} failed:`, err.message);
    return null;
  }
}

async function provisionRoom({ contextType, contextId, title, mode }) {
  return post('/internal/v1/rooms/provision', {
    appId: APP_ID, contextType, contextId, title, mode,
  });
}

async function activateRoom(contextId, contextType) {
  return post(`/internal/v1/rooms/${contextId}/activate`, {
    appId: APP_ID, contextType,
  });
}

async function closeRoom(contextId, contextType) {
  return post(`/internal/v1/rooms/${contextId}/close`, {
    appId: APP_ID, contextType,
  });
}

async function authorizeUser(contextId, { contextType, domainUserId, displayName, roles }) {
  return post(`/internal/v1/rooms/${contextId}/authorize-user`, {
    appId: APP_ID, contextType, domainUserId, displayName, roles,
  });
}

module.exports = { provisionRoom, activateRoom, closeRoom, authorizeUser };
```

The session returned by `authorizeUser` has this shape:

```js
// {
//   roomId: '<comms-room-uuid>',
//   status: 'ACTIVE',
//   chat: {
//     status: 'available' | 'unavailable',
//     reason?: string,
//     roomId?: string,          // Matrix room id, e.g. !abc:server
//     accessToken?: string,     // Matrix user access token
//     serverUrl?: string,
//     serverName?: string,
//   },
//   audioBridge: null,
//   videoRoom: null,
//   modeImmutable: true,
// }
```

---

## Step 4 — Provision on context creation

Call `provisionRoom` from your route handler as soon as the context
(meeting, ticket, etc.) is created. Provisioning is idempotent — re-running
returns the existing room.

```js
// src/meetings/meetings.routes.js
const express = require('express');
const { provisionRoom, activateRoom, closeRoom, authorizeUser } =
  require('../communications/commsClient');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

router.post('/meetings', requireAuth, async (req, res, next) => {
  try {
    const { title, mode } = req.body; // mode: IN_PERSON | HYBRID | REMOTE
    const meeting = await db.meeting.create({
      data: { title, mode, createdBy: req.user.id },
    });

    await provisionRoom({
      contextType: 'MEETING',
      contextId: meeting.id,
      title: meeting.title,
      mode: meeting.mode,
    });

    res.status(201).json(meeting);
  } catch (err) {
    next(err);
  }
});
```

---

## Step 5 — Activate on context start

When the meeting begins, flip the room to `ACTIVE`.

```js
router.post('/meetings/:id/start', requireAuth, async (req, res, next) => {
  try {
    const meeting = await db.meeting.update({
      where: { id: req.params.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });

    await activateRoom(meeting.id, 'MEETING');
    res.json(meeting);
  } catch (err) {
    next(err);
  }
});
```

Until activation, authorization still succeeds with status `PROVISIONED` —
but you'll typically want the client UI to wait for `ACTIVE`.

---

## Step 6 — Expose a session endpoint to your client

One route handler is enough. It takes the authenticated user, authorizes
them via comms, and returns the session verbatim.

```js
router.get('/meetings/:id/communications-session', requireAuth, async (req, res, next) => {
  try {
    const meeting = await db.meeting.findUnique({ where: { id: req.params.id } });
    if (!meeting) return res.status(404).json({ error: 'Not found' });

    // Your own domain-level authorization — comms trusts whatever JWT it gets.
    const allowed = await db.meeting.userCanJoin(meeting.id, req.user.id);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    const session = await authorizeUser(meeting.id, {
      contextType: 'MEETING',
      domainUserId: req.user.id,
      displayName: req.user.displayName,
      roles: req.user.id === meeting.createdBy ? ['MODERATOR'] : ['PARTICIPANT'],
    });

    if (!session) {
      return res.status(503).json({ error: 'Chat unavailable' });
    }

    res.json(session);
  } catch (err) {
    next(err);
  }
});
```

Example response:

```json
{
  "roomId": "3f1b...",
  "status": "ACTIVE",
  "chat": {
    "status": "available",
    "roomId": "!abc:matrix.example.com",
    "accessToken": "syt_ZGVtbw...",
    "serverUrl": "https://matrix.example.com",
    "serverName": "example.com"
  },
  "audioBridge": null,
  "videoRoom": null,
  "modeImmutable": true
}
```

---

## Step 7 — Wire the Flutter client

Fetch the session over your normal authenticated API, then hand the
credentials to a Matrix client SDK (e.g. `matrix_dart_sdk`).

```dart
// lib/features/meetings/data/chat_session_repository.dart
class ChatSessionRepository {
  ChatSessionRepository(this._dio);
  final Dio _dio;

  Future<CommsSession> fetch(String meetingId) async {
    final res = await _dio.get('/api/v1/meetings/$meetingId/communications-session');
    return CommsSession.fromJson(res.data);
  }
}
```

```dart
// lib/features/meetings/presentation/meeting_chat_cubit.dart
Future<void> enterChat(String meetingId) async {
  final session = await _sessionRepo.fetch(meetingId);

  if (session.chat?.status != 'available') {
    emit(ChatUnavailable(reason: session.chat?.reason ?? 'Chat disabled'));
    return;
  }

  final chat = session.chat!;
  final client = Client('myapp-chat', httpClient: http.Client())
    ..homeserver = Uri.parse(chat.serverUrl!);

  await client.init(
    newToken: chat.accessToken,
    newUserID: '@comms_${_domainId(session)}:${chat.serverName}',
    newHomeserver: Uri.parse(chat.serverUrl!),
    newDeviceID: 'myapp-${DeviceInfo.id}',
    newDeviceName: 'MyApp',
  );

  final room = client.getRoomById(chat.roomId!);
  await room?.join();

  // Start live sync and subscribe to timeline updates
  client.onSync.stream.listen(_handleSync);

  emit(ChatReady(client: client, roomId: chat.roomId!));
}

Future<void> sendMessage(String text) async {
  final state = this.state;
  if (state is! ChatReady) return;
  await state.client.getRoomById(state.roomId)?.sendTextEvent(text);
}
```

Handle the `unavailable` branch explicitly — Matrix may be down temporarily
and the UI should degrade rather than crash.

---

## Step 8 — Close on context end

When the meeting ends, close the room. Comms logs out every active member
so cached tokens stop working immediately.

```js
router.post('/meetings/:id/end', requireAuth, async (req, res, next) => {
  try {
    await db.meeting.update({
      where: { id: req.params.id },
      data: { status: 'ENDED', endedAt: new Date() },
    });

    await closeRoom(req.params.id, 'MEETING');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

On the client, watch for Matrix `401` responses and transition to a
"session ended" state:

```dart
client.onSync.stream.listen((_) {}, onError: (e) {
  if (e is MatrixException && e.error == 'M_UNKNOWN_TOKEN') {
    emit(ChatEnded());
  }
});
```

---

## Step 9 — (Optional) Subscribe to RabbitMQ events

Comms publishes room lifecycle events you can subscribe to for async
fan-out (notifications, analytics, archiving, etc.). With `amqplib`:

```js
// src/communications/commsEventsConsumer.js
const amqp = require('amqplib');
const { snapshotRoom } = require('../archive/archiver');

async function startCommsConsumer() {
  const conn = await amqp.connect(process.env.RABBITMQ_URL);
  const ch = await conn.createChannel();

  // Comms publishes to a fanout exchange (default: comms_events_fanout,
  // overridable via RMQ_EXCHANGE on the comms-service side). Fanout
  // means routing keys are ignored — every bound queue gets every event,
  // and your consumer filters in code.
  const exchange = process.env.COMMS_EXCHANGE || 'comms_events_fanout';
  const queue = 'myapp.comms.events';
  await ch.assertExchange(exchange, 'fanout', { durable: true });
  await ch.assertQueue(queue, { durable: true });
  await ch.bindQueue(queue, exchange, '');

  ch.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      // NestJS publishers wrap the payload as { pattern, data }.
      const envelope = JSON.parse(msg.content.toString());
      const pattern = envelope.pattern ?? msg.fields.routingKey;
      const payload = envelope.data ?? envelope;

      // Filter by appId so your consumer ignores events from other
      // apps sharing the same comms-service instance.
      if (payload.appId !== (process.env.COMMS_APP_ID || 'myapp')) {
        return ch.ack(msg);
      }

      if (pattern === 'communications.room.closed') {
        await snapshotRoom(payload.contextId); // see 04-persistence.md
      }

      ch.ack(msg);
    } catch (err) {
      console.error('[comms-consumer] failed:', err);
      ch.nack(msg, false, false); // dead-letter
    }
  });
}

module.exports = { startCommsConsumer };
```

Wire it into your Express bootstrap:

```js
// src/index.js
const express = require('express');
const meetings = require('./meetings/meetings.routes');
const { startCommsConsumer } = require('./communications/commsEventsConsumer');

const app = express();
app.use(express.json());
app.use('/api/v1', meetings);

app.listen(3000, async () => {
  await startCommsConsumer();
  console.log('myapp listening on :3000');
});
```

Events emitted:

- `communications.room.provisioned`
- `communications.room.activated`
- `communications.room.closed`

---

## End-to-End Sequence

```
User creates meeting          ──▶ provisionRoom          (PROVISIONED)
User starts meeting           ──▶ activateRoom           (ACTIVE)
User opens meeting screen     ──▶ authorizeUser          (returns token)
Client sends/reads messages   ──▶ direct Matrix CS-API
User ends meeting             ──▶ closeRoom              (CLOSED, tokens dead)
Archiver (optional)           ──◀ communications.room.closed event
```

---

## Reference Implementations

Comms-service is designed to serve multiple consumer apps in parallel. Any
backend that can sign a JWT and make HTTP calls can onboard — the examples
above give you everything you need.

If you'd like to see a fully-worked NestJS/TypeScript consumer to compare
patterns against, one lives alongside comms in this repository. Copy what
applies to your stack; ignore the rest.
