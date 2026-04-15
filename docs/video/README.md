# Video Conferencing Documentation

Developer documentation for the video capability of the
communications-service. Covers group video rooms, 1-on-1 calls, and
moderation. Start here, then jump to the topic you need.

| Doc | Read this when you want to… |
|---|---|
| [01-architecture.md](01-architecture.md) | Understand Janus VideoRoom, SFU model, room modes, ICE |
| [02-api-flow.md](02-api-flow.md) | See the end-to-end request flow and session shape |
| [03-integration.md](03-integration.md) | Wire a consumer app to group video (step-by-step) |
| [04-one-on-one-calls.md](04-one-on-one-calls.md) | Implement 1:1 calls on top of the room primitive |
| [05-moderation.md](05-moderation.md) | Mute, kick, display-name conventions, emergency controls |
| [06-security.md](06-security.md) | ICE credentials, TURN, token scoping, privacy |
| [07-troubleshooting.md](07-troubleshooting.md) | Diagnose a failing video session |

## TL;DR

- Video is backed by **Janus Gateway VideoRoom** (SFU); only comms-service
  talks to Janus.
- Consumer backends call comms over internal JWT; clients get a VideoRoom
  ID + WebSocket URL + ICE servers and connect to Janus directly.
- Rooms are keyed by `(appId, contextType, contextId)` and move through
  `PROVISIONED → ACTIVE → CLOSED`. Mode is immutable.
- Room **mode** decides which transports get provisioned:
  - `IN_PERSON` → audio only (AudioBridge)
  - `HYBRID` → audio + video (AudioBridge + VideoRoom)
  - `REMOTE` → video only (VideoRoom)
- **1-on-1 calls** are just a `REMOTE` room with exactly two authorized
  users. There is no special call-setup protocol — see
  [04-one-on-one-calls.md](04-one-on-one-calls.md).

## Related Docs

- [../chat/](../chat/README.md) — chat capability (Matrix Synapse)
- [../INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) — broader onboarding covering chat + audio + video together
