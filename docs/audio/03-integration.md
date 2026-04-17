# 03 — Integration Guide (Step-by-Step with Examples)

How to wire a consumer app to group audio, with runnable examples at
each step. Backend examples use **Express.js**; client examples cover
both LiveKit and Janus SDKs. Every shape translates directly to any
HTTP framework or client library (Dart, Swift, Kotlin, native).

For the 1:1 voice call variant, see [04-voice-calls.md](04-voice-calls.md).

---

## Prerequisites

- comms-service deployed and reachable on the internal network
- A media provider running:
  - **LiveKit (default):** LiveKit server with API key/secret configured
  - **Janus (opt-in):** Janus Gateway with the `audiobridge` plugin enabled
- coturn (or another TURN server) — required if your clients are on
  restrictive networks
- Shared secrets in comms-service `.env`:
  - `INTERNAL_SERVICE_SECRET`
  - LiveKit: `LIVEKIT_API_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_PUBLIC_URL`
  - Janus: `JANUS_HTTP_URL`, `JANUS_PUBLIC_WS_URL`

---

## Step 1 — Pick an `appId` and add config

```bash
# .env (consumer backend)
COMMS_APP_ID=myapp
COMMUNICATIONS_SERVICE_URL=http://comms-service:3014
INTERNAL_SERVICE_SECRET=<same-value-as-comms-service>
```

---

## Step 2 — Reuse the JWT signer

