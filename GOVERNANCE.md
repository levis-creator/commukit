# Governance

Commukit is currently a maintainer-led project. This document explains how decisions get made today and how that model can evolve.

## Current model

Levis Nyingi (`@levis-creator`) is the sole maintainer. The maintainer holds final say on technical direction, merges, and releases, and is accountable for project quality and the contributor experience.

## Decision making

Day-to-day changes — bug fixes, tests, docs, internal refactors — are made by pull request and merged at the maintainer's discretion when they pass review and CI.

Significant changes require a [GitHub Discussion](https://github.com/levis-creator/commukit/discussions) before implementation so the rationale and trade-offs are public:

- Public HTTP or WebSocket API additions or breaking changes
- New provider adapters (new `MediaProvider` / `ChatProvider` / `SipProvider` implementations)
- Changes to the internal JWT or authorization model
- New runtime dependencies
- License or governance changes

Pull requests in these categories opened without a linked discussion may be closed without review. The maintainer is responsible for engaging promptly once a discussion is opened.

## Path to committer

The project welcomes additional maintainers. The path is:

1. Sustained, quality contributions over at least 3 months (code, review, triage, or a mix).
2. Nomination via a GitHub Discussion (by yourself or an existing maintainer).
3. Approval by the existing maintainers.

New maintainers are added to `CODEOWNERS` and any module-specific ownership globs they want to take responsibility for.

## Conflicts and conduct

All participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Technical disagreements are resolved by the maintainer when consensus cannot be reached, with the reasoning documented in the discussion or PR thread.
