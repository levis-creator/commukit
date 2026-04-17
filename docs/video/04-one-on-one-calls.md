# 04 — One-on-One Calls

Comms-service has no dedicated "1:1 call" primitive. A 1:1 call is simply a
`REMOTE` room with exactly two authorized users. This keeps the server
simple and lets your app decide the UX — whether that's a ringing
WhatsApp-style experience, a "click to join" link, or a scheduled meeting.

Both LiveKit and Janus support this model identically at the API level.
The only difference is how clients connect after receiving session
credentials (see [03-integration.md, Step 7](03-integration.md#step-7--wire-the-client)).

---

## The Model

```
+---------+              +----------------------+              +---------+
| Alice   | ---------->  | communications-service | <--------- | Bob     |
| (caller)|   authorize  |   (REMOTE room, cap 2) |  authorize | (callee)|
+----+----+              +----------+------------+              +----+----+
     |                              |                               |
     | connect (publish+sub)        |                               | connect
     +------------------------------+-------------------------------+
                    via media provider (LiveKit or Janus)
```

- The room is keyed by a `contextId` you pick — e.g.
  `call:<alice-id>:<bob-id>:<timestamp>` or a pre-generated call uuid.
- Both participants receive the same video credentials from
  `authorize-user` and connect to the media provider directly.
- The provider forwards Alice's stream to Bob and vice versa.

Why not peer-to-peer mesh for 1:1? SFU adds ~30ms latency but gives you
working TURN, consistent behavior across 1:1 and group, a single code
path on the client, and hooks for server-side recording.

---

## Signalling: How the Callee Knows to Pick Up

Comms doesn't ring anyone — **your app owns signalling**. Typical
choices:

1. **Push notification** — send a FCM / APNs push to the callee with the
   `callId`. The callee taps it, which opens the call screen and calls
   `GET /calls/:id/communications-session`.

2. **WebSocket / SSE fan-out** — if your app already has a real-time
   channel (Socket.IO, SSE, a shared Matrix room), emit a
   `call.incoming` event with the `callId`.

3. **Matrix chat event** — if you already use the chat capability, send a
   custom Matrix event like `myapp.call.invite` into a direct chat room
   and let the client SDK surface it.

Comms just provisions the room and hands out coordinates. Ring, timeout,
decline, busy — all live in your app's domain logic.

---

## Step-by-Step Flow

### 1. Alice initiates the call

```js
// POST /calls
router.post('/calls', requireAuth, async (req, res, next) => {
  try {
    const { calleeId } = req.body;

    // Create a call record in your DB.
    const call = await db.call.create({
      data: {
        callerId: req.user.id,
        calleeId,
        status: 'RINGING',
        startedAt: new Date(),
      },
    });

    // Provision a REMOTE room for exactly this call.
    await provisionRoom({
      contextType: 'CALL',
      contextId: call.id,
      title: `Call ${call.id}`,
      mode: 'REMOTE',
    });

    // Fire-and-forget ring: push notification, websocket, whatever.
    await ringUser(calleeId, { callId: call.id, from: req.user });

    // Return the call record so Alice's client can navigate to the
    // call screen and fetch the session.
    res.status(201).json(call);
  } catch (err) {
    next(err);
  }
});
```

### 2. Bob receives the ring -> opens the call screen -> accepts

```js
// POST /calls/:id/accept
router.post('/calls/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const call = await db.call.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).end();
    if (call.calleeId !== req.user.id) return res.status(403).end();
    if (call.status !== 'RINGING') return res.status(409).json({ error: 'Not ringing' });

    await db.call.update({
      where: { id: call.id },
      data: { status: 'IN_PROGRESS', acceptedAt: new Date() },
    });

    // Activate the room — only now do participants start joining.
    await activateRoom(call.id, 'CALL');

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

### 3. Both clients fetch the same session endpoint

```js
// GET /calls/:id/communications-session
router.get('/calls/:id/communications-session', requireAuth, async (req, res, next) => {
  try {
    const call = await db.call.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).end();

    // Only the two parties are allowed in.
    if (req.user.id !== call.callerId && req.user.id !== call.calleeId) {
      return res.status(403).json({ error: 'Not a participant' });
    }
    if (call.status !== 'IN_PROGRESS') {
      return res.status(409).json({ error: `Call is ${call.status}` });
    }

    const session = await authorizeUser(call.id, {
      contextType: 'CALL',
      domainUserId: req.user.id,
      displayName: req.user.displayName,
      roles: ['PARTICIPANT'],
    });
    if (!session) return res.status(503).json({ error: 'Video unavailable' });

    res.json(session);
  } catch (err) {
    next(err);
  }
});
```

Both Alice's and Bob's clients use the provider-dispatch pattern from
[03-integration.md, Step 7](03-integration.md#step-7--wire-the-client)
unchanged.

### 4. Decline / timeout / hangup

All of these end up calling the same endpoint:

```js
// POST /calls/:id/hangup
router.post('/calls/:id/hangup', requireAuth, async (req, res, next) => {
  try {
    const call = await db.call.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).end();
    if (req.user.id !== call.callerId && req.user.id !== call.calleeId) {
      return res.status(403).end();
    }

    const endStatus =
      call.status === 'RINGING'
        ? (req.user.id === call.calleeId ? 'DECLINED' : 'CANCELLED')
        : 'ENDED';

    await db.call.update({
      where: { id: call.id },
      data: { status: endStatus, endedAt: new Date() },
    });

    // Close the comms room — destroys the media room and
    // invalidates any cached sessions.
    await closeRoom(call.id, 'CALL');

    // Notify the other party via your usual signalling channel.
    await notifyHangup(call);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

### 5. Ring timeout

Run a background job or a scheduled timer: if a call stays `RINGING` for
longer than your timeout (e.g. 45s), transition it to `MISSED` and call
`closeRoom` the same way `hangup` does.

---

## UX Considerations

| Concern | Recommendation |
|---|---|
| **Ringing without burning media** | Don't call `activateRoom` until accept. The room exists in `PROVISIONED` so Alice can't join prematurely either. |
| **Pre-flight mic/cam check** | Let Alice open a local preview before the `POST /calls` so she's not greeted with a permission prompt after Bob picks up. |
| **Call history** | Persist `call` rows in your own DB — comms only stores a room, not a call. Your `status` + timestamps become the history. |
| **Missed calls** | Listen to `communications.room.closed` events and, if your DB still shows `RINGING`, mark as `MISSED` and push a notification to the callee. |
| **Reconnection** | If a participant drops, `GET /communications-session` again — the same credentials come back as long as the room is still `ACTIVE`. |

---

## Scaling Past 1:1

The same flow works for small group calls (3-10 participants) with zero
changes — just authorize more users to the same room. Past ~20
participants, review media provider resource limits and consider
simulcast (LiveKit enables this automatically with `dynacast`; for Janus,
configure it explicitly). Past ~50, move to paginated subscriber lists or
a broadcaster/viewer split. Comms-service itself has no built-in cap.
