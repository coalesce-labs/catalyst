# Changelog

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
