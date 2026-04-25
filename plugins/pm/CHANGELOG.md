# Changelog

## [6.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v6.0.3...catalyst-pm-v6.1.0) (2026-04-25)


### Features

* **pm:** define AI-native estimation signal schema (CTL-184) ([#275](https://github.com/coalesce-labs/catalyst/issues/275)) ([6aa462c](https://github.com/coalesce-labs/catalyst/commit/6aa462c15ab72ea781059bf95b716b21e9e84c89))

## [6.0.3](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v6.0.2...catalyst-pm-v6.0.3) (2026-04-13)


### Bug Fixes

* **dev:** DRY linearis CLI commands, fix setup false positive ([#84](https://github.com/coalesce-labs/catalyst/issues/84)) ([68115ac](https://github.com/coalesce-labs/catalyst/commit/68115acd8168e14683a4a079b0cc42b7f2a763b7))

## [6.0.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v6.0.1...catalyst-pm-v6.0.2) (2026-04-13)


### Bug Fixes

* **dev:** DRY linearis across all skills, fix direnv timing and [@me](https://github.com/me) bug ([#80](https://github.com/coalesce-labs/catalyst/issues/80)) ([58e0a7b](https://github.com/coalesce-labs/catalyst/commit/58e0a7b14a423429fbb6f2de244f1e2f930dc89d))

## [6.0.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v6.0.0...catalyst-pm-v6.0.1) (2026-04-13)


### Bug Fixes

* **dev:** add fully-qualified plugin prefixes to skill references ([#69](https://github.com/coalesce-labs/catalyst/issues/69)) ([f9e69f2](https://github.com/coalesce-labs/catalyst/commit/f9e69f29ce7021997f4fba17b1c2bb88e1b62b69))
* **dev:** initialize workflow context and OTEL ticket early ([#73](https://github.com/coalesce-labs/catalyst/issues/73)) ([3406c30](https://github.com/coalesce-labs/catalyst/commit/3406c3099d1e6fcbf9604e9d66649e6e3fbd423e))

## [6.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v5.2.3...catalyst-pm-v6.0.0) (2026-04-10)


### ⚠ BREAKING CHANGES

* **dev:** migrate workflow state from .claude/ to .catalyst/ ([#63](https://github.com/coalesce-labs/catalyst/issues/63))

### Features

* **dev:** migrate workflow state from .claude/ to .catalyst/ ([#63](https://github.com/coalesce-labs/catalyst/issues/63)) ([114c7c4](https://github.com/coalesce-labs/catalyst/commit/114c7c47734574d552f932fa41902e5adb819283))

## [5.2.3](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v5.2.2...catalyst-pm-v5.2.3) (2026-04-06)


### Bug Fixes

* **pm:** restore agents array removed in error ([#58](https://github.com/coalesce-labs/catalyst/issues/58)) ([c58ada5](https://github.com/coalesce-labs/catalyst/commit/c58ada507059c2381f6dc3652fc35edb2946f581))

## [5.2.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v5.2.1...catalyst-pm-v5.2.2) (2026-04-06)


### Bug Fixes

* **pm:** remove explicit agents array that also broke auto-discovery ([#56](https://github.com/coalesce-labs/catalyst/issues/56)) ([71a8238](https://github.com/coalesce-labs/catalyst/commit/71a82389a733e7a24930030ab0af9aa95f8371d6))

## [5.2.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v5.2.0...catalyst-pm-v5.2.1) (2026-04-06)


### Bug Fixes

* **pm:** remove explicit skills array that broke autocomplete ([#54](https://github.com/coalesce-labs/catalyst/issues/54)) ([09a5503](https://github.com/coalesce-labs/catalyst/commit/09a5503810467565c00ed4ce87d6c52e01e97300))

## [5.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v5.1.0...catalyst-pm-v5.2.0) (2026-04-01)


### Features

* **dev,pm:** wiki-links and PM thoughts path restructuring ([#47](https://github.com/coalesce-labs/catalyst/issues/47)) ([fb32e36](https://github.com/coalesce-labs/catalyst/commit/fb32e3622619bfd317c02150565b107158d57746))

## [5.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v5.0.0...catalyst-pm-v5.1.0) (2026-03-25)


### Features

* **dev:** remove Railway integration, add /loop workflow monitoring ([#30](https://github.com/coalesce-labs/catalyst/issues/30)) ([d7df8f2](https://github.com/coalesce-labs/catalyst/commit/d7df8f261ae05abd528d54d695df340b83147d30))


### Bug Fixes

* **dev:** fix release-please pipeline + add health monitoring ([#32](https://github.com/coalesce-labs/catalyst/issues/32)) ([cd7054c](https://github.com/coalesce-labs/catalyst/commit/cd7054c591afad61d307a11456855ad397257de3))
* **dev:** upgrade linearis CLI and fix skill command syntax ([#41](https://github.com/coalesce-labs/catalyst/issues/41)) ([ffbc14c](https://github.com/coalesce-labs/catalyst/commit/ffbc14c487537bf70805880b39905643e0c56df5))

## [5.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v4.1.0...catalyst-pm-v5.0.0) (2026-03-20)


### ⚠ BREAKING CHANGES

* **pm:** remove research pipeline — migrated to writing plugin ([#19](https://github.com/coalesce-labs/catalyst/issues/19))
* Configuration must now be nested under 'catalyst' key

### Features

* add catalyst-pm plugin for Linear project management ([d2dc583](https://github.com/coalesce-labs/catalyst/commit/d2dc5830864009da17de35f9dfba9a591dce280d))
* **dev:** add agent-browser skill for browser automation ([#16](https://github.com/coalesce-labs/catalyst/issues/16)) ([651241b](https://github.com/coalesce-labs/catalyst/commit/651241bfe9f559fde0f6ae1566d8bed7e6616e94))
* **dev:** oneshot Linear states and config normalization ([#17](https://github.com/coalesce-labs/catalyst/issues/17)) ([c0881bb](https://github.com/coalesce-labs/catalyst/commit/c0881bb50337958a023d731bded913cf0d3f4993))
* implement config security and thoughts system enforcement ([b40bda8](https://github.com/coalesce-labs/catalyst/commit/b40bda89dbdd3213d3c5ece2866eec7f52c72f21))
* **linear:** add configurable stateMap for portable state transitions ([#15](https://github.com/coalesce-labs/catalyst/issues/15)) ([371e1d5](https://github.com/coalesce-labs/catalyst/commit/371e1d5dd7c196c2476c28eb873b367d072bb219))
* migrate to HumanLayer profiles and update PM agents to Opus ([#7](https://github.com/coalesce-labs/catalyst/issues/7)) ([1cdbcdd](https://github.com/coalesce-labs/catalyst/commit/1cdbcdd3487422817509b87dbaa9603ad005914b))
* **pm:** add context engineering adoption tracking dashboard ([53accc3](https://github.com/coalesce-labs/catalyst/commit/53accc3948f14f02d9c73da8bec63908bc13022c))
* **pm:** add foundational agents and report templates ([1e3a033](https://github.com/coalesce-labs/catalyst/commit/1e3a03397dd7c4eee169a55c62b8235a90c74852))
* **pm:** register all PM reporting commands in plugin.json ([02b6e5c](https://github.com/coalesce-labs/catalyst/commit/02b6e5cc9699949625cdfb8d9e45664177bf5fd0))
* **pm:** remove research pipeline — migrated to writing plugin ([#19](https://github.com/coalesce-labs/catalyst/issues/19)) ([31ff0e6](https://github.com/coalesce-labs/catalyst/commit/31ff0e6a1925502cdda525d4a157eaa80e411020))
* refresh workflow commands with new commands, model tiers, and agent teams ([#10](https://github.com/coalesce-labs/catalyst/issues/10)) ([10a010a](https://github.com/coalesce-labs/catalyst/commit/10a010a51126a8ad9485c37ae6fcb92a4156e8ee))


### Bug Fixes

* correct linearis CLI syntax across all agents and commands ([63ff171](https://github.com/coalesce-labs/catalyst/commit/63ff171dfabdc45c32c94b7e12c8c2aea95bcf06))
* **linearis:** correct --team flag docs and add UUID resolution ([#18](https://github.com/coalesce-labs/catalyst/issues/18)) ([050205c](https://github.com/coalesce-labs/catalyst/commit/050205cb0d207096efd3bf5a48bec2acc0c41566))
* remove invalid category field from catalyst-pm plugin manifest ([c9caea7](https://github.com/coalesce-labs/catalyst/commit/c9caea7af3839df2f0375448277ebf141d97a19a))
* use namespaced agent names in PM commands ([bdf3f8d](https://github.com/coalesce-labs/catalyst/commit/bdf3f8db97819d65a1225f18fe2361ee266f9636))


### Miscellaneous Chores

* bump versions for breaking config namespace change ([9a3f63b](https://github.com/coalesce-labs/catalyst/commit/9a3f63b70c119f7a019116788e6ba0c65b32aa04))

## [4.1.0](https://github.com/coalesce-labs/catalyst/compare/e494235...HEAD) (2026-03-10)

### ⚠ BREAKING CHANGES

* remove research pipeline — migrated to writing plugin ([#19](https://github.com/coalesce-labs/catalyst/pull/19))

### Removed

* research pipeline commands and agents — migrated to writing plugin v1.1.0 ([#19](https://github.com/coalesce-labs/catalyst/pull/19)) ([31ff0e6](https://github.com/coalesce-labs/catalyst/commit/31ff0e6))
  * `commands/deep_research.md`
  * `commands/verify_research.md`
  * `agents/citation-verifier.md`
  * `agents/external-researcher.md`
  * `agents/source-recoverer.md`
  * `agents/source-analyzer.md`
