# Providers — Pluggable Media & Chat Backends

This service abstracts its audio/video and chat transports behind two
interfaces so alternative backends (LiveKit, Jitsi, Rocket.Chat, etc.) can
be dropped in without rewriting `RoomsService` or the consumer apps.

## Interfaces

Defined in [`src/providers/`](../src/providers/):

| Interface | File | Default impl | What it owns |
|---|---|---|---|
| `MediaProvider` | [`media-provider.interface.ts`](../src/providers/media-provider.interface.ts) | [`JanusService`](../src/janus/janus.service.ts) | Audio/video room lifecycle, mic control, kick, ICE config |
| `ChatProvider`  | [`chat-provider.interface.ts`](../src/providers/chat-provider.interface.ts)   | [`MatrixService`](../src/matrix/matrix.service.ts) | Chat room lifecycle, per-user token minting, invite/join, logout |

Nest DI tokens: `MEDIA_PROVIDER`, `CHAT_PROVIDER` (from `src/providers/tokens.ts`).
Consumers (`RoomsService`, `HealthController`) inject via the tokens
and never reference the concrete classes.

## Selecting a provider at runtime

Each provider is bound in its own module:

- [`src/janus/janus.module.ts`](../src/janus/janus.module.ts) binds `MEDIA_PROVIDER → JanusService`
- [`src/matrix/matrix.module.ts`](../src/matrix/matrix.module.ts) binds `CHAT_PROVIDER → MatrixService`

`AppModule` conditionally imports the provider modules based on the enable
flags in `.env`:

```bash
MATRIX_ENABLED=true       # loads MatrixModule (CHAT_PROVIDER)
JANUS_ENABLED=true        # loads JanusModule  (MEDIA_PROVIDER)
MEDIA_PROVIDER=janus      # reserved for Phase 4.5 when multiple impls exist
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

## Adding a new provider (LiveKit, Jitsi, etc.)

This is the end-to-end checklist for wiring a new backend. LiveKit is
referenced throughout as the canonical example.

1. **Implement the interface.** Create
   `src/<provider>/<provider>.service.ts` and make the class
   `implements MediaProvider` (or `ChatProvider`). The provider should:
   - Expose a stable `id` (e.g. `'livekit'`) for the discriminated-union.
   - Surface `isAvailable()` that reflects live reachability — this drives
     the `status` field in session responses.
   - Implement every method of the interface; `RoomsService` never checks
     for undefined methods.
2. **Create a Nest module** that binds the token:
   ```ts
   @Global()
   @Module({
     providers: [
       LivekitService,
       { provide: MEDIA_PROVIDER, useExisting: LivekitService },
     ],
     exports: [LivekitService, MEDIA_PROVIDER],
   })
   export class LivekitModule {}
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
   with your provider id. Populate it inside the provider's
   implementation of the `ensureAudioBridgeRoom` / `ensureVideoRoom`
   consumers (today this is inline in `RoomsService.authorizeUser`; a
   future refactor will move it onto the interface as a
   `buildAudioCredentials` method — see the plan file).
7. **Update the Flutter model** in
   [`vps_ke_app/lib/shared/communications/models/communications_session.dart`](../../vps_ke_app/lib/shared/communications/models/communications_session.dart)
   to parse the new provider branch from `credentials`. The file already
   uses sealed classes and a `switch(provider)` in `fromJson`, so adding
   a branch is a 10-line change.
8. **Add a Flutter transport adapter** (follow-up — see the plan). Today's
   `CommunicationsSessionManager` hard-codes Janus and Matrix; the refactor
   to `MediaTransport` / `ChatTransport` interfaces is deferred until the
   second provider actually ships, to avoid introducing an abstraction with
   only one implementation.

## SIP compatibility (`SipProvider` — a separate interface)

SIP federation is inherently coupled to the media backend's internal RTP
plumbing — the two stacks share nothing at the wire level. Rather than
shoehorning SIP into `MediaProvider`, it lives behind its own abstraction:

- [`src/providers/sip-provider.interface.ts`](../src/providers/sip-provider.interface.ts) — the `SipProvider` contract
- Today the only implementation is [`SipBridgeService`](../src/sip/sip-bridge.service.ts) (`id: 'janus'`), which bridges into a Janus AudioBridge room via the Janus SIP plugin and `rtpengine`.
- Each `SipProvider` declares `compatibleMediaProviders`: the list of `MediaProvider.id` values it can route calls into. The Janus impl declares `['janus']`.

### The runtime guard

When `SIP_ENABLED=true` is combined with a `MEDIA_PROVIDER` that is **not**
in the SIP provider's compatibility list, the bridge refuses to start:

1. `SipBridgeService.onModuleInit` sees `media.id !== 'janus'`.
2. It logs an ERROR naming the incompatible combination and pointing to this doc.
3. It sets a permanent `incompatibleMedia` flag — no REGISTER, no long-poll, no credentials ever issued.
4. `/health` reports `sip: "incompatible-media"`.
5. `/authorize-user` reports `sip: { status: "unavailable", reason: "SIP incompatible with active media provider: …" }`.

This prevents the dangerous silent-brokenness scenario where softphones
would REGISTER with Kamailio, dial into a Janus AudioBridge room, and
then find that no WebRTC client ever joined (because everyone is on
LiveKit rooms instead).

Operators fix it by either:
- Setting `MEDIA_PROVIDER=janus` (falls back to the shipped Janus impl), or
- Setting `SIP_ENABLED=false` (SIP capability reports `disabled`).

### LiveKit SIP support — the adapter path

LiveKit ships its own SIP Ingress (`livekit-sip`) which terminates SIP
calls and creates LiveKit participants. A `LivekitSipProvider` would:

1. Live in `src/sip/livekit-sip-bridge.service.ts`.
2. `implements SipProvider` with `id: 'livekit'`, `compatibleMediaProviders: ['livekit']`.
3. Own configuration for the `livekit-sip` sidecar (SIP registrar URI, trunks, dispatch rules) instead of Janus plugin state.
4. Register under the `SIP_PROVIDER` DI token in its own module.
5. Selected at boot time by `AppModule` based on `MEDIA_PROVIDER` — exactly one SIP provider is bound per deployment.

The [`SipService`](../src/sip/sip.service.ts) credential issuer (username
+ password minting, audit logging) is vendor-neutral and stays shared
across both implementations. Only the *bridge* — the thing that actually
forwards media — is provider-specific.

### Today's support matrix

| `MEDIA_PROVIDER` | `SIP_ENABLED` | Result |
|---|---|---|
| `janus` | `false` | WebRTC via Janus, no SIP. ✅ |
| `janus` | `true` | WebRTC via Janus + SIP softphones via Kamailio → Janus. ✅ |
| `livekit` | `false` | WebRTC via LiveKit, no SIP. ✅ (once the LiveKit `MediaProvider` adapter ships) |
| `livekit` | `true` | ❌ **Refused at boot.** Bridge reports `incompatible-media`. Wait for `LivekitSipProvider`. |
