# Minimal consumer

The smallest possible end-to-end exercise of commukit's internal API:

1. Mints an internal JWT (`aud: communications-service`, signed with the shared `INTERNAL_SERVICE_SECRET`).
2. `POST /internal/v1/rooms/provision` — creates a new room keyed by `(appId, contextType, contextId)`.
3. `POST /internal/v1/rooms/:contextId/authorize-user` — requests session credentials for a demo user.
4. Prints the unified session response (chat + audio + video capabilities with per-provider `credentials`).

Run it against a local `docker compose up` stack of commukit. Roughly 80 lines of JavaScript.

## Prerequisites

- Node 20 LTS or newer.
- A running commukit service reachable at `COMMS_URL` (default `http://localhost:3014`).
- `INTERNAL_SERVICE_SECRET` set to the same value the service is using.

The quickest way to get the service up is:

```bash
cd ../..                          # back to the commukit repo root
cp .env.example .env               # edit INTERNAL_SERVICE_SECRET as needed
docker compose up -d
docker compose exec communications-service npx prisma migrate deploy
curl http://localhost:3014/health  # sanity check
```

## Run the example

From this directory:

```bash
npm install
INTERNAL_SERVICE_SECRET=change-me-shared-secret-in-production npm start
```

You should see something like:

```
Provisioning room demo-1713360000000…
  room: PROVISIONED
Authorizing demo user…

Session response:
{
  "contextId": "demo-1713360000000",
  "chat": {
    "status": "available",
    "credentials": {
      "provider": "matrix",
      "roomId": "!abc:example.org",
      "accessToken": "syt_…",
      "serverUrl": "https://matrix.example.org",
      "serverName": "example.org"
    }
  },
  "audioBridge": {
    "status": "available",
    "credentials": {
      "provider": "janus",
      "roomId": 1234,
      "wsUrl": "wss://janus.example.org/ws"
    }
  },
  "videoRoom": {
    "status": "available",
    "credentials": {
      "provider": "janus",
      "roomId": 5678,
      "wsUrl": "wss://janus.example.org/ws",
      "iceServers": [ … ]
    }
  }
}
```

Capabilities that are unavailable in your dev stack (e.g. no LiveKit / Janus running) show `status: "unavailable"` with a reason — graceful degradation is normal.

## Environment variables

| Variable                  | Default                 | Purpose                                                                                   |
| ------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `COMMS_URL`               | `http://localhost:3014` | Base URL of the commukit service                                                          |
| `INTERNAL_SERVICE_SECRET` | _(required)_            | Shared secret for minting the internal JWT                                                |
| `COMMS_API_VERSION`       | `2`                     | Sent as `X-Comms-API-Version` header on `authorize-user`; `2` = credentials-only response |

## What this example does NOT do

- Does **not** close the room (`POST /:contextId/close`) or activate it. A real consumer would manage the full lifecycle.
- Does **not** handle domain authorization — commukit trusts any caller with a valid internal JWT; your app must decide _which_ users are allowed to join _which_ contexts.
- Does **not** connect to the returned chat/audio/video backends. In a real client you'd hand the `credentials` blob to a Matrix / Janus / LiveKit SDK and let the client connect directly to the transport backend.
- Does **not** listen for RabbitMQ lifecycle events (`communications.room.provisioned`, `.activated`, `.closed`) — those are for observability, not for the basic client flow.

## License

Example code is Apache-2.0 (same as the rest of the repo). See [`../../LICENSE`](../../LICENSE).

---

_Powered by [commukit](https://github.com/levis-creator/commukit)._
