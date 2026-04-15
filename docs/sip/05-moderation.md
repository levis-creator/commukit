# 05 — Moderation for SIP Participants

**There is nothing SIP-specific about moderation.** A user who joined a
room via a SIP softphone is the same kind of AudioBridge participant as
a user who joined via a browser. The existing moderation endpoints work
transparently.

This page exists to document *why* that's true and to call out the one
convention that makes it work.

---

## The Display-Name Convention

When the Janus SIP bridge accepts a call and joins the AudioBridge
room, it sets the participant's display to:

```
<sipUsername>|<domainUserId>
```

Example: `comms_7f3c1b2e9a4d4b56|user-uuid-1234`

This is exactly the same structural format the existing browser clients
use (`DisplayName|domainUserId`), with `sipUsername` substituted for the
friendly name. The existing `resolveParticipantId` helper in
`RoomsService` splits on `|` and matches the **last** segment against
the `domainUserId` argument — so passing the user's normal domain id to
`mute` / `unmute` / `kick-audio` resolves the SIP participant correctly.

No new moderation endpoints are needed.

---

## Example: Mute a SIP-Joined User

Nothing changes compared to a browser participant:

```bash
POST /internal/v1/rooms/:contextId/mute
{
  "appId": "myapp",
  "contextType": "MEETING",
  "domainUserId": "user-uuid-1234"
}
```

The request:
1. `RoomsService.muteParticipant` validates the room + Janus availability
2. Calls `Janus.listParticipants` to get the AudioBridge roster
3. `resolveParticipantId` matches `parts[parts.length - 1] === 'user-uuid-1234'`
4. Finds the SIP participant whose display is
   `comms_7f3c1b2e9a4d4b56|user-uuid-1234`
5. Issues `AudioBridge mute` against the resolved participant id

**AudioBridge is a mixer**, so server-enforced mute actually silences
the user in the mix — not just "the client stops sending". This is the
same guarantee WebRTC participants get.

## Example: Kick a SIP-Joined User

Same shape, different endpoint:

```bash
POST /internal/v1/rooms/:contextId/kick-audio
{
  "appId": "myapp",
  "contextType": "MEETING",
  "domainUserId": "user-uuid-1234"
}
```

Kick removes the participant from AudioBridge. If you also want to
prevent them from reconnecting (either via SIP or WebRTC), pair the
kick with `invalidate-session`:

```bash
POST /internal/v1/rooms/:contextId/invalidate-session
{
  "appId": "myapp",
  "contextType": "MEETING",
  "domainUserId": "user-uuid-1234"
}
```

After `invalidate-session`:
- `authorize-user` for that `(room, user)` returns 403
- The softphone can still REGISTER with Kamailio (credentials are not
  revoked globally — only the room-specific membership is blocked)
- A re-dial of the room URI will be rejected by `SipBridgeService` with
  `SIP_CALL_REJECTED_SESSION_INVALIDATED`

## Mute-Room Effect

`POST /mute-room` silences every participant regardless of how they
joined. The host then selectively unmutes speakers (WebRTC or SIP) one
at a time. This is the standard "grant the floor" pattern from the
existing audio docs — [`../audio/05-moderation.md`](../audio/05-moderation.md)
— and works unchanged for SIP-joined users.

## Hardware Guard Still Applies

Display names containing `|HARDWARE` are reserved for physical room
equipment (in-room mic arrays, codec systems) and are protected by
`guardHardwareHandle` in `RoomsService`. The SIP bridge never generates
a `|HARDWARE` display (it uses `<sipUsername>|<domainUserId>`), and
consumer-supplied display names reject pipe characters via the DTO
regex, so there is no way for a SIP participant to impersonate a
hardware handle.

---

## Audit Trail

Moderation events use the existing audit keys. The `actorUserId` is
your consumer-supplied moderator, and the `metadata.participantId`
field records the resolved Janus participant id (which might belong to
a SIP participant — you can tell by cross-referencing the display
string in logs if needed):

| Action | When |
|---|---|
| `MIC_MUTED` | `POST /mute` against a SIP or WebRTC participant |
| `MIC_UNMUTED` | `POST /unmute` against a SIP or WebRTC participant |
| `ROOM_MUTED` | `POST /mute-room` |
| `PARTICIPANT_KICKED_AUDIO` | `POST /kick-audio` |
| `SESSION_INVALIDATED` | `POST /invalidate-session` |

SIP-specific lifecycle events sit in a separate key family:

| Action | When |
|---|---|
| `SIP_BRIDGE_REGISTERED` | Bridge completed REGISTER with Kamailio |
| `SIP_BRIDGE_REGISTRATION_FAILED` | Bridge REGISTER failed |
| `SIP_CALL_BRIDGED` | Inbound SIP call successfully joined AudioBridge |
| `SIP_CALL_REJECTED_*` | Inbound call rejected (bad user / wrong room / etc.) |
| `SIP_CALL_HUNG_UP` | Either side hung up |
| `SIP_CALL_TIMEOUT_REAPED` | Reaper killed an over-long call |

See [`02-api-flow.md`](02-api-flow.md) for the full event list.
