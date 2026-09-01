# Changelog

## [2.6.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-foundry-v2.5.0...catalyst-foundry-v2.6.0) (2026-09-01)


### Features

* **packaging:** CTL-1461 — real render interface, safety gate, drift gate, inventory independence ([#4015](https://github.com/coalesce-labs/catalyst/issues/4015)) ([5f4fa48](https://github.com/coalesce-labs/catalyst/commit/5f4fa482bf22e143a9f41a90487f52f113956da5))

## [2.5.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-foundry-v2.4.0...catalyst-foundry-v2.5.0) (2026-08-24)


### Features

* **packaging:** CTL-1463 — installable plugin packages for Codex + open-spec agents ([#3978](https://github.com/coalesce-labs/catalyst/issues/3978)) ([3b80357](https://github.com/coalesce-labs/catalyst/commit/3b803576f1f801278ebf6ac92da68026d289d6dd))

## [2.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-foundry-v2.3.0...catalyst-foundry-v2.4.0) (2026-08-04)


### Features

* **dev:** CTL-1628 catalyst-runtime-root resolver — fold Tier 1 duplicates + 4 latent resolver bugs (Phase A2) ([#2946](https://github.com/coalesce-labs/catalyst/issues/2946)) ([c01ef76](https://github.com/coalesce-labs/catalyst/commit/c01ef76bd7ec44fee32369f732848494187c1b97))

## [2.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-foundry-v2.2.0...catalyst-foundry-v2.3.0)

Jul 27, 2026

<!-- ai-enhanced -->

### Dual-Harness Migration Tooling

A new `migrate-dual-harness.sh` script and matching `catalyst-foundry:migrate-dual-harness` skill handle the full migration from single-harness repos (Claude-only or Codex-only) to the vendor-neutral dual-harness layout, where both Claude Code and Codex load from the same instructions and skills directory. The script classifies your repo's current state, applies mechanical fixes safely in dry-run mode by default, and hands off to the skill when a monolithic `CLAUDE.md` needs an intelligent content split. This release also adds a quality-review phase that enforces canonical symlink layout and cross-agent invocation safety gates for any skill that performs external writes.



### PRs

* **dev:** CTL-1530 dual-harness migration (migrate-dual-harness.sh + checkup §10 + foundry skill) ([#2753](https://github.com/coalesce-labs/catalyst/issues/2753)) ([0afc204](https://github.com/coalesce-labs/catalyst/commit/0afc204fd049cf6b9f9c6f7a2a87b5a032742bec))
* **foundry:** CTL-1530 add quality-review phase to migrate-dual-harness skill ([#2759](https://github.com/coalesce-labs/catalyst/issues/2759)) ([1a55693](https://github.com/coalesce-labs/catalyst/commit/1a556932f0ccc8c2c1034b651c6022c751adc570))
* **foundry:** CTL-1536 document sidecar/mutating-pair invocation-safety convention in migrate-dual-harness skill ([#2761](https://github.com/coalesce-labs/catalyst/issues/2761)) ([adff262](https://github.com/coalesce-labs/catalyst/commit/adff2621328e33eaec93a54891e33d1090183d9d))

## [2.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-foundry-v2.1.0...catalyst-foundry-v2.2.0)

Jul 21, 2026

<!-- ai-enhanced -->

### Agent House-Rules Auto-Enrollment

Any repo you enroll in Catalyst now automatically receives the "Working the Loop" agent house-rules block, kept in sync on every setup run. The underlying block has been corrected to defer Linear reads through the proper freshness-gated skill contract, restore the required review-thread resolution rule before merge, and scope reflexes to repos where the catalyst-dev substrate is present. A 60-test hardening suite covers edge cases like nested headings, CRLF line endings, and checked writes to prevent silent failures.



### PRs

* **dev:** auto-seed agent house-rules on every enrolled repo + Codex-hardened block ([#2666](https://github.com/coalesce-labs/catalyst/issues/2666)) ([97aa6de](https://github.com/coalesce-labs/catalyst/commit/97aa6deb32e74740ab6ce0a7455332bf0fd6d687))

## [2.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-foundry-v2.0.0...catalyst-foundry-v2.1.0) (2026-06-08)


### Features

* **dev:** make setup-catalyst.sh safe for headless environments (CTL-842) ([#1456](https://github.com/coalesce-labs/catalyst/issues/1456)) ([4dd39d5](https://github.com/coalesce-labs/catalyst/commit/4dd39d530367fe37292e892b318093c3f6310b2b))

## [2.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-foundry-v1.0.0...catalyst-foundry-v2.0.0) (2026-06-06)


### ⚠ BREAKING CHANGES

* **dev:** plugin reorg — catalyst-foundry plugin, legacy topology fix, compound-estimate rename (CTL-786) ([#1350](https://github.com/coalesce-labs/catalyst/issues/1350))

### Features

* **dev:** compound-engineering Slice 1 — engineering compound loop MVP (CTL-789) ([#1361](https://github.com/coalesce-labs/catalyst/issues/1361)) ([01740eb](https://github.com/coalesce-labs/catalyst/commit/01740ebe9ee67a4196417c735620bbad05301d65))
* **dev:** plugin reorg — catalyst-foundry plugin, legacy topology fix, compound-estimate rename (CTL-786) ([#1350](https://github.com/coalesce-labs/catalyst/issues/1350)) ([0995954](https://github.com/coalesce-labs/catalyst/commit/09959540b8ec633ef6cb6f45a7c1778e15e3f4d6))

## 1.0.0

### Features

* Initial release — framework setup & maintenance plugin. Skills migrated from catalyst-dev:
  `setup-catalyst`, `setup-warp`, and `research-curate`. Future home for the compound-engineering
  retro/learning loop. Backing shell scripts remain in `plugins/dev/scripts/` and resolve at
  runtime via the `CATALYST_DEV_SCRIPTS` cache shim (same pattern as catalyst-legacy).
