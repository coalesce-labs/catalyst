# Changelog

## [6.13.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.12.0...catalyst-dev-v6.13.0) (2026-04-14)


### Features

* **dev:** add session labeling system to orch-monitor ([#105](https://github.com/coalesce-labs/catalyst/issues/105)) ([bf6c3f6](https://github.com/coalesce-labs/catalyst/commit/bf6c3f691b5971403fbe81ce62f3e82fbbcf3c22))

## [6.12.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.11.0...catalyst-dev-v6.12.0) (2026-04-14)


### Features

* **dev:** SSE event architecture for multiple frontends ([#111](https://github.com/coalesce-labs/catalyst/issues/111)) ([6433182](https://github.com/coalesce-labs/catalyst/commit/64331824c5a8ee4029becfe1fafdd0a19181a201))

## [6.11.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.10.0...catalyst-dev-v6.11.0) (2026-04-14)


### Features

* **dev:** instrument 6 skills with catalyst-session tracking ([#104](https://github.com/coalesce-labs/catalyst/issues/104)) ([5f537a6](https://github.com/coalesce-labs/catalyst/commit/5f537a6a0bb93abbee63a8fe19613d79e5303021))

## [6.10.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.9.0...catalyst-dev-v6.10.0) (2026-04-14)


### Features

* **dev:** SQLite reader and unified data source for orch-monitor (CTL-40) ([#101](https://github.com/coalesce-labs/catalyst/issues/101)) ([6bd8238](https://github.com/coalesce-labs/catalyst/commit/6bd8238f5ba3a7333170a9b9412ce01abbda365e))

## [6.9.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.8.0...catalyst-dev-v6.9.0) (2026-04-14)


### Features

* **dev:** catalyst-session lifecycle CLI (CTL-37) ([#100](https://github.com/coalesce-labs/catalyst/issues/100)) ([9b7fae2](https://github.com/coalesce-labs/catalyst/commit/9b7fae2b16535c66c97b8a76ba68fb57a9b9d32f))

## [6.8.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.7.0...catalyst-dev-v6.8.0) (2026-04-14)


### Features

* **dev:** SQLite session store for agent activity (CTL-36) ([#97](https://github.com/coalesce-labs/catalyst/issues/97)) ([74bb43d](https://github.com/coalesce-labs/catalyst/commit/74bb43d5a5e4e0be27bab79b2cdfadd4e2e5299b))

## [6.7.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.6.0...catalyst-dev-v6.7.0) (2026-04-14)


### Features

* **dev:** pre-assign Supabase migration numbers per wave (CTL-29) ([#95](https://github.com/coalesce-labs/catalyst/issues/95)) ([84a6f84](https://github.com/coalesce-labs/catalyst/commit/84a6f8471abd49879b0ffb56f4eeda897e96864f))

## [6.6.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.4...catalyst-dev-v6.6.0) (2026-04-14)


### Features

* **dev:** orchestrate fix-up worker + follow-up ticket recovery patterns (CTL-30) ([#93](https://github.com/coalesce-labs/catalyst/issues/93)) ([bfa9861](https://github.com/coalesce-labs/catalyst/commit/bfa9861b126d2163cae2d643b659237506ba40f7))

## [6.5.4](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.3...catalyst-dev-v6.5.4) (2026-04-14)


### Bug Fixes

* **dev:** orchestrator-owned poll-until-MERGED (CTL-31) ([#91](https://github.com/coalesce-labs/catalyst/issues/91)) ([2da8f69](https://github.com/coalesce-labs/catalyst/commit/2da8f697dafcf9c878bf3fd1760d90ca34ff44c1))

## [6.5.3](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.2...catalyst-dev-v6.5.3) (2026-04-14)


### Bug Fixes

* **dev:** worker worktrees get correct currentTicket + orchestration field ([#89](https://github.com/coalesce-labs/catalyst/issues/89)) ([4768eac](https://github.com/coalesce-labs/catalyst/commit/4768eac0b4cb87bf074088ca232b29cf72486836))

## [6.5.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.1...catalyst-dev-v6.5.2) (2026-04-13)


### Bug Fixes

* **dev:** add poll-until-merged loop and PR state verification ([#86](https://github.com/coalesce-labs/catalyst/issues/86)) ([666b835](https://github.com/coalesce-labs/catalyst/commit/666b8356ede7c4e1322a0f27bdb9f39c2921caea))

## [6.5.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.0...catalyst-dev-v6.5.1) (2026-04-13)


### Bug Fixes

* **dev:** DRY linearis CLI commands, fix setup false positive ([#84](https://github.com/coalesce-labs/catalyst/issues/84)) ([68115ac](https://github.com/coalesce-labs/catalyst/commit/68115acd8168e14683a4a079b0cc42b7f2a763b7))

## [6.5.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.4.2...catalyst-dev-v6.5.0) (2026-04-13)


### Features

* **dev:** add orch-monitor with live dashboard and analytics ([#82](https://github.com/coalesce-labs/catalyst/issues/82)) ([75f025a](https://github.com/coalesce-labs/catalyst/commit/75f025a88a411882a0f4be45b94033e681c8d27c))

## [6.4.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.4.1...catalyst-dev-v6.4.2) (2026-04-13)


### Bug Fixes

* **dev:** DRY linearis across all skills, fix direnv timing and [@me](https://github.com/me) bug ([#80](https://github.com/coalesce-labs/catalyst/issues/80)) ([58e0a7b](https://github.com/coalesce-labs/catalyst/commit/58e0a7b14a423429fbb6f2de244f1e2f930dc89d))

## [6.4.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.4.0...catalyst-dev-v6.4.1) (2026-04-13)


### Bug Fixes

* **dev:** tighten setup-orchestrate to zero-interaction ([#78](https://github.com/coalesce-labs/catalyst/issues/78)) ([2299917](https://github.com/coalesce-labs/catalyst/commit/229991717bb022beee8bcb19679519137c84a003))

## [6.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.3.0...catalyst-dev-v6.4.0) (2026-04-13)


### Features

* **dev:** add setup-orchestrate skill and inline worktree trust ([#76](https://github.com/coalesce-labs/catalyst/issues/76)) ([86b138e](https://github.com/coalesce-labs/catalyst/commit/86b138ecd8af0d8b1b674e2ebcbecc5d705d70a8))

## [6.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.2.0...catalyst-dev-v6.3.0) (2026-04-13)


### Features

* **dev:** add global orchestrator state, event log, and token tracking ([#70](https://github.com/coalesce-labs/catalyst/issues/70)) ([9f45afa](https://github.com/coalesce-labs/catalyst/commit/9f45afa0f85823f5fbeea6dd27d175ce00b1e1d2))
* **dev:** enforce post-PR monitoring and merge completion ([#74](https://github.com/coalesce-labs/catalyst/issues/74)) ([83b0ee2](https://github.com/coalesce-labs/catalyst/commit/83b0ee2b3fcc75b4149fce5aba5e1715d314557b))
* **dev:** update linearis skill for v2026.4.4 ([#72](https://github.com/coalesce-labs/catalyst/issues/72)) ([05237da](https://github.com/coalesce-labs/catalyst/commit/05237dabfb056f4dc9457af47d83dec12aa85c81))


### Bug Fixes

* **dev:** add fully-qualified plugin prefixes to skill references ([#69](https://github.com/coalesce-labs/catalyst/issues/69)) ([f9e69f2](https://github.com/coalesce-labs/catalyst/commit/f9e69f29ce7021997f4fba17b1c2bb88e1b62b69))
* **dev:** initialize workflow context and OTEL ticket early ([#73](https://github.com/coalesce-labs/catalyst/issues/73)) ([3406c30](https://github.com/coalesce-labs/catalyst/commit/3406c3099d1e6fcbf9604e9d66649e6e3fbd423e))

## [6.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.1.0...catalyst-dev-v6.2.0) (2026-04-11)


### Features

* **dev:** smart merge blocker diagnosis and review thread resolution ([#67](https://github.com/coalesce-labs/catalyst/issues/67)) ([ae74a74](https://github.com/coalesce-labs/catalyst/commit/ae74a749c9f1cd846fb91ba5124fb0db3685c17c))

## [6.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.0.0...catalyst-dev-v6.1.0) (2026-04-10)


### Features

* **dev:** add /orchestrate skill for parallel development ([#65](https://github.com/coalesce-labs/catalyst/issues/65)) ([d3f16d9](https://github.com/coalesce-labs/catalyst/commit/d3f16d93674c7322cba4a2aa076a622e08a9d854))

## [6.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.4.0...catalyst-dev-v6.0.0) (2026-04-10)


### ⚠ BREAKING CHANGES

* **dev:** migrate workflow state from .claude/ to .catalyst/ ([#63](https://github.com/coalesce-labs/catalyst/issues/63))

### Features

* **dev:** migrate workflow state from .claude/ to .catalyst/ ([#63](https://github.com/coalesce-labs/catalyst/issues/63)) ([114c7c4](https://github.com/coalesce-labs/catalyst/commit/114c7c47734574d552f932fa41902e5adb819283))

## [5.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.3.0...catalyst-dev-v5.4.0) (2026-04-09)


### Features

* **dev:** dev skills v2 — quality gates, new skills, and shipping enhancements ([#60](https://github.com/coalesce-labs/catalyst/issues/60)) ([70a2d8d](https://github.com/coalesce-labs/catalyst/commit/70a2d8d0dab401841fcc9acf26e4da9932edae57))

## [5.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.2.0...catalyst-dev-v5.3.0) (2026-04-04)


### Features

* **dev:** integrate Test-Driven Development (TDD) methodology across planning and implementation skills ([#50](https://github.com/coalesce-labs/catalyst/issues/50)) ([1083117](https://github.com/coalesce-labs/catalyst/commit/108311720eb59fed87570233a94abe748fc970b1))


### Bug Fixes

* **dev:** ensure workflow context is created and used properly ([#52](https://github.com/coalesce-labs/catalyst/issues/52)) ([b9cf5f5](https://github.com/coalesce-labs/catalyst/commit/b9cf5f5e30233bbabb5ff838a38c6f68328c18af))

## [5.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.1.1...catalyst-dev-v5.2.0) (2026-04-01)


### Features

* **dev,pm:** wiki-links and PM thoughts path restructuring ([#47](https://github.com/coalesce-labs/catalyst/issues/47)) ([fb32e36](https://github.com/coalesce-labs/catalyst/commit/fb32e3622619bfd317c02150565b107158d57746))

## [5.1.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.1.0...catalyst-dev-v5.1.1) (2026-03-25)


### Bug Fixes

* **dev:** upgrade linearis CLI and fix skill command syntax ([#41](https://github.com/coalesce-labs/catalyst/issues/41)) ([ffbc14c](https://github.com/coalesce-labs/catalyst/commit/ffbc14c487537bf70805880b39905643e0c56df5))

## [5.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.0.0...catalyst-dev-v5.1.0) (2026-03-23)


### Features

* **dev:** remove Railway integration, add /loop workflow monitoring ([#30](https://github.com/coalesce-labs/catalyst/issues/30)) ([d7df8f2](https://github.com/coalesce-labs/catalyst/commit/d7df8f261ae05abd528d54d695df340b83147d30))


### Bug Fixes

* **dev:** fix release-please pipeline + add health monitoring ([#32](https://github.com/coalesce-labs/catalyst/issues/32)) ([cd7054c](https://github.com/coalesce-labs/catalyst/commit/cd7054c591afad61d307a11456855ad397257de3))

## [5.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v4.2.0...catalyst-dev-v5.0.0) (2026-03-20)


### ⚠ BREAKING CHANGES

* Configuration must now be nested under 'catalyst' key

### Features

* automatic workflow context tracking + smart setup with token discovery ([53b3d38](https://github.com/coalesce-labs/catalyst/commit/53b3d389d7b633721d33d047ff70c31e8c006996))
* **dev:** add agent-browser skill for browser automation ([#16](https://github.com/coalesce-labs/catalyst/issues/16)) ([651241b](https://github.com/coalesce-labs/catalyst/commit/651241bfe9f559fde0f6ae1566d8bed7e6616e94))
* **dev:** add document lineage and reliable workflow context tracking ([#13](https://github.com/coalesce-labs/catalyst/issues/13)) ([b338ae8](https://github.com/coalesce-labs/catalyst/commit/b338ae81679fa620bd7f5e11fe02fe0f90096478))
* **dev:** add Linearis CLI skill for automatic syntax reference ([#8](https://github.com/coalesce-labs/catalyst/issues/8)) ([a9a9de1](https://github.com/coalesce-labs/catalyst/commit/a9a9de13be968a18273a08e583fd498d77ae52c2))
* **dev:** add project setup validation and strengthen command guardrails ([#12](https://github.com/coalesce-labs/catalyst/issues/12)) ([489518e](https://github.com/coalesce-labs/catalyst/commit/489518e726202dea4ede2f5f88c7a0bc5b1371b6))
* **dev:** oneshot Linear states and config normalization ([#17](https://github.com/coalesce-labs/catalyst/issues/17)) ([c0881bb](https://github.com/coalesce-labs/catalyst/commit/c0881bb50337958a023d731bded913cf0d3f4993))
* implement config security and thoughts system enforcement ([b40bda8](https://github.com/coalesce-labs/catalyst/commit/b40bda89dbdd3213d3c5ece2866eec7f52c72f21))
* **linear:** add configurable stateMap for portable state transitions ([#15](https://github.com/coalesce-labs/catalyst/issues/15)) ([371e1d5](https://github.com/coalesce-labs/catalyst/commit/371e1d5dd7c196c2476c28eb873b367d072bb219))
* migrate to HumanLayer profiles and update PM agents to Opus ([#7](https://github.com/coalesce-labs/catalyst/issues/7)) ([1cdbcdd](https://github.com/coalesce-labs/catalyst/commit/1cdbcdd3487422817509b87dbaa9603ad005914b))
* refresh workflow commands with new commands, model tiers, and agent teams ([#10](https://github.com/coalesce-labs/catalyst/issues/10)) ([10a010a](https://github.com/coalesce-labs/catalyst/commit/10a010a51126a8ad9485c37ae6fcb92a4156e8ee))
* restructure to 4-plugin architecture with session-aware MCP management ([08f1ec1](https://github.com/coalesce-labs/catalyst/commit/08f1ec1bdd552917c7d29ea8e917be1b8531342f))


### Bug Fixes

* add namespace prefixes to all slash command references ([099bec9](https://github.com/coalesce-labs/catalyst/commit/099bec9f024594545946dbf8cba78033eb5b0cf6))
* correct linearis CLI syntax across all agents and commands ([63ff171](https://github.com/coalesce-labs/catalyst/commit/63ff171dfabdc45c32c94b7e12c8c2aea95bcf06))
* correct plugin marketplace schema and enhance README ([89a8fe5](https://github.com/coalesce-labs/catalyst/commit/89a8fe5fd3e4d6e3d436f2b6694364c0776bd434))
* **dev:** add NO CLAUDE ATTRIBUTION sections to PR commands ([57ab404](https://github.com/coalesce-labs/catalyst/commit/57ab404e1aa40985ecf6b4785153e4ca9aac71b8))
* **dev:** add YAML frontmatter to /create_plan command template ([#9](https://github.com/coalesce-labs/catalyst/issues/9)) ([ddc75d0](https://github.com/coalesce-labs/catalyst/commit/ddc75d07abec68505bb74017db3ca178453cd9e5))
* **dev:** trim bloated research_codebase and create_plan commands ([#11](https://github.com/coalesce-labs/catalyst/issues/11)) ([4799f4c](https://github.com/coalesce-labs/catalyst/commit/4799f4c0849a471ffcdbe91606792bac83dc0edf))
* **linearis:** correct --team flag docs and add UUID resolution ([#18](https://github.com/coalesce-labs/catalyst/issues/18)) ([050205c](https://github.com/coalesce-labs/catalyst/commit/050205cb0d207096efd3bf5a48bec2acc0c41566))
* namespace all agent references with catalyst-dev prefix ([0168b91](https://github.com/coalesce-labs/catalyst/commit/0168b91ccb362134d299d141297204fe545a3f21))
* namespace subagent_type parameters in dev agents README ([0f3719e](https://github.com/coalesce-labs/catalyst/commit/0f3719e3994913717116e4df49b8c7758964867c))


### Miscellaneous Chores

* bump versions for breaking config namespace change ([9a3f63b](https://github.com/coalesce-labs/catalyst/commit/9a3f63b70c119f7a019116788e6ba0c65b32aa04))

## [4.2.0](https://github.com/coalesce-labs/catalyst/compare/e494235...HEAD) (2026-03-17)

### Features

* add agent-browser skill for browser automation ([#16](https://github.com/coalesce-labs/catalyst/pull/16)) ([651241b](https://github.com/coalesce-labs/catalyst/commit/651241b))
* oneshot Linear states and config normalization ([#17](https://github.com/coalesce-labs/catalyst/pull/17)) ([c0881bb](https://github.com/coalesce-labs/catalyst/commit/c0881bb))

### Bug Fixes

* **linearis:** correct --team flag docs and add UUID resolution ([#18](https://github.com/coalesce-labs/catalyst/pull/18)) ([050205c](https://github.com/coalesce-labs/catalyst/commit/050205c))
