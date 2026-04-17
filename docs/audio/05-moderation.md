# 05 — Moderation

Audio moderation is **server-enforced** — the comms service abstracts
the underlying media provider and enforces mute/unmute/kick commands
regardless of whether LiveKit or Janus is the active backend. The
moderation REST API is identical for both providers.

Your backend is responsible for deciding *who* is a moderator. Comms
just enforces the command.

---

## Participant Identity

How the comms service resolves a `domainUserId` to a participant
depends on the media provider:

### With LiveKit (default)

Participant identity is embedded in the JWT token metadata at
authorization time. The comms service maps `domainUserId` to the
LiveKit participant identity directly — no client-side convention
needed.

### With Janus

Clients **must** set their Janus display to:

```
<DisplayName>|<domainUserId>
```

Example: `Jane Doe|7f3c1b2e-9a4d-4b56-8e1f-112233445566`

Comms calls `listparticipants` on the Janus room, splits every display
on `|`, and matches the suffix exactly. Without this convention
moderation degrades to a substring fallback (less precise, logs a
warning).

### Hardware handles (reserved)

Displays containing `|HARDWARE` are reserved for physical room
equipment. Comms refuses any moderation command that resolves to
`|HARDWARE` — muting a physical room's microphone would cut audio for
everyone in that space. This applies to both providers.

---

## Endpoints

All endpoints are provider-agnostic. The comms service routes the
command to the active media provider internally.

### Mute a participant

```
POST /internal/v1/rooms/:contextId/mute
```
```json
{ "appId": "myapp", "contextType": "VOICE_ROOM", "domainUserId": "<uuid>" }
```

The participant's audio is dropped from the mix. They can still hear
everyone. Requires the room to be `ACTIVE`.

### Unmute a participant

```
POST /internal/v1/rooms/:contextId/unmute
```

Same body. Returns `404` when the participant hasn't joined the
audio room yet — your backend should retry with backoff for
"grant-the-floor" flows where you unmute a user who's just been
permitted to speak.

### Mute everyone

```
POST /internal/v1/rooms/:contextId/mute-room
```
```json
{ "appId": "myapp", "contextType": "VOICE_ROOM" }
```

Mutes **all** participants at once. Use for:

- Emergency quiet ("the moderator needs the floor")
- Voting lockdown
- Passing the floor cleanly between speakers
- Broadcast mode ("only the host speaks")

### Kick from audio

```
POST /internal/v1/rooms/:contextId/kick-audio
```
```json
{ "appId": "myapp", "contextType": "VOICE_ROOM", "domainUserId": "<uuid>" }
```

Removes the participant from the audio room. They can technically
reconnect via `authorize-user` unless you also invalidate the session.

### Invalidate session (block rejoin)

```
POST /internal/v1/rooms/:contextId/invalidate-session
```
```json
{ "appId": "myapp", "contextType": "VOICE_ROOM", "domainUserId": "<uuid>" }
```

Sets `leftAt` on the membership row. Subsequent `authorize-user` calls
for that `(room, user)` pair return `403`. Always pair a kick with
`invalidate-session` if you don't want the user to rejoin.

### List participants

```
GET /internal/v1/rooms/:contextId/participants?appId=myapp&contextType=VOICE_ROOM
```

Returns:

```json
[
  { "id": "participant-id", "display": "Jane Doe", "domainUserId": "<uuid>", "muted": false },
  { "id": "participant-id", "display": "Bob Smith", "domainUserId": "<uuid>", "muted": true }
]
```

Use this to render a moderation UI. The response shape is normalized
across providers.

---

## Client-Side Mute vs Server-Side Mute

Both exist; pick based on intent.

| Mute type | Who controls it | Use case |
|---|---|---|
| **Client-side** | The user themselves (LiveKit: `setMicrophoneEnabled(false)`, Janus: `configure: { muted: true }`) | "I want to mute myself" |
| **Server-side** | Your backend, via `POST /mute` | "The host is muting me" |

They're independent — server mute overrides local mute for mixing
purposes. Your UI should distinguish between "I muted myself" and "the
host muted me" so users aren't confused about why unmute doesn't work.

---

## Decision Table — Mute vs Kick

| Goal | Command |
|---|---|
| Temporarily silence someone | `mute` |
| Silence everyone (emergency / vote / floor handoff) | `mute-room` |
| Remove from room but allow rejoin | `kick-audio` |
| Remove entirely, block rejoin | `kick-audio` + `invalidate-session` |
| Permanent ban from future contexts | Your domain logic — comms has no user-level ban |

---

## Express Moderation Routes (Example)

```js
const {
  muteUser, unmuteUser, muteRoomAll,
  kickAudio, invalidateSession, listParticipants,
} = require('../communications/commsClient');

router.get('/voice-rooms/:id/participants', requireAuth, async (req, res, next) => {
  try {
    const participants = await listParticipants(req.params.id, 'VOICE_ROOM');
    res.json(participants || []);
  } catch (err) {
    next(err);
  }
});

router.post('/voice-rooms/:id/mute/:userId', requireAuth, isHost, async (req, res, next) => {
  try {
    await muteUser(req.params.id, 'VOICE_ROOM', req.params.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/voice-rooms/:id/unmute/:userId', requireAuth, isHost, async (req, res, next) => {
  try {
    // Retry briefly — the user may still be connecting and not yet
    // visible to the media provider.
    let last;
    for (let i = 0; i < 5; i++) {
      last = await unmuteUser(req.params.id, 'VOICE_ROOM', req.params.userId);
      if (last) break;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
    if (!last) return res.status(503).json({ error: 'Could not unmute' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/voice-rooms/:id/kick/:userId', requireAuth, isHost, async (req, res, next) => {
  try {
    await kickAudio(req.params.id, 'VOICE_ROOM', req.params.userId);
    await invalidateSession(req.params.id, 'VOICE_ROOM', req.params.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

`isHost` is your own middleware that checks whether `req.user` is the
room's moderator.

---

## Audit Trail

Every moderation action writes to `communication_audit_logs`:

| Action | When |
|---|---|
| `MIC_MUTED` | `mute` succeeded |
| `MIC_UNMUTED` | `unmute` succeeded |
| `ROOM_MUTED` | `mute-room` succeeded |
| `PARTICIPANT_KICKED_AUDIO` | `kick-audio` succeeded |
| `SESSION_INVALIDATED` | `invalidate-session` succeeded |

Each row records `actorUserId` (whoever your backend said was the
actor) plus a JSON metadata blob with resolved participant IDs.
Use this for post-incident review and compliance.
