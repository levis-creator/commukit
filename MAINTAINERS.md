# Maintainers

This file lists the people responsible for commukit: who merges, who owns review, and how someone new joins the list.

## Current maintainers

| Name         | GitHub           | Areas                | Contact                  |
| ------------ | ---------------- | -------------------- | ------------------------ |
| Levis Nyingi | `@levis-creator` | Everything (primary) | `levis.nyingi@gmail.com` |

Maintainers are listed in [`.github/CODEOWNERS`](.github/CODEOWNERS) so review is auto-requested on PRs that touch the relevant paths.

## What maintainers do

- Triage new issues and PRs within the response-time goals documented in [`CONTRIBUTING.md` § Triage & Response SLA](CONTRIBUTING.md#triage--response-sla).
- Review PRs for scope alignment ([`docs/SCOPE.md`](docs/SCOPE.md)), code quality, test coverage, and security implications.
- Merge PRs that meet the bar, or close those that don't with a citable reason.
- Cut releases by approving release-please PRs (see [`RELEASING.md`](RELEASING.md)).
- Moderate Discussions and issue threads per the [Code of Conduct](CODE_OF_CONDUCT.md); escalate CoC violations to the contact address in that file.
- Keep this file, `CODEOWNERS`, and the label taxonomy in sync when membership or ownership changes.

Maintainers do **not** automatically own:

- Security incident response (see [`SECURITY.md`](SECURITY.md)).
- Final scope decisions — significant scope changes require Discussion and consensus among existing maintainers, not a single maintainer's call.

## Path to becoming a maintainer

Commukit welcomes new maintainers. The expectation is not "wrote a lot of code" but rather "sustained good judgment." The path:

1. **Contribute consistently for at least three months.** That can be a mix of code PRs, test PRs, docs PRs, issue triage, review comments, or Discussion participation — the common thread is quality contributions that required the existing maintainers to give little-to-no rework feedback.
2. **Get nominated in a GitHub Discussion.** Either self-nominate or be nominated by an existing maintainer. The Discussion should link 3–5 representative contributions and describe the areas you'd like to help own.
3. **Maintainers vote.** A simple majority of current maintainers approves. Rejection is not permanent — revisit in another 3 months if circumstances change.
4. **You're added.** The maintainer-to-be is added to this file, to `CODEOWNERS` globs corresponding to their areas, to any relevant GitHub team, and granted write access to the repo. They get a short onboarding note covering release-please, the label taxonomy, and the merge rubric.

## Stepping down

Maintainers can step back at any time by opening a PR that removes themselves from this file and `CODEOWNERS`. Emeritus is not tracked separately — git history is the source of truth for who contributed when.

If a maintainer is unresponsive for more than 90 days and has not indicated a planned absence, any other maintainer may open a PR to move them out of `CODEOWNERS` (keeping the MAINTAINERS.md entry as "inactive") to prevent stalled reviews.

## Response-time commitments

Published in [`CONTRIBUTING.md` § Triage & Response SLA](CONTRIBUTING.md#triage--response-sla). Summary: first maintainer response within **7 calendar days** for issues, **14 calendar days** for PRs. Hard numbers, not a guarantee — life happens. A polite ping on a stale thread is welcome.

## Conduct

All maintainer activity is bound by the [Code of Conduct](CODE_OF_CONDUCT.md). Moderation decisions are made by any active maintainer and documented in the thread where they happen.
