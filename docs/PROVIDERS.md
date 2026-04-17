# Providers — Pluggable Media & Chat Backends

This service abstracts its audio/video and chat transports behind two
interfaces so alternative backends can be dropped in without rewriting
`RoomsService` or the consumer apps.

## Interfaces

Defined in [`src/providers/`](../src/providers/):

| Interface | File | Default impl | Alternative | What it owns |
|---|---|---|---|---|
| `MediaProvider` | [`media-provider.interface.ts`](../src/providers/media-provider.interface.ts) | [`LivekitService`](../src/livekit/livekit.service.ts) | [`JanusService`](../src/janus/janus.service.ts) | Audio/video room lifecycle, mic control, kick, ICE config |
| `ChatProvider`  | [`chat-provider.interface.ts`](../src/providers/chat-provider.interface.ts)   | [`MatrixService`](../src/matrix/matrix.service.ts) | — | Chat room lifecycle, per-user token minting, invite/join, logout |

Nest DI tokens: `MEDIA_PROVIDER`, `CHAT_PROVIDER` (from `src/providers/tokens.ts`).
Consumers (`RoomsService`, `HealthController`) inject via the tokens
and never reference the concrete classes.

## Shipped providers

### LiveKit (default)

Modern, token-based WebRTC platform with built-in SFU, audio mixer, and TURN.

- **Provider id:** `livekit`
- **Module:** [`src/livekit/livekit.module.ts`](../src/livekit/livekit.module.ts)
- **Service:** [`src/livekit/livekit.service.ts`](../src/livekit/livekit.service.ts) (422 lines)
- **Auth model:** JWT participant tokens (HS256, 15-min expiry) — minted by the comms service, consumed by the client
- **Room naming:** `comms-{hash}` string rooms derived from contextId
- **Full guide:** [`docs/providers/LIVEKIT.md`](./providers/LIVEKIT.md)

Key env vars: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

### Janus Gateway (opt-in fallback)

Proven WebRTC server with AudioBridge (server-side mixer) and VideoRoom (SFU) plugins.

- **Provider id:** `janus`
- **Module:** [`src/janus/janus.module.ts`](../src/janus/janus.module.ts) (deprecated — still fully functional)
- **Service:** [`src/janus/janus.service.ts`](../src/janus/janus.service.ts)
- **Auth model:** No client tokens — clients connect to Janus WebSocket directly
- **Room naming:** Integer room IDs derived from contextId via DJB2 hash
- **Full guide:** [`docs/providers/JANUS.md`](./providers/JANUS.md)

Key env vars: `MEDIA_PROVIDER=janus`, `JANUS_ENABLED=true`, `JANUS_HTTP_URL`, `JANUS_WS_URL`.

## Selecting a provider at runtime

Each provider is bound in its own module:

- [`src/livekit/livekit.module.ts`](../src/livekit/livekit.module.ts) binds `MEDIA_PROVIDER → LivekitService`
- [`src/janus/janus.module.ts`](../src/janus/janus.module.ts) binds `MEDIA_PROVIDER → JanusService`
- [`src/matrix/matrix.module.ts`](../src/matrix/matrix.module.ts) binds `CHAT_PROVIDER → MatrixService`

`AppModule` conditionally imports the provider modules based on env vars:

```bash
MATRIX_ENABLED=true       # loads MatrixModule (CHAT_PROVIDER)
MEDIA_PROVIDER=livekit    # default — loads LivekitModule (MEDIA_PROVIDER)
MEDIA_PROVIDER=janus      # opt-in — loads JanusModule (requires JANUS_ENABLED=true)
CHAT_PROVIDER=matrix      # reserved (Matrix is the only chat impl today)
```

When a provider module is not imported, consumers see `undefined` through
`@Optional()` injection and the session response reports
`status: 'unavailable'` with a human-readable reason.

## Session response shape

`POST /internal/v1/rooms/:contextId/authorize-user` returns a unified
session object with three capabilities (`chat`, `audioBridge`, `videoRoom`)
and an optional `sip` block. Each capability uses a provider-discriminated
`credentials` union:

### With LiveKit (default)

```jsonc
{
  "chat": {
    "status": "available",
    "credentials": {
      "provider": "matrix",
      "roomId": "!abc:comms.local",
      "accessToken": "...",
      "serverUrl": "https://matrix.example.org",
      "serverName": "comms.local"
    }
  },
  "audioBridge": {
    "status": "available",
    "credentials": {
      "provider": "livekit",
      "room": "comms-1234567890",
      "url": "wss://livekit.example.org",
      "token": "eyJ..."
    }
  },
  "videoRoom": {
    "status": "available",
    "credentials": {
      "provider": "livekit",
      "room": "comms-1234567890",
      "url": "wss://livekit.example.org",
      "token": "eyJ...",
      "iceServers": [{ "urls": ["stun:stun.l.google.com:19302"] }]
    }
  }
}
```

### With Janus

```jsonc
{
  "chat": {
    "status": "available",
    "credentials": {
      "provider": "matrix",
      "roomId": "!abc:comms.local",
      "accessToken": "...",
      "serverUrl": "https://matrix.example.org",
      "serverName": "comms.local"
    }
  },
  "audioBridge": {
    "status": "available",
    "credentials": {
      "provider": "janus",
      "roomId": 1234567890,
      "wsUrl": "wss://janus.example.org"
    }
  },
  "videoRoom": {
    "status": "available",
    "credentials": {
      "provider": "janus",
      "roomId": 1234567890,
      "wsUrl": "wss://janus.example.org",
      "iceServers": [{ "urls": ["stun:stun.l.google.com:19302"] }]
    }
  }
}
```

