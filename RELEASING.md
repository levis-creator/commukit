# Releasing commukit

Commukit uses [release-please](https://github.com/googleapis/release-please) to automate versioning, `CHANGELOG.md` updates, and GitHub Releases from Conventional Commits on `main`. Most releases require zero manual steps beyond merging a PR.

## Quick reference

| Step                                      | Who                         | How                               |
| ----------------------------------------- | --------------------------- | --------------------------------- |
| 1. Land work on `main`                    | Contributor                 | PR with Conventional Commits      |
| 2. release-please opens a release PR      | release-please bot          | Automatic on every push to `main` |
| 3. Review & merge the release PR          | Maintainer                  | Normal PR merge                   |
| 4. Tag + Release + Docker image published | release-please + docker.yml | Automatic on release PR merge     |

## How it works

1. **Commits drive versioning.** Every commit on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/). Release-please inspects commit types (`feat`, `fix`, `perf`, `feat!:`, `BREAKING CHANGE:` footers, etc.) to decide the next version.
2. **release-please opens a release PR.** On every push to `main`, the [`.github/workflows/release-please.yml`](.github/workflows/release-please.yml) workflow runs. If there are unreleased commits, it opens (or updates) a "chore: release X.Y.Z" PR that bumps `package.json`, updates `.release-please-manifest.json`, and appends the unreleased entries to [`CHANGELOG.md`](CHANGELOG.md).
3. **Merging the release PR publishes.** The maintainer reviews the release PR (change scope, version, changelog entries), then merges it. On merge:
   - release-please creates a git tag `vX.Y.Z` and a GitHub Release with the generated notes.
   - The tag triggers [`.github/workflows/docker.yml`](.github/workflows/docker.yml), which builds a multi-arch image, pushes it to `ghcr.io/levis-creator/commukit:vX.Y.Z` and `:latest`, smoke-checks that `/app/NOTICE` is intact, and runs a Trivy image scan.

## Version policy

| Commit type on `main`                                    | Version bump                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `feat:`                                                  | minor                                                        |
| `fix:` / `perf:`                                         | patch                                                        |
| `docs:`, `chore:`, `build:`, `ci:`, `refactor:`, `test:` | no bump by default (appear in changelog under their section) |
| Any type with `!` or a `BREAKING CHANGE:` footer         | major — except while we are pre-1.0 (see below)              |

**Pre-1.0 behavior.** Until commukit reaches `v1.0.0`, the config sets `bump-minor-pre-major: true`, meaning breaking changes produce a **minor** bump (not a major), and `feat` commits also only produce a **minor** bump. This is the SemVer-compliant convention for `0.y.z` projects.

## Breaking changes

Mark a breaking change explicitly so it shows up as `BREAKING CHANGES` in the changelog and triggers the right version bump.

Two equivalent ways:

**`!` in the subject line:**

```
feat(rooms)!: change authorize-user response shape to credentials-only

The X-Comms-API-Version: 2 header is now required for all callers.
```

**`BREAKING CHANGE:` footer:**

```
feat(rooms): change authorize-user response shape to credentials-only

BREAKING CHANGE: X-Comms-API-Version: 2 is now required for all callers.
Legacy flat fields (roomId, accessToken, etc.) are no longer populated.
Consumer apps must migrate to the `credentials` union object.
```

Both forms are recognized by release-please and surface under a `⚠ BREAKING CHANGES` heading in the release notes.

## The first release (v0.1.0)

The initial [`release-please-config.json`](release-please-config.json) pins the next release to `0.1.0` via `release-as: 0.1.0`. This ensures the first tag is `v0.1.0` regardless of commit-type inference across the bootstrap history.

**After `v0.1.0` is published, remove the `release-as` field** from `release-please-config.json` so subsequent releases are driven by Conventional Commits. Land the removal as `chore(release): unpin release-as after v0.1.0`.

## Release notes customizations

release-please generates notes automatically, but for significant releases you may want a preamble (migration guide, API contract version statement, deprecation notices). Do this **after** the release PR merges:

1. Wait for release-please to create the GitHub Release.
2. Open the release on GitHub ("Releases" → the new tag).
3. Click "Edit release" and prepend your custom notes above the auto-generated sections.

For `v0.1.0` specifically, prepend:

> This release declares the first stable internal API contract. Consumer apps should opt into the `X-Comms-API-Version: 2` header on `/authorize-user` to receive the provider-tagged `credentials` response shape. See `docs/INTEGRATION_GUIDE.md` for the migration.
>
> Released under the Apache License 2.0. Downstream redistributors must propagate [`NOTICE`](NOTICE) per Apache-2.0 §4(d). See [`CREDITS.md`](CREDITS.md) for the voluntary credit line.

## Skipping a release

If `main` has only no-bump commit types (`docs:`, `chore:`, `ci:`, …) since the last release, release-please does not open a release PR. Next release is deferred until a bump-worthy commit lands.

To force a release anyway, add an empty `chore(release): cut vX.Y.Z` commit or use the release-please config's `release-as` field temporarily.

## Troubleshooting

**release-please didn't open a PR after my push to `main`.**

- Check [`.github/workflows/release-please.yml`](.github/workflows/release-please.yml) run in the Actions tab.
- Confirm Settings → Actions → General → Workflow permissions is set to **Read and write permissions** _and_ "Allow GitHub Actions to create and approve pull requests" is checked.
- If commits since the last release are all no-bump types, the PR is intentionally suppressed.

**The Docker image didn't publish after the release PR merged.**

- Check [`.github/workflows/docker.yml`](.github/workflows/docker.yml) run for the tag.
- Confirm `GITHUB_TOKEN` has `packages: write` (default for org-owned repos; per-repo for personal orgs).
- The NOTICE smoke step will fail the workflow if `/app/NOTICE` is missing from the image; verify [`Dockerfile`](Dockerfile) still has `COPY NOTICE /app/NOTICE` in the production stage.

**A release went out with the wrong version.**

- Create a new release with the correction (don't delete the tag — tags in the wild are immutable).
- Update `.release-please-manifest.json` in a follow-up commit if needed.
