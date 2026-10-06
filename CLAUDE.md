# Zonneplan Price Card

A Home Assistant Lovelace card (HACS *Dashboard* plugin) that draws dynamic energy prices the way the Zonneplan app does: a stepped 15-minute price line, min/max labels, a cheapest-N-hours block finder and a drag-to-read tooltip. It talks to nothing but the Home Assistant frontend's `hass` object; prices come from a sensor attribute (Zonneplan ONE integration, Nord Pool, or a generic slot list).

**This repository is public.** Everything committed here, including commit messages, is
permanent: GitHub keeps force-pushed content reachable by SHA. This file holds only
generic development rules. Anything about the maintainer's own setup (hosts, paths,
accounts, deploy) lives in the gitignored `CLAUDE.local.md`, which Claude Code also loads.

## Privacy: never commit
- Credentials, tokens, cookies, account or customer numbers, IBANs.
- Real names, addresses, phone numbers, email addresses, balances or any figure taken
  from a live account. That includes a config-entry title or entity_id built from an
  account's email. Title entries from something non-identifying.
- Raw API responses. Sanitize by hand into `tests/fixtures/` first.
- Private IPs, hostnames, filesystem paths or deploy tooling of any one installation.

## Leak guard
`.githooks/` blocks staged content and commit messages that match generic patterns (in
`leakcheck.py`) or identity patterns (kept outside the repo; see the hook header).
Enable it once per clone with `git config core.hooksPath .githooks` and test it with
`.githooks/test-pre-commit.sh`. Never bypass it with `SKIP_LEAK_CHECK=1` to get a commit
through. If it fires, the string should not be committed.

## Development
- Single ES module, no build step, no dependencies: `zonneplan-price-card.js`. HACS serves it
  as-is (`hacs.json` `filename`).
- Pure helpers (`normalizeForecast`, `forecastFromAttributes`, `cheapestWindow`, `niceStep`)
  are exported and tested with `npm test` (node:test). The custom element is only defined
  when `customElements` exists, so the module imports cleanly in Node.
- Prices are handled internally in **cents**. Zonneplan amounts are 1e-7 EUR (factor 1e-5).
- Rendering is a hand-built SVG, re-rendered on entity change, a 60 s tick, resize and
  pointer moves. Pointer listeners live on the persistent `.chart` div (the SVG is replaced
  on every render, which would drop pointer capture). `touch-action: pan-y` keeps vertical
  page scroll working on phones while a horizontal drag scrubs.
- Verify visual changes at ~390 px width, in light and dark theme, in all three states
  (Alle, a selected block, scrubbing).
- Release: bump `VERSION` in the JS, commit, push, `gh release create vX.Y.Z`. CI checks the
  tag matches `VERSION`.
