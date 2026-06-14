# Changelog

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
