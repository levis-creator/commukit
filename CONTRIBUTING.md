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

**Breaking changes:** use `feat!:` (or any type with `!`) *and* include a `BREAKING CHANGE:` footer describing the impact.

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
