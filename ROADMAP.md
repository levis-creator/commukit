# Roadmap

Near-term work planned, underway, or under consideration for commukit. Items move between sections as their status changes; see [git history](https://github.com/levis-creator/commukit/commits/main) for exact merge order.

Scope boundaries are in [`docs/SCOPE.md`](docs/SCOPE.md) — anything not listed there as "In scope" will not appear on this roadmap without a scope-change Discussion first.

---

## In progress

- **OSS hardening Phase 6–7** — documentation polish (badges, ROADMAP, minimal-consumer example) and contribution governance (SCOPE, MAINTAINERS, label taxonomy, triage/stale workflows).
- **ESLint warnings cleanup** — the 5 pre-existing warnings surfaced during Phase 4 ESLint onboarding (`no-useless-catch` in `src/janus/janus.service.ts`, unused-vars in a few spec and DTO files). Each warning is a small targeted fix in its own PR.

## Planned

- **`v0.1.0` release** — first tagged release. Declares the `X-Comms-API-Version: 2` contract as stable and publishes the first multi-arch image to `ghcr.io/levis-creator/commukit`. See [`RELEASING.md`](RELEASING.md).
- **Raise coverage thresholds** — current gates are conservative (statements 45 / branches 40 / functions 40 / lines 47, below the 60/50/60/60 target). Tighten the floor as tests catch up, starting with the lowest-coverage modules (`src/redis/`, `src/users/`, `src/health/`).
- **Prettier-format legacy `src/`** — a one-shot `prettier --write .` commit to bring the 82 unformatted source files in line with the Phase 4 Prettier config. Held back so far to keep the hardening PR stream readable; lands as a standalone refactor commit.
- **Remove `release-as: 0.1.0`** — `release-please-config.json` pins the first release. After `v0.1.0` ships, the pin comes out so subsequent versions are driven by Conventional Commits.
- **LiveKit SIP hardening** — the `sip/` module currently only declares `janus` as a compatible media provider. A LiveKit-backed SIP path would need a new `SipProvider` implementation that binds to LiveKit SIP Ingress dispatch rules (documented in `docs/PROVIDERS.md`).
- **Integration test suite** — Phase 3 CI already spins up postgres + redis + rabbitmq service containers, but the current Jest specs mock these. A follow-up pass adds true integration tests (provisioning → activation → authorize-user → close) against the live containers, gated on a separate CI job.

## Considering

- **Additional provider adapters** — new `MediaProvider` / `ChatProvider` / `SipProvider` implementations (e.g. alternative media SFUs, alternative chat backends). Each needs a scope-change Discussion per [`docs/SCOPE.md`](docs/SCOPE.md); ones that pass muster land here as "Planned".
- **Recording strategy** — whether commukit should orchestrate recording (via Janus record plugin, LiveKit egress, or a separate worker) or leave it fully to consumer apps. Currently out-of-scope; reopening would require a Discussion.
- **Observability hooks** — structured metrics on room lifecycle events, health-status transitions, and authorize-user latency, exposed as Prometheus or OpenTelemetry.
- **Optional Postgres → MySQL / SQLite support** — Prisma supports it, but the current schema uses `@db.Text`, arrays, and JSON columns that would need a compatibility audit.
- **Federation between commukit instances** — **explicitly out of scope** per [`docs/SCOPE.md`](docs/SCOPE.md); listed here only so anyone asking gets a clear, citeable answer.

---

## How to propose additions

- **Bug or enhancement inside an existing scope area** — open an issue using the appropriate template.
- **New scope area** — open a GitHub Discussion first (see [`CONTRIBUTING.md`](CONTRIBUTING.md) § "Before You Open a PR"). If the maintainers agree the idea is in scope, it moves onto this roadmap as "Planned" or "Considering".
- **Specific work you want to take on** — comment on the existing issue or roadmap-related Discussion before opening a PR so effort isn't duplicated.
