# Changelog

## [2.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-legacy-v2.2.1...catalyst-legacy-v2.3.0) (2026-08-24)


### Features

* **packaging:** CTL-1463 — installable plugin packages for Codex + open-spec agents ([#3978](https://github.com/coalesce-labs/catalyst/issues/3978)) ([3b80357](https://github.com/coalesce-labs/catalyst/commit/3b803576f1f801278ebf6ac92da68026d289d6dd))

## [2.2.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-legacy-v2.2.0...catalyst-legacy-v2.2.1)

Aug 12, 2026

<!-- ai-enhanced -->

### Worktree-Safe PR Merge

Automated merges no longer fail with `fatal: 'main' is already used by worktree` when running from git linked worktrees. The fix drops `--delete-branch` from all `gh pr merge` calls and replaces it with a checkout-free remote ref delete via the GitHub REST API, applied consistently across the phase-agent pipeline, oneshot workers, and interactive merge skill. No migration steps required.



### PRs

* **dev:** CTL-56 — worktree-safe merge (drop --delete-branch, checkout-free ref cleanup) ([#3277](https://github.com/coalesce-labs/catalyst/issues/3277)) ([f9690b5](https://github.com/coalesce-labs/catalyst/commit/f9690b58dc48a2684810a96aa1b7abb5dcc7dffb))

## [2.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-legacy-v2.1.0...catalyst-legacy-v2.2.0) (2026-08-04)


### Features

* **dev:** CTL-1628 catalyst-runtime-root resolver — fold Tier 1 duplicates + 4 latent resolver bugs (Phase A2) ([#2946](https://github.com/coalesce-labs/catalyst/issues/2946)) ([c01ef76](https://github.com/coalesce-labs/catalyst/commit/c01ef76bd7ec44fee32369f732848494187c1b97))

## [2.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-legacy-v2.0.0...catalyst-legacy-v2.1.0)

Jul 02, 2026

<!-- ai-enhanced -->

### Replica-First Linear Read Enforcement

Every agent path that reads a Linear ticket now routes through the local `catalyst-replica.db` by default, closing the gap that was causing ~52 laptop agent sessions to hammer the personal API key with 429 errors. A new `detect-bare-linear-read.sh` hook catches bare `linearis issues read` calls before they fire, running in observe mode by default and switchable to enforce via `CATALYST_LINEAR_READ_DETECT_MODE`. Writes, list/search, and unmirrored fields stay on `linearis` as before.



### PRs

* **dev:** CTL-1397 enforcement — replica-first Linear reads as a standard prerequisite reflex ([#2543](https://github.com/coalesce-labs/catalyst/issues/2543)) ([98dfbac](https://github.com/coalesce-labs/catalyst/commit/98dfbac7216d6ede87b6edf22d690b1188d7cbd1))

## [2.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-legacy-v1.0.0...catalyst-legacy-v2.0.0) (2026-06-06)


### ⚠ BREAKING CHANGES

* **dev:** plugin reorg — catalyst-foundry plugin, legacy topology fix, compound-estimate rename (CTL-786) ([#1350](https://github.com/coalesce-labs/catalyst/issues/1350))

### Features

* **dev:** document and enforce the Linear app-actor botUserId requirement ([#1282](https://github.com/coalesce-labs/catalyst/issues/1282)) ([a4bb94d](https://github.com/coalesce-labs/catalyst/commit/a4bb94d6ce3173abf78fcc5932ea03fead55b191))
* **dev:** plugin reorg — catalyst-foundry plugin, legacy topology fix, compound-estimate rename (CTL-786) ([#1350](https://github.com/coalesce-labs/catalyst/issues/1350)) ([0995954](https://github.com/coalesce-labs/catalyst/commit/09959540b8ec633ef6cb6f45a7c1778e15e3f4d6))

## 1.0.0 (2026-05-29)

### Features

* Initial release — six wave-based orchestration skills migrated from catalyst-dev v11.0.0 (CTL-726):
  `oneshot`, `orchestrate`, `god`, `setup-orchestrate`, `briefing-followup`, `iterate-plan`.
  Backing scripts remain in `plugins/dev/scripts/` and are resolved at runtime via `CATALYST_DEV_SCRIPTS`.
