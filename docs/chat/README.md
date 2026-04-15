# Chat Documentation

Developer documentation for the chat capability of the communications-service.
Start here, then jump to the topic you need.

| Doc | Read this when you want to… |
|---|---|
| [01-architecture.md](01-architecture.md) | Understand the stack, data model, and room lifecycle |
| [02-api-flow.md](02-api-flow.md) | See the end-to-end request flow and payload shapes |
| [03-integration.md](03-integration.md) | Wire a new consumer app to chat (step-by-step) |
| [04-persistence.md](04-persistence.md) | Store chat messages in your own database |
| [05-security.md](05-security.md) | Review tokens, secrets, and room-visibility guarantees |
| [06-troubleshooting.md](06-troubleshooting.md) | Diagnose a failing chat session |
| [07-media-uploads.md](07-media-uploads.md) | Send images, files, and video through chat via object storage (S3/MinIO/Azure) |

## TL;DR

- Chat is backed by **Matrix Synapse**; only comms-service talks to Synapse.
- Consumer backends call comms over internal JWT; clients get a scoped Matrix
  token and talk to Synapse directly.
- Rooms are keyed by `(appId, contextType, contextId)` and move through
  `PROVISIONED → ACTIVE → CLOSED`. Mode is immutable.
- Comms stores identity + membership + audit. **Messages live in Synapse** —
  if you need a local copy, see [04-persistence.md](04-persistence.md).

## Related Docs

- [../INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) — broader onboarding covering chat + audio + video together
