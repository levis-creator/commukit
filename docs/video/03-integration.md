# 03 — Integration Guide (Step-by-Step with Examples)

How to wire a consumer app to group video, with runnable examples at each
step. Backend examples use **Express.js** (plain JavaScript, Node 18+).
Translate trivially to any HTTP framework. Client examples use
JavaScript (browser) because the Janus web SDK is the most widely
deployed — the flow is identical in Dart/Flutter/native with their
respective Janus clients.

For the 1:1 call variant, see [04-one-on-one-calls.md](04-one-on-one-calls.md).

---

## Prerequisites

- comms-service deployed and reachable on the internal network
- Janus Gateway running with the `videoroom` plugin enabled
- coturn (or another TURN server) running, reachable from clients
- Shared secrets in comms-service `.env`:
  - `INTERNAL_SERVICE_SECRET`
  - `JANUS_HTTP_URL`, `JANUS_PUBLIC_WS_URL`
  - `JANUS_ICE_SERVERS`, `JANUS_TURN_USERNAME`, `JANUS_TURN_CREDENTIAL`

---

## Step 1 — Pick an `appId` and add config

```bash
# .env (consumer backend)
COMMS_APP_ID=myapp
COMMUNICATIONS_SERVICE_URL=http://comms-service:3014
INTERNAL_SERVICE_SECRET=<same-value-as-comms-service>
```

---

## Step 2 — Reuse the JWT signer from chat docs

The JWT signer is identical across all capabilities. Copy it from
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

Reuse the same client pattern as chat and add the moderation endpoints:

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

async function get(path) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${signInternalToken()}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
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