Clients should **switch on `credentials.provider`** to select the correct transport.

### API versioning (dual-write compatibility)

During the migration window, `/authorize-user` populates both the new
`credentials` field and the legacy flat fields (`roomId`, `wsUrl`,
`accessToken`, `serverUrl`, `serverName`, `iceServers`). v1 clients keep
reading the flat fields and ignore `credentials`; v2 clients opt in via a
request header:

```http
POST /internal/v1/rooms/<contextId>/authorize-user
X-Comms-API-Version: 2
```

When the header is set to `2` or higher, the legacy flat fields are
stripped from the response and only `credentials` remains.

Phase 5 of the rollout removes the legacy fields entirely once all consumers
have migrated. See [`src/rooms/rooms.service.ts`](../src/rooms/rooms.service.ts)
(`stripLegacySessionFields`) for the strip helper.

## Adding a new provider (Jitsi, etc.)

This is the end-to-end checklist for wiring a new backend. LiveKit is
the canonical example of a completed implementation.

1. **Implement the interface.** Create
   `src/<provider>/<provider>.service.ts` and make the class
   `implements MediaProvider` (or `ChatProvider`). The provider should:
   - Expose a stable `id` (e.g. `'jitsi'`) for the discriminated-union.
   - Surface `isAvailable()` that reflects live reachability — this drives
     the `status` field in session responses.
   - Implement every required method of the interface.
   - Optionally implement `createParticipantToken()` and `roomNameFor()` if
     the provider uses token-based auth or string room names.
2. **Create a Nest module** that binds the token:
   ```ts
   @Global()
   @Module({
     providers: [
       JitsiService,
       { provide: MEDIA_PROVIDER, useExisting: JitsiService },
     ],
     exports: [JitsiService, MEDIA_PROVIDER],
   })
   export class JitsiModule {}
   ```
3. **Register under an env switch** in
   [`src/app.module.ts`](../src/app.module.ts). The recommended pattern is
   a per-provider enable flag PLUS a `MEDIA_PROVIDER=<id>` selector so
   operators can run a container without activating its provider.
4. **Add a Compose profile** in
   [`docker-compose.yml`](../docker-compose.yml) mirroring the existing
   `media` / `chat` / `sip` / `livekit` profiles. The container must be
   dormant by default (`profiles: ["<id>"]`) and declared as a
   `required: false` dependency of `communications-service` so comms-service
   boots independently of which profile is active.
5. **Reserve the config directory** at `infra/<provider>/` with any
   required config files. See
   [`infra/livekit/livekit.yaml`](../infra/livekit/livekit.yaml) for shape.
6. **Extend the credentials union**. For media providers, add a new branch
   to `AudioCredentials` / `VideoCredentials` in
   [`src/rooms/rooms.service.ts`](../src/rooms/rooms.service.ts) tagged
   with your provider id.
7. **Update the Flutter model** in
   [`vps_ke_app/lib/shared/communications/models/communications_session.dart`](../../vps_ke_app/lib/shared/communications/models/communications_session.dart)
   to parse the new provider branch from `credentials`. The file already
   uses sealed classes and a `switch(provider)` in `fromJson`, so adding
   a branch is a 10-line change.
8. **Add a Flutter transport adapter** that implements `AudioBridgeService`
   or `VideoRoomService` using your provider's client SDK.

## SIP compatibility (`SipProvider` — a separate interface)

SIP federation is inherently coupled to the media backend's internal RTP
plumbing — the two stacks share nothing at the wire level. Rather than
shoehorning SIP into `MediaProvider`, it lives behind its own abstraction:

- [`src/providers/sip-provider.interface.ts`](../src/providers/sip-provider.interface.ts) — the `SipProvider` contract
- Janus path: [`SipBridgeService`](../src/sip/sip-bridge.service.ts) (`id: 'janus'`) bridges into AudioBridge via the Janus SIP plugin + rtpengine.
- LiveKit path: [`LivekitSipProvider`](../src/sip/livekit-sip.provider.ts) (`id: 'livekit'`) provisions SIP trunks and dispatch rules via LiveKit's SIP Ingress.
- Each `SipProvider` declares `compatibleMediaProviders`: the list of `MediaProvider.id` values it can route calls into.

### The runtime guard

When `SIP_ENABLED=true` is combined with a `MEDIA_PROVIDER` that is **not**
in the SIP provider's compatibility list, the bridge refuses to start:

1. The SIP provider sees an incompatible `media.id`.
2. It logs an ERROR naming the incompatible combination and pointing to this doc.
3. It sets a permanent `incompatibleMedia` flag — no REGISTER, no credentials ever issued.
4. `/health` reports `sip: "incompatible-media"`.
5. `/authorize-user` reports `sip: { status: "unavailable", reason: "SIP incompatible with active media provider: ..." }`.

Operators fix it by either:
- Setting `MEDIA_PROVIDER` to a compatible value, or
- Setting `SIP_ENABLED=false` (SIP capability reports `disabled`).

### Support matrix

| `MEDIA_PROVIDER` | `SIP_ENABLED` | Result |
|---|---|---|
| `livekit` | `false` | WebRTC via LiveKit, no SIP. Default configuration. |
| `livekit` | `true` | LiveKit + SIP infrastructure provisioned (hangup is a stub). |
| `janus` | `false` | WebRTC via Janus, no SIP. |
| `janus` | `true` | WebRTC via Janus + SIP softphones via Kamailio -> Janus. Fully functional. |
