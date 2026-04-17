# 04 — Voice Calls (1:1 and Small Group)

Comms-service has no dedicated "voice call" primitive. A voice call is
just an `IN_PERSON` room with the right number of users authorized.
This mirrors the video 1:1 pattern — the server stays simple and your
app owns the call UX.

The media provider (LiveKit or Janus) is abstracted by the comms
service. Both providers support `IN_PERSON` mode for voice calls — the
only difference is how clients connect after receiving session
credentials.

---

## The Model

```
                              +------------------------+
+--------+   authorize-user   | communications-service |   authorize-user   +--------+
| Alice  | -----------------> |   IN_PERSON room       | <----------------- | Bob    |
| (caller|                    +----------+-------------+                    |(callee)|
+---+----+                               |                                  +---+----+
    |                                     |                                      |
    |   connect (LiveKit token or         |                                      |
    |    Janus WS audiobridge)            |                                      |
    +-------------------------------------+--------------------------------------+
                      via media provider (audio mixer)
```

- One audio room per call, keyed by a `contextId` your app
  chooses (e.g. a call uuid or `voice:<alice>:<bob>:<timestamp>`).
- Both participants get the same room coordinates from
  `authorize-user` and connect to the media provider directly.
- The provider mixes audio and sends the mix back to each
  participant. Each client has one connection.
- Small groups work the same way — just authorize more users.

## Why AudioBridge / IN_PERSON Mode for Voice Calls

| Concern | IN_PERSON (AudioBridge / LiveKit audio) | REMOTE (VideoRoom / LiveKit video) |
|---|---|---|
| Server-enforced mute | Yes | Depends on provider |
| Bandwidth to client | Flat — one mixed stream (Janus) / optimized tracks (LiveKit) | Per-participant streams |
| Recording | One mixed file | Per-participant files |
| Good for | Voice calls, phone-style UX, broadcast | Video calls with optional video off |

Voice calls go through `IN_PERSON` mode. If the user later turns on a
camera, you've made a product decision — either (a) use `REMOTE` from
the start, or (b) keep voice in `IN_PERSON` and build a separate flow
for video escalation.

## Signalling: Ringing

Same story as video calls — comms doesn't ring anyone. Your app does,
via whatever real-time channel you already have (push notification,
websocket, chat event). See
[../video/04-one-on-one-calls.md](../video/04-one-on-one-calls.md#signalling-how-the-callee-knows-to-pick-up)
for options; they apply identically to voice.

---

## Step-by-Step Flow

### 1. Alice initiates the call

```js
router.post('/voice-calls', requireAuth, async (req, res, next) => {
  try {
    const { calleeId } = req.body;

    const call = await db.voiceCall.create({
      data: {
        callerId: req.user.id,
        calleeId,
        status: 'RINGING',
        startedAt: new Date(),
      },
    });

    await provisionRoom({
      contextType: 'VOICE_CALL',
      contextId: call.id,
      title: `Voice call ${call.id}`,
      mode: 'IN_PERSON',
    });

    await ringUser(calleeId, { callId: call.id, from: req.user, kind: 'voice' });

    res.status(201).json(call);
  } catch (err) {
    next(err);
  }
});
```

### 2. Bob accepts

```js
router.post('/voice-calls/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const call = await db.voiceCall.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).end();
    if (call.calleeId !== req.user.id) return res.status(403).end();
    if (call.status !== 'RINGING') return res.status(409).json({ error: 'Not ringing' });

    await db.voiceCall.update({
      where: { id: call.id },
      data: { status: 'IN_PROGRESS', acceptedAt: new Date() },
    });

    await activateRoom(call.id, 'VOICE_CALL');

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

### 3. Both clients fetch the same session

```js
router.get('/voice-calls/:id/communications-session', requireAuth, async (req, res, next) => {
  try {
    const call = await db.voiceCall.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).end();

    if (req.user.id !== call.callerId && req.user.id !== call.calleeId) {
      return res.status(403).json({ error: 'Not a participant' });
    }
    if (call.status !== 'IN_PROGRESS') {
      return res.status(409).json({ error: `Call is ${call.status}` });
    }

    const session = await authorizeUser(call.id, {
      contextType: 'VOICE_CALL',
      domainUserId: req.user.id,
      displayName: req.user.displayName,
      roles: ['PARTICIPANT'],
    });
    if (!session) return res.status(503).json({ error: 'Audio unavailable' });

    res.json(session);
  } catch (err) {
    next(err);
  }
});
```

Both clients then use the provider-specific connect flow from
[03-integration.md Step 7](03-integration.md#step-7--wire-the-client)
unchanged. Switch on `audioBridge.credentials.provider` to pick the
right SDK.

### 4. Decline / hangup / timeout

```js
router.post('/voice-calls/:id/hangup', requireAuth, async (req, res, next) => {
  try {
    const call = await db.voiceCall.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).end();
    if (req.user.id !== call.callerId && req.user.id !== call.calleeId) {
      return res.status(403).end();
    }

    const endStatus =
      call.status === 'RINGING'
        ? (req.user.id === call.calleeId ? 'DECLINED' : 'CANCELLED')
        : 'ENDED';

    await db.voiceCall.update({
      where: { id: call.id },
      data: { status: endStatus, endedAt: new Date() },
    });

    await closeRoom(call.id, 'VOICE_CALL');
    await notifyHangup(call);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

### 5. Ring timeout

Background job / scheduled timer: if the call stays `RINGING` for
longer than your timeout (typically 30-60s for voice), mark as `MISSED`
and `closeRoom` the same way `hangup` does.

---

## Group Voice Calls

Same flow, more authorized users. Two real considerations:

- **Provisioning order.** Activate the room first, then authorize each
  participant as they join. Or pre-authorize everyone and let them
  connect whenever — comms is idempotent, so re-running
  `authorize-user` is safe.
- **Participant cap.** Both providers handle dozens of participants
  well. For hundreds, see
  [07-troubleshooting.md](07-troubleshooting.md#scaling).

---

## UX Considerations

| Concern | Recommendation |
|---|---|
| **Pre-flight mic check** | Let the client open the mic stream before `POST /voice-calls` so the user isn't greeted with a permission prompt after the callee picks up. |
| **Ringtone / ringback** | Play locally on each client. Comms doesn't generate tones. |
| **Busy / Do Not Disturb** | Check in your ringing layer before calling `provisionRoom`. If the callee is busy, transition to `MISSED` without provisioning. |
| **Reconnection** | If a participant drops, re-`GET /communications-session`. Same coordinates come back while the room is `ACTIVE`. LiveKit tokens may need to be refreshed if expired (15-min TTL). |
| **Call history** | Persist `voiceCall` rows in your DB. Your `status` + timestamps become the history. |
| **Hold / resume** | Client-side local mute + display the "on hold" label. No server support needed. |
| **Missed calls** | Subscribe to `communications.room.closed` events; if your DB still shows `RINGING` for that `contextId`, mark `MISSED` and push a notification. |
