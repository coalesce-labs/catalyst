# Changelog

## [4.0.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-meta-v4.0.0...catalyst-meta-v4.0.1) (2026-04-13)


### Bug Fixes

* **dev:** add fully-qualified plugin prefixes to skill references ([#69](https://github.com/coalesce-labs/catalyst/issues/69)) ([f9e69f2](https://github.com/coalesce-labs/catalyst/commit/f9e69f29ce7021997f4fba17b1c2bb88e1b62b69))

## [4.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-meta-v3.1.3...catalyst-meta-v4.0.0) (2026-04-10)


### ⚠ BREAKING CHANGES

* **dev:** migrate workflow state from .claude/ to .catalyst/ ([#63](https://github.com/coalesce-labs/catalyst/issues/63))

### Features

* **dev:** migrate workflow state from .claude/ to .catalyst/ ([#63](https://github.com/coalesce-labs/catalyst/issues/63)) ([114c7c4](https://github.com/coalesce-labs/catalyst/commit/114c7c47734574d552f932fa41902e5adb819283))

## [3.1.3](https://github.com/coalesce-labs/catalyst/compare/catalyst-meta-v3.1.2...catalyst-meta-v3.1.3) (2026-04-06)


### Bug Fixes

* **pm:** restore agents array removed in error ([#58](https://github.com/coalesce-labs/catalyst/issues/58)) ([c58ada5](https://github.com/coalesce-labs/catalyst/commit/c58ada507059c2381f6dc3652fc35edb2946f581))

## [3.1.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-meta-v3.1.1...catalyst-meta-v3.1.2) (2026-04-06)


### Bug Fixes

* **pm:** remove explicit agents array that also broke auto-discovery ([#56](https://github.com/coalesce-labs/catalyst/issues/56)) ([71a8238](https://github.com/coalesce-labs/catalyst/commit/71a82389a733e7a24930030ab0af9aa95f8371d6))

## [3.1.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-meta-v3.1.0...catalyst-meta-v3.1.1) (2026-04-06)


### Bug Fixes

* **pm:** remove explicit skills array that broke autocomplete ([#54](https://github.com/coalesce-labs/catalyst/issues/54)) ([09a5503](https://github.com/coalesce-labs/catalyst/commit/09a5503810467565c00ed4ce87d6c52e01e97300))

## [3.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-meta-v3.0.0...catalyst-meta-v3.1.0) (2026-03-25)


### Features

* **dev:** remove Railway integration, add /loop workflow monitoring ([#30](https://github.com/coalesce-labs/catalyst/issues/30)) ([d7df8f2](https://github.com/coalesce-labs/catalyst/commit/d7df8f261ae05abd528d54d695df340b83147d30))


### Bug Fixes

* **dev:** fix release-please pipeline + add health monitoring ([#32](https://github.com/coalesce-labs/catalyst/issues/32)) ([cd7054c](https://github.com/coalesce-labs/catalyst/commit/cd7054c591afad61d307a11456855ad397257de3))

## [3.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-meta-v2.3.0...catalyst-meta-v3.0.0) (2026-03-20)


### ⚠ BREAKING CHANGES

* Configuration must now be nested under 'catalyst' key

### Features

* **dev:** add agent-browser skill for browser automation ([#16](https://github.com/coalesce-labs/catalyst/issues/16)) ([651241b](https://github.com/coalesce-labs/catalyst/commit/651241bfe9f559fde0f6ae1566d8bed7e6616e94))
* **linear:** add configurable stateMap for portable state transitions ([#15](https://github.com/coalesce-labs/catalyst/issues/15)) ([371e1d5](https://github.com/coalesce-labs/catalyst/commit/371e1d5dd7c196c2476c28eb873b367d072bb219))
* refresh workflow commands with new commands, model tiers, and agent teams ([#10](https://github.com/coalesce-labs/catalyst/issues/10)) ([10a010a](https://github.com/coalesce-labs/catalyst/commit/10a010a51126a8ad9485c37ae6fcb92a4156e8ee))
* restructure to 4-plugin architecture with session-aware MCP management ([08f1ec1](https://github.com/coalesce-labs/catalyst/commit/08f1ec1bdd552917c7d29ea8e917be1b8531342f))


### Bug Fixes

* add namespace prefixes to all slash command references ([099bec9](https://github.com/coalesce-labs/catalyst/commit/099bec9f024594545946dbf8cba78033eb5b0cf6))
* correct plugin marketplace schema and enhance README ([89a8fe5](https://github.com/coalesce-labs/catalyst/commit/89a8fe5fd3e4d6e3d436f2b6694364c0776bd434))


### Miscellaneous Chores

* bump versions for breaking config namespace change ([9a3f63b](https://github.com/coalesce-labs/catalyst/commit/9a3f63b70c119f7a019116788e6ba0c65b32aa04))

## [2.3.0](https://github.com/coalesce-labs/catalyst/compare/e494235...HEAD) (2026-03-17)

Initial tracked version. Prior changes were not tracked with conventional commits scoped to meta.