// ── Moderation ──────────────────────────────────────────────────────────
async function kickVideo(contextId, contextType, domainUserId) {
  return post(`/internal/v1/rooms/${contextId}/kick-video`, {
    appId: APP_ID, contextType, domainUserId,
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
async function listParticipants(contextId, contextType) {
  const qs = new URLSearchParams({ appId: APP_ID, contextType });
  return get(`/internal/v1/rooms/${contextId}/participants?${qs}`);
}

module.exports = {
  provisionRoom, activateRoom, closeRoom, authorizeUser,
  kickVideo, kickAudio, invalidateSession, listParticipants,
};
```

---

## Step 4 — Provision on context creation

```js
// src/calls/calls.routes.js
const express = require('express');
const {
  provisionRoom, activateRoom, closeRoom, authorizeUser, kickVideo,
} = require('../communications/commsClient');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

router.post('/calls', requireAuth, async (req, res, next) => {
  try {
    const { title } = req.body;
    const call = await db.call.create({
      data: { title, createdBy: req.user.id, mode: 'REMOTE' },
    });

    await provisionRoom({
      contextType: 'CALL',
      contextId: call.id,
      title: call.title,
      mode: 'REMOTE', // video-only
    });

    res.status(201).json(call);
  } catch (err) {
    next(err);
  }
});
```

---

## Step 5 — Activate on call start

```js
router.post('/calls/:id/start', requireAuth, async (req, res, next) => {
  try {
    await db.call.update({
      where: { id: req.params.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });
    await activateRoom(req.params.id, 'CALL');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

---

## Step 6 — Expose the session endpoint

```js
router.get('/calls/:id/communications-session', requireAuth, async (req, res, next) => {
  try {
    const call = await db.call.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).json({ error: 'Not found' });

    // Your own domain authorization.
    const allowed = await db.call.userCanJoin(call.id, req.user.id);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });

    const session = await authorizeUser(call.id, {
      contextType: 'CALL',
      domainUserId: req.user.id,
      displayName: req.user.displayName,
      roles: req.user.id === call.createdBy ? ['MODERATOR'] : ['PARTICIPANT'],
    });

    if (!session) return res.status(503).json({ error: 'Video unavailable' });
    res.json(session);
  } catch (err) {
    next(err);
  }
});
```

---

## Step 7 — Wire the client (browser / Janus web SDK)

Uses `janus-gateway.js`. The same shape translates to Dart (`janus_client`),
iOS, Android, or Unity Janus clients.

```html
<script src="https://cdn.jsdelivr.net/npm/janus-gateway@1.2.0/janus.js"></script>
```

```js
// callClient.js
async function joinCall(callId, me) {
  const res = await fetch(`/api/v1/calls/${callId}/communications-session`, {
    headers: { Authorization: `Bearer ${me.apiToken}` },
  });
  const session = await res.json();

  if (session.videoRoom?.status !== 'available') {
    throw new Error(session.videoRoom?.reason || 'Video unavailable');
  }

  const { roomId, wsUrl, iceServers } = session.videoRoom;

  await new Promise((r) => Janus.init({ debug: 'warn', callback: r }));

  const janus = await new Promise((resolve, reject) => {
    const j = new Janus({
      server: wsUrl,
      iceServers,
      success: () => resolve(j),
      error: reject,
    });
  });

  let videoroom;
  await new Promise((resolve, reject) => {
    janus.attach({
      plugin: 'janus.plugin.videoroom',
      success: (handle) => { videoroom = handle; resolve(); },
      error: reject,

      onmessage: (msg, jsep) => handleMessage(msg, jsep, videoroom),
      onlocaltrack: (track, added) => attachLocalTrack(track, added),
      onremotetrack: (track, mid, added, meta) => attachRemoteTrack(track, mid, added),
    });
  });

  // IMPORTANT: the display MUST follow `DisplayName|domainUserId` so
  // server-side moderation can resolve your domain user id.
  videoroom.send({
    message: {
      request: 'join',
      room: roomId,
      ptype: 'publisher',
      display: `${me.displayName}|${me.id}`,
    },
  });

  return { janus, videoroom, roomId };
}

async function handleMessage(msg, jsep, videoroom) {
  if (msg.videoroom === 'joined') {
    // Publish our own audio+video
    const offer = await new Promise((resolve, reject) => {
      videoroom.createOffer({
        media: { audio: true, video: true },
        success: resolve,
        error: reject,
      });
    });
    videoroom.send({
      message: { request: 'configure', audio: true, video: true },
      jsep: offer,
    });

    // Subscribe to existing publishers
    for (const pub of msg.publishers || []) {
      subscribeToPublisher(pub);
    }
  } else if (msg.videoroom === 'event' && msg.publishers) {
    // New publishers joined — subscribe to them too
    for (const pub of msg.publishers) subscribeToPublisher(pub);
  }

  if (jsep) videoroom.handleRemoteJsep({ jsep });
}
```

Subscriber attach logic (`subscribeToPublisher`) follows the standard
Janus VideoRoom subscriber flow — attach a second plugin handle, send
`join` with `ptype: 'subscriber'`, handle the incoming offer, answer it.
Every Janus SDK ships the same pattern.

---

## Step 8 — Moderation (optional)

Hosts kick a misbehaving participant via your backend:

```js
router.post('/calls/:id/kick/:userId', requireAuth, async (req, res, next) => {
  try {
    const call = await db.call.findUnique({ where: { id: req.params.id } });
    if (!call || call.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can kick' });
    }

    await kickVideo(req.params.id, 'CALL', req.params.userId);
    // Prevent rejoin by invalidating the membership too:
    await invalidateSession(req.params.id, 'CALL', req.params.userId);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

See [05-moderation.md](05-moderation.md) for mute, list-participants,
and mute-all.

---

## Step 9 — Close on call end

```js
router.post('/calls/:id/end', requireAuth, async (req, res, next) => {
  try {
    await db.call.update({
      where: { id: req.params.id },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    await closeRoom(req.params.id, 'CALL');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

Client side, watch for Janus `hangup` / `detached` events and surface a
"call ended" state.

---

## End-to-End Sequence

```
Host creates call            ──▶ provisionRoom    (PROVISIONED)
Host starts call             ──▶ activateRoom     (ACTIVE)
Each participant joins       ──▶ authorizeUser    (returns videoRoom coords)
Client opens Janus WS        ──▶ direct to Janus
Host kicks bad actor         ──▶ kickVideo + invalidateSession
Call ends                    ──▶ closeRoom        (Janus room destroyed)
```
