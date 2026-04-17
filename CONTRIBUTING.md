# Contributing to commukit

Thanks for your interest in contributing. This guide covers everything you need to get from a fresh clone to a merged PR.

## Table of contents

1. [Dev environment setup](#dev-environment-setup)
2. [Branch naming](#branch-naming)
3. [Conventional Commits](#conventional-commits)
4. [Running tests and lint](#running-tests-and-lint)
5. [Pull request checklist](#pull-request-checklist)
6. [Proposing a new provider](#proposing-a-new-provider)
7. [DCO sign-off](#dco-sign-off)
8. [License header on new source files](#license-header-on-new-source-files)
9. [Code of Conduct](#code-of-conduct)

---

## Dev environment setup

**Prerequisites**

- Node **20 LTS** or newer
- npm (ships with Node)
- Docker + Docker Compose (for local Postgres, Redis, RabbitMQ, and transport backends)

**First-time setup**

```bash
git clone https://github.com/levis-creator/commukit.git
cd commukit
cp .env.example .env       # then fill in values for your local stack
npm install
npm run prisma:generate
npm run prisma:migrate     # creates the local schema against .env DATABASE_URL
```

**Running the service**

```bash
npm run start:dev          # watch mode on http://localhost:3000
```

Supporting infrastructure (Matrix Synapse, Janus / LiveKit, coturn, Kamailio) is configured via the `docker-compose.yml` in this repo. The service boots in "graceful degradation" mode, so you can develop against chat-only or media-only stacks while the other capabilities report `unavailable` on `GET /health`.

## Branch naming

Use the following prefixes:

- `feat/<short-description>` — new features
- `fix/<short-description>` — bug fixes
- `chore/<short-description>` — tooling, dependencies, repo hygiene
- `docs/<short-description>` — documentation-only changes
- `test/<short-description>` — test-only additions or fixes
- `refactor/<short-description>` — internal restructuring with no behavior change
- `perf/<short-description>` — performance work
- `revert/<short-description>` — reverts of previously merged changes

## Conventional Commits

Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short subject line in imperative mood

Optional body explaining the why.

Optional footer (BREAKING CHANGE, Closes #123, Co-Authored-By, etc.).
```

**Allowed types:** `feat`, `fix`, `docs`, `chore`, `ci`, `build`, `test`, `refactor`, `perf`, `revert`.

**Breaking changes:** use `feat!:` (or any type with `!`) _and_ include a `BREAKING CHANGE:` footer describing the impact.

Examples:

```
feat(rooms): add idempotent close endpoint
fix(matrix): retry transient 429 on room-create
docs(contributing): document provider proposal flow
feat(auth)!: rotate internal JWT audience claim

BREAKING CHANGE: consumer apps must set X-Comms-API-Version: 2.
```

## Running tests and lint

```bash
npm run lint               # currently runs `tsc --noEmit` (ESLint/Prettier added in a later phase)
npm test                   # Jest — unit + service tests
npm run test:cov           # with coverage
npm run build              # `nest build`
```

All four commands must succeed before opening a PR. CI will run the same set.

## Pull request checklist

Before you request review, confirm:

- [ ] Tests added or updated for any behavior change
- [ ] Docs updated (README / CONTRIBUTING / inline, or N/A)
- [ ] Breaking change flagged with `feat!:` / `fix!:` and a `BREAKING CHANGE:` footer
- [ ] Every new `.ts` file carries the Apache-2.0 SPDX header (see below)
- [ ] Linked issue: `Closes #…` in the PR body
- [ ] If the public HTTP/WS surface changed, include a before/after example (curl or payload diff)

## Proposing a new provider

Commukit is built around pluggable transport providers. The interfaces live in [`src/providers/`](src/providers/) and today there are three:

- `MediaProvider` — audio/video rooms. Existing impls: [`src/janus/`](src/janus/), [`src/livekit/`](src/livekit/)
- `ChatProvider` — chat rooms. Existing impl: [`src/matrix/`](src/matrix/)
- `SipProvider` — SIP gateway. Existing impl: [`src/sip/`](src/sip/) (Janus-backed bridge)

To propose a new provider:

1. **Open a GitHub Discussion first.** Describe the backend you want to add, the interface(s) it will implement, its license, and why it belongs in-tree. New providers are a discussion-required change — PRs opened without a linked discussion may be closed without review.
2. Implement the interface(s) in `src/<provider-name>/`, following the existing module layout (module file, service file, optional config file, `*.spec.ts`).
3. Bind the implementation to the DI token(s) — `MEDIA_PROVIDER`, `CHAT_PROVIDER`, or `SIP_PROVIDER` — in a provider-specific Nest module.
4. Add a `.spec.ts` covering the happy path plus each degradation signal (`unreachable`, `unregistered`, etc.) your backend can report on `GET /health`.
5. Document the new provider and its required env vars in `docs/PROVIDERS.md` and `.env.example`.

## DCO sign-off

Every commit must carry a `Signed-off-by:` trailer to indicate you agree with the [Developer Certificate of Origin](https://developercertificate.org/). The easiest way:

```bash
git commit -s -m "feat(rooms): ..."
```

`-s` appends:

```
Signed-off-by: Your Name <your-email@example.com>
```

Use the same name and email you've configured with `git config user.name` and `git config user.email`.

## License header on new source files

Commukit is Apache-2.0 licensed. Every `.ts` file under `src/` must begin with:

```
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
```

The canonical template lives in [`COPYING.HEADER`](COPYING.HEADER). To apply it to any file you added, run:

```bash
node scripts/add-spdx-header.mjs
```

The script is idempotent — files that already carry the header are left alone. A `--check` mode (`node scripts/add-spdx-header.mjs --check`) exits non-zero if any file would change; CI will run it as a gate.

## Code of Conduct

By participating you agree to uphold our [Code of Conduct](CODE_OF_CONDUCT.md). Report violations to `levis.nyingi@gmail.com`.

---

## Before You Open a PR

Not every change is a straight-line merge. Four categories require a GitHub Discussion or issue **before** code lands, so effort isn't invested in a direction we might ask you to unwind:

1. **Public API changes** — new `/internal/v1/*` endpoints, new response fields, new required headers, or breaking shape changes to existing endpoints.
2. **New runtime dependencies** — anything added to the top-level `dependencies` in `package.json` (dev deps are fine).
3. **Room-mode or provisioning semantics** — changing what `IN_PERSON` / `HYBRID` / `REMOTE` / `CHAT` mean, adding a new mode, or changing the `(appId, contextType, contextId)` key shape.
4. **JWT or auth-model changes** — anything touching `src/auth/`, the `aud: "communications-service"` claim, or `INTERNAL_SERVICE_SECRET` handling.

PRs in these categories opened without a linked Discussion may be closed without review. Tag the PR body with `Refs: #<discussion-or-issue>` so reviewers can find the context.

For everything else (bug fixes, tests, docs, CI tweaks, provider-internal refactors, Dependabot updates), open a PR directly.

## Triage & Response SLA

Targets, not guarantees:

- **Issues:** first maintainer response within **7 calendar days**.
- **PRs:** first maintainer response within **14 calendar days**.
- **Security reports** (per [`SECURITY.md`](SECURITY.md)): acknowledgment within 7 days, substantive reply within 14.

If you haven't heard back within the target window, a polite ping on the thread is welcome. Life happens — the SLA is a floor, not a ceiling, and busy windows are handled by rolling slippage with explicit status updates.

## Label Taxonomy

Labels are version-controlled in [`.github/labels.yml`](.github/labels.yml) and reconciled to the repo by the `label-sync` workflow. Do not create labels manually in the GitHub UI.

Categories:

- **`type/*`** — kind of change: `type/bug`, `type/feature`, `type/docs`, `type/chore`, `type/security`.
- **`capability/*`** — which user-facing capability is affected: `chat`, `audio`, `video`, `sip`, `health`.
- **`provider/*`** — which transport backend: `matrix`, `janus`, `livekit`, `kamailio`.
- **`status/*`** — where in the workflow the item sits: `needs-triage`, `needs-info`, `needs-design`, `blocked`, `help-wanted`, `in-progress`, `needs-review`.
- **`priority/*`** — urgency: `p0-critical` (drop everything else), `p1-high`, `p2-normal` (default), `p3-low`.
- **`resolution/*`** — why it was closed: `duplicate`, `wontfix`, `out-of-scope`, `cannot-reproduce`.
- **Onboarding** — `good-first-issue`, `help-wanted`.
- **Meta** — `pinned` (exempt from stale-bot closure).

Path-based labels (`provider/*`, `capability/*`, `type/*`) are auto-applied to PRs by [`.github/labeler.yml`](.github/labeler.yml). Everything else is set by a maintainer during triage.

## Merge Rubric

Three tiers the maintainers use to decide how to handle a contribution. Stating them openly so rejections feel principled, not personal.

### Auto-accept tier (low-risk, high-value)

These land with a simple approving review once CI is green:

- Bug fix with a regression test.
- Documentation improvement.
- Test coverage addition on an existing path.
- Dependabot update (npm / docker / github-actions).
- CI or workflow improvement that doesn't change developer-facing behavior.

### Discussion-required tier (needs an issue or Discussion first)

Open an issue or Discussion describing intent before the PR:

- New API endpoint.
- New provider adapter (`MediaProvider` / `ChatProvider` / `SipProvider` implementation).
- JWT or authorization model change.
- New runtime dependency.
- Prisma schema migration.
- Performance change that alters resource use (memory, CPU, network behavior).

If a PR in this tier arrives without a linked Discussion, maintainers will ask for one before reviewing in depth.

### Reject-by-default tier (out of scope)

Anything in the "Out of scope" section of [`docs/SCOPE.md`](docs/SCOPE.md) is closed with a reference to the relevant clause and an invitation to open a Discussion if the contributor believes the scope should change. Typical cases:

- PSTN / carrier telephony.
- End-to-end encrypted media.
- Federation between commukit instances.
- Anything that routes media bytes through the commukit service.
- Anything consumer-app-specific (Parliament, etc.).

## Stale Policy

Automated by [`.github/workflows/stale.yml`](.github/workflows/stale.yml). Published here so nothing the bot does is a surprise:

- **Issues** carrying `status/needs-info`: go stale after **30 days** of no activity, closed **7 days** after that. The stale comment explains how to revive: add the requested info, or remove `status/needs-info` to put the issue back in the triage queue.
- **PRs**: go stale after **60 days** of no activity, closed **14 days** after that. Any push, comment, or review-request resets the clock.
- **Exempt labels** (bot will not touch): `priority/p0-critical`, `status/blocked`, `status/help-wanted`, `pinned`.

If you need an issue or PR to be exempt for legitimate reasons, ask a maintainer to add `pinned` or move it to `status/blocked` with a linked blocker.