Identical across all capabilities — see
[../chat/03-integration.md](../chat/03-integration.md#step-2--write-an-internal-jwt-signer):

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

Same pattern as chat and video. If you already built the video client,
it works unchanged — just call it with `mode: 'IN_PERSON'`.

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

async function provisionRoom(input) {
  return post('/internal/v1/rooms/provision', { appId: APP_ID, ...input });
}
async function activateRoom(contextId, contextType) {
  return post(`/internal/v1/rooms/${contextId}/activate`, { appId: APP_ID, contextType });
}
async function closeRoom(contextId, contextType) {
  return post(`/internal/v1/rooms/${contextId}/close`, { appId: APP_ID, contextType });
}
async function authorizeUser(contextId, input) {
  return post(`/internal/v1/rooms/${contextId}/authorize-user`, { appId: APP_ID, ...input });
}

// Moderation
async function muteUser(contextId, contextType, domainUserId) {
  return post(`/internal/v1/rooms/${contextId}/mute`, {
    appId: APP_ID, contextType, domainUserId,
  });
}
async function unmuteUser(contextId, contextType, domainUserId) {
  return post(`/internal/v1/rooms/${contextId}/unmute`, {
    appId: APP_ID, contextType, domainUserId,
  });
}
async function muteRoomAll(contextId, contextType) {
  return post(`/internal/v1/rooms/${contextId}/mute-room`, {
    appId: APP_ID, contextType,
  });
}
async function kickAudio(contextId, contextType, domainUserId) {
  return post(`/internal/v1/rooms/${contextId}/kick-audio`, {
    appId: APP_ID, contextType, domainUserId,
  });
}
async function invalidateSession(contextId, contextType, domainUserId) {
  return post(`/internal/v1/rooms/${contextId}/invalidate-session`, {
    appId: APP_ID, contextType, domainUserId,
  });
}

module.exports = {
  provisionRoom, activateRoom, closeRoom, authorizeUser,
  muteUser, unmuteUser, muteRoomAll, kickAudio, invalidateSession,
};
```

---

## Step 4 — Provision on context creation

```js
// src/rooms/voice.routes.js
const express = require('express');
const {
  provisionRoom, activateRoom, closeRoom, authorizeUser, muteUser,
} = require('../communications/commsClient');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

router.post('/voice-rooms', requireAuth, async (req, res, next) => {
  try {
    const { title } = req.body;
    const room = await db.voiceRoom.create({
      data: { title, createdBy: req.user.id },
    });

    await provisionRoom({
      contextType: 'VOICE_ROOM',
      contextId: room.id,
      title: room.title,
      mode: 'IN_PERSON', // audio-only
    });

    res.status(201).json(room);
  } catch (err) {
    next(err);
  }
});
```

---

## Step 5 — Activate on room open

```js
router.post('/voice-rooms/:id/open', requireAuth, async (req, res, next) => {
  try {
    await db.voiceRoom.update({
      where: { id: req.params.id },
      data: { status: 'OPEN', openedAt: new Date() },
    });
    await activateRoom(req.params.id, 'VOICE_ROOM');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

---

## Step 6 — Expose the session endpoint

```js
router.get('/voice-rooms/:id/communications-session', requireAuth, async (req, res, next) => {
  try {
    const room = await db.voiceRoom.findUnique({ where: { id: req.params.id } });
    if (!room) return res.status(404).json({ error: 'Not found' });

    const allowed = await db.voiceRoom.userCanJoin(room.id, req.user.id);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    const session = await authorizeUser(room.id, {
      contextType: 'VOICE_ROOM',
      domainUserId: req.user.id,
      displayName: req.user.displayName,
      roles: req.user.id === room.createdBy ? ['MODERATOR'] : ['PARTICIPANT'],
    });
    if (!session) return res.status(503).json({ error: 'Audio unavailable' });

    res.json(session);
  } catch (err) {
    next(err);
  }
});
```

---

## Step 7 — Wire the client

The client reads `audioBridge.credentials.provider` from the session
response and connects using the matching SDK. Use a `switch` to handle
both providers.

### Provider dispatch pattern (JavaScript)

```js
async function joinAudio(session, me) {
  if (session.audioBridge?.status !== 'available') {
    throw new Error(session.audioBridge?.reason || 'Audio unavailable');
  }

  const { credentials } = session.audioBridge;

  switch (credentials.provider) {
    case 'livekit':
      return joinWithLiveKit(credentials);
    case 'janus':
      return joinWithJanus(credentials, me);
    default:
      throw new Error(`Unknown audio provider: ${credentials.provider}`);
  }
}
```

### With LiveKit (default) — Web (`livekit-client` npm)

```js
import { Room, RoomEvent, Track } from 'livekit-client';

async function joinWithLiveKit(credentials) {
  const room = new Room();

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const audioEl = track.attach();
      document.body.appendChild(audioEl);
    }
  });

  await room.connect(credentials.url, credentials.token);
  await room.localParticipant.setMicrophoneEnabled(true);

  return { room, leave: () => room.disconnect() };
}
```

### With LiveKit — Flutter (`livekit_client` package)

```dart
import 'package:livekit_client/livekit_client.dart';

Future<Room> joinWithLiveKit(Map<String, dynamic> credentials) async {
  final room = Room();
  await room.connect(credentials['url'], credentials['token']);
  await room.localParticipant?.setMicrophoneEnabled(true);
  return room;
}
```

### With Janus — Web (`janus-gateway` SDK)

```html
<script src="https://cdn.jsdelivr.net/npm/janus-gateway@1.2.0/janus.js"></script>
```

```js
async function joinWithJanus(credentials, me) {
  const { roomId: audioRoomId, wsUrl } = credentials;

  await new Promise((r) => Janus.init({ debug: 'warn', callback: r }));

  const janus = await new Promise((resolve, reject) => {
    const j = new Janus({
      server: wsUrl,
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      success: () => resolve(j),
      error: reject,
    });
  });

  let audiobridge;
  await new Promise((resolve, reject) => {
    janus.attach({
      plugin: 'janus.plugin.audiobridge',
      success: (handle) => { audiobridge = handle; resolve(); },
      error: reject,

      onmessage: async (msg, jsep) => {
        if (msg.audiobridge === 'joined') {
          const offer = await new Promise((resolve, reject) => {
            audiobridge.createOffer({
              media: { audio: true, video: false },
              success: resolve,
              error: reject,
            });
          });
          audiobridge.send({
            message: { request: 'configure', muted: false },
            jsep: offer,
          });
        }
        if (jsep) audiobridge.handleRemoteJsep({ jsep });
      },

      onremotestream: (stream) => {
        const audioEl = document.getElementById('mixed-audio');
        audioEl.srcObject = stream;
        audioEl.play();
      },
    });
  });

  // IMPORTANT: display MUST follow `DisplayName|domainUserId`
  // so server-side moderation can resolve your domain user id.
  audiobridge.send({
    message: {
      request: 'join',
      room: audioRoomId,
      display: `${me.displayName}|${me.id}`,
      muted: false,
    },
  });

  return {
    janus, audiobridge, audioRoomId,
    leave: () => {
      audiobridge.send({ message: { request: 'leave' } });
      audiobridge.detach();
      janus.destroy();
    },
  };
}
```

### Provider dispatch pattern (Flutter / Dart)

```dart
Future<void> joinAudio(Map<String, dynamic> session, User me) async {
  final audioBridge = session['audioBridge'];
  if (audioBridge?['status'] != 'available') {
    throw Exception(audioBridge?['reason'] ?? 'Audio unavailable');
  }

  final credentials = audioBridge['credentials'];
  switch (credentials['provider']) {
    case 'livekit':
      await joinWithLiveKit(credentials);
      break;
    case 'janus':
      await joinWithJanus(credentials, me);
      break;
    default:
      throw Exception('Unknown provider: ${credentials['provider']}');
  }
}
```

---

## Step 8 — Moderation (optional)

```js
router.post('/voice-rooms/:id/mute/:userId', requireAuth, async (req, res, next) => {
  try {
    const room = await db.voiceRoom.findUnique({ where: { id: req.params.id } });
    if (!room || room.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can mute' });
    }
    await muteUser(req.params.id, 'VOICE_ROOM', req.params.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/voice-rooms/:id/mute-all', requireAuth, async (req, res, next) => {
  try {
    const room = await db.voiceRoom.findUnique({ where: { id: req.params.id } });
    if (!room || room.createdBy !== req.user.id) return res.status(403).end();
    await muteRoomAll(req.params.id, 'VOICE_ROOM');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

See [05-moderation.md](05-moderation.md) for kick, unmute, and
list-participants.

---

## Step 9 — Close on room end

```js
router.post('/voice-rooms/:id/close', requireAuth, async (req, res, next) => {
  try {
    await db.voiceRoom.update({
      where: { id: req.params.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    await closeRoom(req.params.id, 'VOICE_ROOM');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

---

## End-to-End Sequence

```
Host creates voice room      --> provisionRoom    (PROVISIONED)
Host opens room              --> activateRoom     (ACTIVE)
Each user joins              --> authorizeUser    (returns audioBridge credentials)
Client connects to provider  --> direct to LiveKit or Janus
Host mutes a disruptor       --> muteUser         (server-enforced)
Room closes                  --> closeRoom        (provider room destroyed)
```
