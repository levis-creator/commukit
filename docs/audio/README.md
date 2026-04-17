# Audio Conferencing Documentation

Developer documentation for the audio capability of the
communications-service. Covers group voice rooms, 1-on-1 voice calls,
and audio moderation. Start here, then jump to the topic you need.

| Doc                                            | Read this when you want to…                            |
| ---------------------------------------------- | ------------------------------------------------------ |
| [01-architecture.md](01-architecture.md)       | Understand Janus AudioBridge, mixer model, room modes  |
| [02-api-flow.md](02-api-flow.md)               | See the end-to-end request flow and session shape      |
| [03-integration.md](03-integration.md)         | Wire a consumer app to group audio (step-by-step)      |
| [04-voice-calls.md](04-voice-calls.md)         | Implement 1:1 and small-group voice calls              |
| [05-moderation.md](05-moderation.md)           | Mute, unmute, kick, mute-all, display-name conventions |
| [06-security.md](06-security.md)               | TURN credentials, recording, access control            |
| [07-troubleshooting.md](07-troubleshooting.md) | Diagnose a failing audio session                       |

## TL;DR

- Audio is backed by **Janus Gateway AudioBridge** (a server-side mixer);
  only comms-service talks to Janus.
- Consumer backends call comms over internal JWT; clients get an
  AudioBridge room id + WebSocket URL and connect to Janus directly.
- Rooms are keyed by `(appId, contextType, contextId)` and move through
  `PROVISIONED → ACTIVE → CLOSED`. Mode is immutable.
- Room **mode** decides whether AudioBridge gets provisioned:
  - `IN_PERSON` → AudioBridge only (no video)
  - `HYBRID` → AudioBridge + VideoRoom
  - `REMOTE` → VideoRoom only (audio travels inside video — **no AudioBridge**)
- Pick `IN_PERSON` for pure voice rooms (conference calls, audio-only
  meetings, voice rooms). Pick `HYBRID` when you need both audio and
  video separated (e.g. broadcast audio + optional video feeds).
- **Voice calls (1:1 or group)** are just an `IN_PERSON` room with the
  right number of users authorized — see [04-voice-calls.md](04-voice-calls.md).
- Capacity guidance:
  - **Dozens of interactive participants** are a good fit for either provider.
  - **Hundreds of listeners** are realistic when only a few speakers are live.
  - **Thousands of listeners** are out of scope without a separate broadcast stack.
- PSTN is **not** part of the audio feature. "Phone-style UX" here means an
  app-managed voice-call experience, not dialing into the public telephone
  network.

## Mixer vs SFU — Why AudioBridge Is Different From VideoRoom

Janus VideoRoom (the video capability) is an **SFU**: every publisher
sends their stream once, the server forwards copies to every
subscriber. Each client has N peer connections for N other
participants.

Janus AudioBridge is a **mixer**: every participant sends audio to the
server, the server mixes everyone into one combined stream, and sends
that single mixed stream back to each participant. Every client has
exactly **one** peer connection, regardless of room size.

| Property                              | AudioBridge (mixer)                 | VideoRoom (SFU)                |
| ------------------------------------- | ----------------------------------- | ------------------------------ |
| Peer connections per client           | 1                                   | 1 + N subscribers              |
| CPU cost on server                    | Higher (mixing)                     | Lower (forwarding)             |
| Bandwidth to client                   | Constant (one mixed stream)         | Scales with N                  |
| Good for                              | Voice, telephony, large audio rooms | Video, per-participant layouts |
| Can I mute a single voice in the mix? | Yes — server-side                   | No — SFU forwards unchanged    |

This is why server-enforced mute works for AudioBridge (the server
controls the mix) but not VideoRoom (the server just forwards packets).

## Related Docs

- [../chat/](../chat/README.md) — chat capability (Matrix Synapse)
- [../video/](../video/README.md) — video capability (Janus VideoRoom)
- [../INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) — broader onboarding covering chat + audio + video together
