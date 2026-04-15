# SIP Softphone Access — Documentation

Free, self-hosted SIP softphone access to AudioBridge rooms. Users register
a free SIP softphone (Linphone, Zoiper, MicroSIP, Jitsi, Bria) with the
comms-service's embedded Kamailio registrar and dial a room URI to join
the corresponding AudioBridge room as a regular participant.

| Doc | Read this when you want to… |
|---|---|
| [01-architecture.md](01-architecture.md) | Understand the pieces (Kamailio + Janus SIP plugin) |
| [02-api-flow.md](02-api-flow.md) | See the session response shape and credential endpoint |
| [03-integration.md](03-integration.md) | Wire a consumer app to fetch SIP credentials |
| [04-softphone-setup.md](04-softphone-setup.md) | Share with end users to configure their softphone |
| [05-moderation.md](05-moderation.md) | Use existing mute/kick endpoints with SIP participants |
| [06-security.md](06-security.md) | Review DIGEST auth, credential rotation, NAT caveats |
| [07-troubleshooting.md](07-troubleshooting.md) | Diagnose a failing SIP session |
| [legal.md](legal.md) | Important: NO PSTN, NO emergency services |

## TL;DR

- **100% free and self-hosted.** No paid SIP trunks. No carrier. No
  per-minute charges. Kamailio runs as a 12 MB alpine container inside
  your Docker network.
- **Opt-in at every layer.** Set `SIP_ENABLED=true` in `.env` and add
  `sip` to `COMPOSE_PROFILES`. Consumers who don't need SIP don't run
  Kamailio, don't instantiate `SipService`, and see `sip: "disabled"`
  in `/health`.
- **Works alongside existing WebRTC.** SIP participants join the same
  AudioBridge room as browser clients. Server-enforced mute and kick
  work transparently via the existing moderation endpoints.
- **Not PSTN.** You cannot dial real phone numbers. Real phone numbers
  cannot dial in. This is intentional. For PSTN, see the roadmap note
  at the bottom of [legal.md](legal.md).

## What's in v1

- ✅ `CommunicationUser` schema carries `sipUsername`, `sipPassword`,
  `sipDisplayName`, and a `participantType` column
- ✅ `SipService` issues SIP credentials lazily (mirrors Matrix
  credential lifecycle)
- ✅ `authorizeUser` returns a `sip` field in the session response for
  `IN_PERSON` and `HYBRID` rooms
- ✅ Standalone `POST /internal/v1/users/sip-credentials` endpoint for
  pre-room "connect your softphone" settings screens
- ✅ Kamailio sidecar gated behind the `sip` Docker Compose profile
- ✅ Janus SIP plugin config file
- ✅ `/health` surfaces `sip: "registered" | "unregistered" | "disabled"`
- ✅ Display-name parser poisoning guard (`|` rejected in user input)
- ✅ Reserved usernames (`janus`, `kamailio`, `comms-bot`, etc.) blocked
- 🚧 Inbound SIP call bridging into AudioBridge (Janus SIP plugin handle
  management + async event correlation) — see the Roadmap section below

## What's NOT in v1 (deferred)

- **Janus SIP bridge wiring.** The `SipService` issues credentials, and
  the Kamailio + Janus SIP plugin configs are in place, but the NestJS
  code that accepts inbound `incomingcall` events from Janus and joins
  the call into AudioBridge as a plain-RTP participant is not yet
  implemented. This is a focused follow-up that needs dedicated Janus
  admin API work. See `docs/sip/01-architecture.md` for the exact
  sequence the follow-up needs to build.
- **PSTN connectivity.** Explicitly out of scope — see [legal.md](legal.md).
- **SIP federation.** Only one comms-service deployment, only its own
  users.
- **SIP over WebSocket for browsers.** Browser users join via the
  existing WebRTC AudioBridge flow.
- **Video over SIP.** Audio only via the AudioBridge mixer.

## Consumer Matrix — Does SIP Cost Me Anything?

| Your deployment | Runs Kamailio? | Loads SipService? | Disk cost | RAM cost |
|---|:-:|:-:|:-:|:-:|
| Chat only | ❌ | ❌ | 0 MB | 0 MB |
| Audio/Video only | ❌ | ❌ | 0 MB | 0 MB |
| Everything + SIP | ✅ | ✅ | ~12 MB | ~20 MB |

If you don't flip `SIP_ENABLED=true`, you literally get nothing extra.
The feature is invisible.

## Related Docs

- [../chat/](../chat/README.md) — Matrix chat capability
- [../audio/](../audio/README.md) — WebRTC audio (AudioBridge mixer)
- [../video/](../video/README.md) — WebRTC video (VideoRoom SFU)
- [../INTEGRATION_GUIDE.md](../INTEGRATION_GUIDE.md) — broader onboarding
