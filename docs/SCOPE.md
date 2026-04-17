# Scope

This document defines, explicitly and citeably, what commukit does and does not do. Maintainers use this to accept or close issues and PRs without the outcome feeling arbitrary. Contributors use it to avoid investing effort in directions that will not be accepted.

Sections are stable. If you want to change scope, do not open a PR — see [How to propose a scope change](#how-to-propose-a-scope-change) below.

---

## In scope

Commukit **is** a reusable, multi-tenant middleware that provisions embedded communications rooms and issues scoped session credentials. Concretely, the following are in scope:

### 1. Room provisioning & lifecycle

- `POST /provision`, `POST /activate`, `POST /close` keyed by `(appId, contextType, contextId)`.
- Room-mode semantics: `IN_PERSON` → AudioBridge, `REMOTE` → VideoRoom, `HYBRID` → both, `CHAT` → Matrix only. Room mode is immutable after provisioning.
- Audit logging of every state-changing call via `CommunicationAuditLog`.

### 2. Chat, audio, video, and SIP via pluggable providers

- `ChatProvider` — Matrix Synapse is the reference implementation.
- `MediaProvider` — Janus Gateway (reference) and LiveKit (opt-in via `MEDIA_PROVIDER=livekit`).
- `SipProvider` — Janus SIP + Kamailio (reference). SIP implementations must declare their `compatibleMediaProviders`; incompatible pairings are refused at `/health` and on `authorize-user`.
- New providers are accepted into the core when they implement an existing interface cleanly and don't force changes to callers — see [How to propose a scope change](#how-to-propose-a-scope-change) for the process.

### 3. Authorization & session issuance

- Internal JWT with `aud: "communications-service"` gates every `/internal/*` endpoint.
- `authorize-user` returns a unified session response: `chat`, `audioBridge`, `videoRoom`, `sip` capability blocks, each with `status: available | unavailable` and a provider-tagged `credentials` object (when available).
- Session invalidation via `/invalidate-session`.

### 4. Multi-tenant isolation

- Hard isolation by `appId`. Rooms with the same `(contextType, contextId)` under different `appId`s are unrelated. Cross-tenant access is never permitted.

### 5. Graceful degradation

- A booting server with unavailable capabilities is not necessarily broken. Capabilities report `unavailable` with a reason on `/health`; `authorize-user` surfaces per-capability status so consumers can render partial UIs.

### 6. Operational plumbing

- RabbitMQ lifecycle events: `communications.room.provisioned`, `communications.room.activated`, `communications.room.closed`.
- Prisma-backed persistence (`CommunicationUser`, `CommunicationRoom`, `CommunicationMembership`, `CommunicationAuditLog`).
- Health reporting that exposes provider connectivity and compatibility.

---

## Out of scope (hard line)

The following will be rejected unless the rejection itself is revisited via a scope-change Discussion. Opening a PR for any of these — without a prior accepted scope change — is the fastest path to a close.

### Infrastructure / product category

- **PSTN or carrier telephony.** Commukit does not trunk to the public phone network. SIP here means app-scoped softphones via Kamailio + Janus SIP.
- **End-to-end encrypted media.** Media passes through the transport backend (Janus / LiveKit). Consumers who need E2EE should use a purpose-built product.
- **Large broadcast / streaming.** SFU fan-out is bounded by the underlying transport; commukit is not a CDN, HLS packager, or RTMP ingest.
- **Public or federated chat.** Matrix rooms are app-scoped and private. Federation between Matrix instances is not configured and not supported.
- **Federation between commukit instances.** Two commukit deployments do not share room state, credentials, or membership. Each deployment is a standalone authority over its rooms.

### Architectural / invariant

- **Anything that makes commukit a media relay.** The service orchestrates and issues credentials; media flows directly between clients and transport backends. Any proposal that routes media bytes through the commukit service itself is out of scope.
- **Breaking the room-key shape.** Rooms are keyed by `(appId, contextType, contextId)`. Proposals that introduce additional primary-key dimensions, composite keys, or hierarchical room relationships are out of scope.
- **Breaking room-mode immutability.** Once a room is provisioned with a mode, the mode cannot change. Proposals that add "upgrade from AUDIO to HYBRID mid-session" or similar are out of scope.
- **Consumer-specific behavior in core.** Anything Parliament-specific, school-specific, meeting-specific, or otherwise tied to one consumer app stays in the consumer app. Commukit is a shared platform component; it must remain domain-agnostic.
- **Domain authorization.** Deciding which users may join which rooms is the consumer app's responsibility. Commukit trusts any caller with a valid internal JWT.

### Process

- **Opinionated client SDKs in this repo.** A thin reference example (`examples/minimal-consumer/`) is fine. A full TypeScript / Flutter / iOS SDK with bespoke conventions is a separate repo.

---

## How to propose a scope change

Scope is a contract between the maintainers and the community. Changing it requires public discussion and maintainer consensus, not a PR.

**The process:**

1. **Open a GitHub Discussion** ([Discussions](https://github.com/levis-creator/commukit/discussions)) describing:
   - The use case you want to enable.
   - Why commukit is the right place to solve it (not a consumer app, not a separate repo).
   - The interface / API / data changes you think would be needed.
   - Any licensing, security, or operational implications (especially relevant for federation, E2EE, telephony).
2. **Maintainers respond** within the [SLA documented in `CONTRIBUTING.md`](../CONTRIBUTING.md#triage--response-sla). Likely outcomes:
   - Accepted in scope → the relevant section of this file is updated, an "In scope" item is added, and issues / PRs become welcome.
   - Accepted under a constraint → scope expands with explicit guardrails (e.g. "federation is in scope if it preserves tenant isolation and does not extend `appId` semantics").
   - Remains out of scope → the Discussion is pinned / linked so future requesters find it.
3. **No implementation work begins** until the Discussion resolves one way or the other. PRs opened in advance will be closed with a link to the (in-progress) Discussion.

**What does _not_ require a scope-change Discussion:**

- Fixing a bug in an existing in-scope area.
- Adding tests.
- Improving docs, examples, or CI.
- Extending an existing provider interface in a backwards-compatible way (e.g. adding an optional capability flag). These go through the normal "Discussion-required tier" path in the [`CONTRIBUTING.md` merge rubric](../CONTRIBUTING.md#merge-rubric) without needing to modify this document.

---

## Closing an out-of-scope issue or PR

Maintainers close out-of-scope work with a single-sentence reference to this document, e.g.:

> Out of scope per `docs/SCOPE.md` § "Out of scope — Federation between commukit instances." Closing — please open a Discussion if you'd like to propose a scope change.

This is not meant to feel cold. It's meant to be fast, honest, and consistent so the contribution funnel scales.
