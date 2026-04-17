# LiveKit Media Provider

## Overview

LiveKit is a modern, open-source WebRTC platform that serves as the default media provider for the communications service since v1.1. It provides:

- **Token-based authentication** -- participants receive short-lived JWTs scoped to a specific room with granular permissions.
- **Built-in SFU + mixer** -- a single server handles both selective forwarding (video) and audio mixing, replacing the need for separate AudioBridge and VideoRoom plugins.
- **Adaptive bitrate** -- automatic quality adjustment based on network conditions.
- **Built-in TURN** -- NAT traversal works out of the box without a separate coturn deployment.

The implementation lives in `src/livekit/livekit.service.ts` and implements the `MediaProvider` interface (`src/providers/media-provider.interface.ts`). It is bound to the `MEDIA_PROVIDER` DI token via `LivekitModule`.

## Prerequisites

- **LiveKit server** -- self-hosted via Docker or [LiveKit Cloud](https://cloud.livekit.io). For self-hosted deployments, the minimum supported version is LiveKit 1.5+.
- **Node.js 20+** -- required by the communications service.
- **Communications service** -- this microservice, running on port 3014.

For local development with Docker:

```bash
docker run -d --name livekit \
  -p 7880:7880 \
  -p 7881:7881 \
  -p 7882:7882/udp \
  livekit/livekit-server \
  --dev
```

## Environment Setup

Add these variables to the communications service `.env` file:

| Variable | Required | Default | Description |
|---|---|---|---|
| `MEDIA_PROVIDER` | No | `livekit` | Media backend selector. Can be omitted since LiveKit is the default. Set to `janus` to use the legacy Janus backend. |
| `LIVEKIT_URL` | Yes | `ws://localhost:7880` | LiveKit server WebSocket URL (internal, used for Twirp RPC calls). |
| `LIVEKIT_PUBLIC_URL` | No | Falls back to `LIVEKIT_URL` | Public-facing WebSocket URL returned to clients. Set this when the internal and external URLs differ (e.g. behind a reverse proxy). |
| `LIVEKIT_API_KEY` | Yes | -- | API key for authentication. Generated when deploying LiveKit or available in the LiveKit Cloud dashboard. |
| `LIVEKIT_API_SECRET` | Yes | -- | API secret used for signing JWTs. Must match the key pair configured on the LiveKit server. |
| `LIVEKIT_EMPTY_TIMEOUT` | No | `300` | Seconds before an empty room is automatically closed by LiveKit. |
| `LIVEKIT_MAX_PARTICIPANTS` | No | `200` | Maximum number of participants per room. |
| `LIVEKIT_ICE_SERVERS` | No | `stun:stun.l.google.com:19302` | Comma-separated STUN/TURN URLs for additional ICE servers. LiveKit has built-in TURN, so this is only needed for supplementary servers. |
| `LIVEKIT_TURN_USERNAME` | No | -- | Username for external TURN servers listed in `LIVEKIT_ICE_SERVERS`. |
| `LIVEKIT_TURN_CREDENTIAL` | No | -- | Credential for external TURN servers listed in `LIVEKIT_ICE_SERVERS`. |

### Docker Compose

To start the stack with LiveKit enabled:

```bash
COMPOSE_PROFILES=chat,livekit docker compose up -d
```

### Minimal `.env` example

```bash
MEDIA_PROVIDER=livekit
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret
```

## How It Works

LiveKit uses token-based authentication rather than the signaling-based approach used by Janus. The flow is:

1. **Room provision** -- `RoomsService` calls `ensureAudioBridgeRoom` / `ensureVideoRoom` on the `MediaProvider`. The LiveKit implementation sends a `CreateRoom` RPC to the LiveKit server via its Twirp API (HTTP-based gRPC alternative). The call is idempotent; if the room already exists, the existing room is returned.

2. **User authorization** -- when a client requests a session via `/internal/v1/rooms/:contextId/authorize-user`, the service calls `createParticipantToken`. This mints an HS256 JWT signed with `LIVEKIT_API_SECRET` containing:
   - Room name and join permissions
   - Participant identity and display name
   - Application metadata (appId, roles)
   - 15-minute expiry window

3. **Client connection** -- the session response includes the LiveKit URL and the participant token. The client connects directly to LiveKit using these credentials. No further interaction with the communications service is needed for the media transport.

4. **Server-side control** -- mic muting, participant removal, and room destruction are performed via Twirp RPC calls from the communications service to the LiveKit server, authenticated with a short-lived server token that has admin privileges.

### Twirp RPC endpoint

All server-side API calls go through:

```
POST {LIVEKIT_URL}/twirp/livekit.RoomService/{Method}
```

Methods used: `CreateRoom`, `DeleteRoom`, `ListRooms`, `ListParticipants`, `MutePublishedTrack`, `RemoveParticipant`.

### Health check

The service polls LiveKit every 30 seconds by calling `ListRooms`. If the call fails, `isAvailable()` returns `false` and the session response reports `status: "unavailable"` for media capabilities. The `/health` endpoint reflects this as `media: "unreachable"`.

## Room Mapping

The communications service stores room IDs as integers in the database (`CommunicationRoom.audioRoomId` / `videoRoomId`). LiveKit uses string room names. The mapping works as follows:

1. The `contextId` (e.g. `parliament:sitting:abc123`) is hashed using the DJB2 algorithm to produce a 31-bit unsigned integer.
2. The integer is mapped to a LiveKit room name: `comms-{roomId}`.
3. If a `knownRoomId` is stored in the database (from a previous provision), it is reused instead of re-hashing.
4. Room IDs are cached in Redis under the key `comms:livekit:room:{contextId}`.

```
contextId: "parliament:sitting:abc123"
    -> DJB2 hash -> 1847293456
    -> LiveKit room name: "comms-1847293456"
```

In LiveKit, both audio and video share the same room (unlike Janus which uses separate AudioBridge and VideoRoom instances). The `ensureAudioBridgeRoom` and `ensureVideoRoom` methods converge on the same underlying `ensureRoom` call, so a single LiveKit room serves both capabilities.

## Participant Identity

Identity and metadata are embedded directly in the participant JWT claims. There is no display name convention or separate registration step required (unlike Janus, which requires a `display` field in the join request).

The token payload structure:

```json
{
  "iss": "your-api-key",
  "sub": "domain-user-id",
  "name": "Jane Doe",
  "metadata": "{\"appId\":\"parliament\",\"roles\":[\"member\"]}",
  "video": {
    "room": "comms-1847293456",
    "roomJoin": true,
    "roomAdmin": false,
    "canPublish": true,
    "canSubscribe": true,
    "canPublishData": true
  },
  "exp": 1713400000,
  "nbf": 1713399090
}
```

The `sub` claim is the participant identity (typically the domain user ID). The `name` claim is the display name visible to other participants. The `metadata` field is a JSON-encoded string containing application-specific data.

## ICE/TURN

LiveKit includes a built-in TURN server, so most deployments do not require an external coturn instance.

For environments that need additional STUN/TURN servers (e.g. restrictive enterprise firewalls):

```bash
LIVEKIT_ICE_SERVERS=stun:stun.l.google.com:19302,turn:turn.example.com:3478
LIVEKIT_TURN_USERNAME=turnuser
LIVEKIT_TURN_CREDENTIAL=turnsecret
```

The `buildIceServers()` method parses this into an array returned in the session response:

```json
{
  "iceServers": [
    { "urls": ["stun:stun.l.google.com:19302"] },
    { "urls": ["turn:turn.example.com:3478"], "username": "turnuser", "credential": "turnsecret" }
  ]
}
```

TURN credentials are only included if both `LIVEKIT_TURN_USERNAME` and `LIVEKIT_TURN_CREDENTIAL` are set.

## SIP with LiveKit

LiveKit supports SIP via its `livekit-sip` sidecar. The communications service includes a `LivekitSipProvider` (`src/sip/livekit-sip.provider.ts`) that implements the `SipProvider` interface.

### What works

- Infrastructure provisioning: inbound SIP trunk and dispatch rules are created automatically via `SipService.ensureLivekitInfrastructure()` on startup.
- Bridge status reporting: `/health` and `/authorize-user` correctly report SIP availability.
- Compatibility guard: the provider declares `compatibleMediaProviders: ['livekit']` and refuses to start if `MEDIA_PROVIDER` is not `livekit`.

### Known limitation

`hangupSipCall()` is a no-op stub. LiveKit models SIP callers as regular room participants, so hanging up a specific SIP call requires a `callId -> participantId` mapping that is not yet persisted. This will be addressed in a future release.

### Configuration

```bash
SIP_ENABLED=true
MEDIA_PROVIDER=livekit
```

See `docs/sip/` for full SIP configuration details.

## Client SDK Integration

### Flutter

Add the `livekit_client` package to `pubspec.yaml`:

```yaml
dependencies:
  livekit_client: ^2.3.0
```

Connect using the credentials from the session response:

```dart
import 'package:livekit_client/livekit_client.dart';

Future<void> connectToRoom(String url, String token) async {
  final room = Room();

  room.onParticipantConnected = (participant) {
    debugPrint('Participant joined: ${participant.identity}');
  };

  await room.connect(url, token, roomOptions: const RoomOptions(
    adaptiveStream: true,
    dynacast: true,
    defaultAudioPublishOptions: AudioPublishOptions(
      dtx: true,
    ),
  ));

  // Publish microphone
  await room.localParticipant?.setMicrophoneEnabled(true);
}
```

The `url` and `token` come from the session response:

```dart
final session = await communicationsClient.authorizeUser(contextId, userId);

// Using v2 credentials shape
final livekitUrl = session.audioBridge.credentials.wsUrl;
final livekitToken = session.audioBridge.credentials.token;
await connectToRoom(livekitUrl, livekitToken);
```

### Web (JavaScript/TypeScript)

Install the `livekit-client` npm package:

```bash
npm install livekit-client
```

Connect using the session credentials:

```typescript
import { Room, RoomEvent } from 'livekit-client';

async function connectToRoom(url: string, token: string): Promise<Room> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
  });

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    console.log('Participant joined:', participant.identity);
  });

  await room.connect(url, token);

  // Publish microphone
  await room.localParticipant.setMicrophoneEnabled(true);

  return room;
}
```

## Troubleshooting

### "Token expired"

Participant tokens have a 15-minute expiry. If a client holds a token without connecting, it will expire. Request a new session via `/authorize-user` to get a fresh token.

### "Room not found"

Verify that `LIVEKIT_URL` points to the running LiveKit server. The room is created via the Twirp API at that URL during provisioning. If the URL is wrong, rooms are created on a different server (or not at all) than the one clients connect to.

### "Connection failed"

- Verify the LiveKit server is running and accessible from the client network.
- If clients are behind NAT, confirm that LiveKit's built-in TURN is working or that external TURN servers are configured via `LIVEKIT_ICE_SERVERS`.
- Check firewall rules: LiveKit requires ports 7880 (WebSocket), 7881 (WebRTC TCP), and 7882/UDP (WebRTC UDP) to be open.

### Health endpoint shows `media: "unreachable"`

The LiveKit server is not responding to the Twirp API health poll (`ListRooms` call every 30 seconds). Check:

- `LIVEKIT_URL` is correct and reachable from the communications service container.
- `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are set and match the LiveKit server configuration.
- The LiveKit container is running: `docker ps | grep livekit`.

### Media capability reports `status: "unavailable"` but LiveKit is running

If `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET` are empty, the service skips the health check entirely and remains in the unavailable state. Verify both values are set in the environment.
