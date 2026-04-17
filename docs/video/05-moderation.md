# 05 — Moderation

Moderation commands are internal endpoints called by your backend on
behalf of a user with moderator privileges. Your backend is responsible
for deciding *who* is a moderator — comms just enforces the command.

The moderation API is identical regardless of the active media provider.
Comms translates each command into the appropriate provider call
internally.

---

## Participant Identity

How comms resolves `domainUserId` to a participant depends on the provider.

### With LiveKit (default)

Participant identity is embedded in the JWT token metadata at
authorize-time. Comms maps `domainUserId` directly to the participant
identity in the LiveKit room — no client-side convention needed.

### With Janus

Clients **must** set their Janus display name to:

```
<DisplayName>|<domainUserId>
```

Example: `Jane Doe|7f3c1b2e-9a4d-4b56-8e1f-112233445566`

When comms receives a moderation command referencing `domainUserId`, it
calls `listparticipants` on the Janus room, splits every display on `|`,
and matches the suffix exactly. Without this convention moderation
degrades to a substring fallback (less precise, logs a warning) and can
fail outright when display names overlap.

### Hardware handles (Janus-specific)

Displays containing `|HARDWARE` are reserved for physical room equipment
(in-room mic arrays, codec systems). Comms refuses any moderation
command that resolves to a `|HARDWARE` handle — kicking the room's own
microphone would cut audio for everyone in that physical space. This
convention applies only to Janus; LiveKit participants are always
software clients.

---

## Endpoints

### Audio: mute a participant

```
POST /internal/v1/rooms/:contextId/mute
```
```json
{ "appId": "myapp", "contextType": "CALL", "domainUserId": "<uuid>" }
```

Mutes a single participant in the AudioBridge room. Only meaningful for
`IN_PERSON` and `HYBRID` rooms — `REMOTE` rooms carry audio inside the
VideoRoom, so there's no AudioBridge to mute. Requires the room to be
`ACTIVE`.

### Audio: unmute a participant

```
POST /internal/v1/rooms/:contextId/unmute
```
Same body. Returns `404` when the participant isn't currently in the
AudioBridge (e.g. hasn't joined yet) — your backend should retry with
backoff for "mic-on" flows where you unmute a user who's just been
granted the floor.

### Audio: mute the whole room

```
POST /internal/v1/rooms/:contextId/mute-room
```
```json
{ "appId": "myapp", "contextType": "CALL" }
```

Mutes **all** participants at once. Used for emergency quiet, voting
lockdown, or preparing to pass the floor.

### Video: kick a participant

```
POST /internal/v1/rooms/:contextId/kick-video
```
```json
{ "appId": "myapp", "contextType": "CALL", "domainUserId": "<uuid>" }
```

Removes the user from the VideoRoom. They can technically reconnect via
`authorize-user` unless you also invalidate their session (below).

### Audio: kick a participant

```
POST /internal/v1/rooms/:contextId/kick-audio
```
Same shape. Removes from the AudioBridge.

### Invalidate session (block rejoin)

```
POST /internal/v1/rooms/:contextId/invalidate-session
```
```json
{ "appId": "myapp", "contextType": "CALL", "domainUserId": "<uuid>" }
```

Sets `leftAt` on the membership row. Subsequent `authorize-user` calls
for that `(room, user)` pair return `403`. **Always pair a kick with an
invalidate-session if you don't want the user to rejoin.**

### List participants

```
GET /internal/v1/rooms/:contextId/participants?appId=myapp&contextType=CALL
```

Returns:
```json
[
  { "id": "participant-id", "display": "Jane Doe", "domainUserId": "<uuid>", "muted": false },
  { "id": "participant-id", "display": "Bob Smith", "domainUserId": "<uuid>", "muted": true }
]
```

Use this to render a moderation UI on your client.

---

## Mute vs Kick — Which to Use

| Goal | Command |
|---|---|
| Temporarily silence someone, they can still hear and see | `mute` |
| Silence everyone (emergency / vote) | `mute-room` |
| Remove from video but keep membership (reversible) | `kick-video` |
| Remove from call entirely, no rejoin | `kick-video` + `invalidate-session` |
| Permanent ban from future contexts | Your domain logic — comms has no user-level ban |

---

## Express Moderation Routes (Example)

```js
const { kickVideo, kickAudio, invalidateSession, listParticipants }
  = require('../communications/commsClient');

router.get('/calls/:id/participants', requireAuth, async (req, res, next) => {
  try {
    const participants = await listParticipants(req.params.id, 'CALL');
    res.json(participants || []);
  } catch (err) {
    next(err);
  }
});

router.post('/calls/:id/kick/:userId', requireAuth, async (req, res, next) => {
  try {
    const call = await db.call.findUnique({ where: { id: req.params.id } });
    if (!call || call.createdBy !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can kick' });
    }

    // Kick from both transports (safe to call kickAudio on a REMOTE room
    // — it will just return a non-2xx which the client wrapper swallows).
    await Promise.all([
      kickVideo(req.params.id, 'CALL', req.params.userId),
      kickAudio(req.params.id, 'CALL', req.params.userId),
    ]);

    // Block rejoin.
    await invalidateSession(req.params.id, 'CALL', req.params.userId);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

---

## Audit Trail

Every moderation action writes an immutable row to
`communication_audit_logs`:

| Action | When |
|---|---|
| `MIC_MUTED` | `mute` succeeded |
| `MIC_UNMUTED` | `unmute` succeeded |
| `ROOM_MUTED` | `mute-room` succeeded |
| `PARTICIPANT_KICKED_AUDIO` | `kick-audio` succeeded |
| `PARTICIPANT_KICKED_VIDEO` | `kick-video` succeeded |
| `SESSION_INVALIDATED` | `invalidate-session` succeeded |

The log records `actorUserId` (the user your backend said was kicking)
and a JSON metadata blob with resolved participant IDs. Use this for
post-incident review and compliance.
