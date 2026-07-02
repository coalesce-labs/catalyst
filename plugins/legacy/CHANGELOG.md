# Changelog

## [2.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-legacy-v2.0.0...catalyst-legacy-v2.1.0) (2026-07-02)


### Features

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
