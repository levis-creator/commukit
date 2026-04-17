# Security Policy

Commukit is infrastructure that moves real-time chat, audio, and video for consumer applications. Vulnerabilities in this service can expose authentication tokens, leak session credentials, or let unauthorized clients join rooms — so we take reports seriously and handle them privately.

## Scope

This policy covers the code in this repository (`levis-creator/commukit`) only.

**In scope**

- The commukit service itself: REST endpoints, internal JWT handling, room provisioning/authorization, provider adapters (`src/janus/`, `src/livekit/`, `src/matrix/`, `src/sip/`), health reporting, RabbitMQ event publishing.
- The Prisma data model and queries in `src/database/`.
- The Dockerfile, `entrypoint.sh`, and anything else that ships in the published container image.

**Out of scope** (report upstream instead)

- Matrix Synapse — https://github.com/element-hq/synapse/security/policy
- Janus Gateway — https://janus.conf.meetecho.com/
- coturn — https://github.com/coturn/coturn/security/policy
- Kamailio — https://www.kamailio.org/w/security/
- LiveKit Server — https://github.com/livekit/livekit/security/policy

Findings in historic tags that are not present in `main` are also out of scope unless the tag is still listed as a supported release.

## How to report

**Do not open a public GitHub issue.** Email:

- `levis.nyingi@gmail.com`
- Preferred subject prefix: `[commukit-security]`

Include:

- A description of the issue and its potential impact
- Reproduction steps (or a proof-of-concept) against a specified commukit version or commit
- The affected component (capability + provider, if known)
- Your preferred contact method for follow-up

We'll acknowledge receipt within **7 days** and aim to send a first substantive response within **14 days**. If you don't hear back within 7 days, please resend the email and optionally ping via GitHub (`@levis-creator`) asking us to check our inbox — without including any vulnerability detail in the public ping.

## GPG (optional)

If you'd like to encrypt your report, we're happy to supply a public key.

<!-- Fingerprint and public key URL can be added here when available. -->

If no key is listed yet, plain email is acceptable for initial contact; we'll coordinate a secure channel if the report contains sensitive detail.

## Coordinated disclosure

We follow a **90-day coordinated disclosure window**:

1. **Day 0** — report received, acknowledged, and triaged.
2. **Day 0–30** — fix developed, reviewed privately, and tested.
3. **Day 30–60** — fix merged to `main` and included in the next tagged release.
4. **Day ≤ 90** — public advisory published via GitHub's Security Advisories workflow, with CVE assignment when applicable. The reporter is credited unless they request anonymity.

The window can be extended by mutual agreement if an upstream dependency fix is gating the release.

## What we consider out of scope as a *report*

- Missing rate limits or DoS through load generation (operational tuning, not a code defect)
- Social engineering against the maintainer
- Findings that depend on the operator configuring commukit against untrusted infrastructure
- Third-party transport bugs (see upstream links above)

## Hall of fame

Security researchers whose reports lead to a fix are listed here once the corresponding advisory is published.

<!-- First credited reporter will appear here. -->
