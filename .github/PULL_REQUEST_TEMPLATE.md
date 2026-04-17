<!--
Thanks for your PR! Fill in the sections below and tick each item in the checklist.
If anything doesn't apply, replace the checkbox with N/A rather than deleting it
so reviewers know you considered it.
-->

## Summary

<!-- One or two sentences describing what this PR does. -->

## Why

<!-- The motivating problem or user need. Link to any related Discussion or issue. -->

## How to test

<!-- The exact steps a reviewer should run to exercise the change. -->

## Notes for reviewer

<!-- Anything you want the reviewer to pay extra attention to, or known follow-ups. -->

---

## Checklist

- [ ] Tests added or updated for any behavior change
- [ ] Docs updated (README / CONTRIBUTING / inline, or N/A)
- [ ] Breaking change? If yes, explain above and use `feat!:` / `fix!:` with a `BREAKING CHANGE:` footer
- [ ] Every new `.ts` file under `src/` carries the Apache-2.0 SPDX header from [`COPYING.HEADER`](../COPYING.HEADER) (run `node scripts/add-spdx-header.mjs` if unsure)
- [ ] Linked issue: `Closes #…`
- [ ] If the public HTTP/WebSocket API surface changed, include a before/after example (curl output or payload diff) above
