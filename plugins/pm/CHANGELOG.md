# Changelog

## [7.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v7.0.0...catalyst-pm-v7.1.0) (2026-06-03)


### Features

* **pm:** AI-native estimation tooling — corpus extractor, calibrated scorer, reference-class lookup (CTL-746) ([#1265](https://github.com/coalesce-labs/catalyst/issues/1265)) ([4f56000](https://github.com/coalesce-labs/catalyst/commit/4f5600069d1b6d7ed277b7fa6f689b85851529f3))

## [7.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v6.1.0...catalyst-pm-v7.0.0)

May 11, 2026

<!-- ai-enhanced -->

### Plugin Restructure & Meeting Hygiene

The bloated catalyst-pm plugin splits into four focused tools: catalyst-pm (12 strategy/PRD skills), catalyst-pm-ops (Linear integration and cadence), catalyst-meeting-hygiene (agenda through feedback workflows), and catalyst-discovery (research and prototyping). Skills moved to new plugin paths like `/catalyst-pm-ops:daily-plan` and `/catalyst-meeting-hygiene:meeting-notes`, so update any hardcoded references in your workflows.



### PRs

* **pm:** shrink catalyst-pm to 12 strategy/PRD skills (CTL-322) ([#543](https://github.com/coalesce-labs/catalyst/issues/543))
* **pm:** extract meeting workflow skills into catalyst-meeting-hygiene plugin (CTL-320) ([#541](https://github.com/coalesce-labs/catalyst/issues/541))
* **pm-ops:** extract Linear/cadence/comms skills from catalyst-pm (CTL-319) ([#537](https://github.com/coalesce-labs/catalyst/issues/537))
* **pm-ops:** extract Linear/cadence/comms skills from catalyst-pm (CTL-319) ([#537](https://github.com/coalesce-labs/catalyst/issues/537)) ([5a9c582](https://github.com/coalesce-labs/catalyst/commit/5a9c58279129349645997d0e7b20928f93b32c4a))
* **pm:** extract meeting workflow skills into catalyst-meeting-hygiene plugin (CTL-320) ([#541](https://github.com/coalesce-labs/catalyst/issues/541)) ([ba0c12a](https://github.com/coalesce-labs/catalyst/commit/ba0c12a19b881a325beb7029d47f1f3e8952596e))
* **pm:** shrink catalyst-pm to 12 strategy/PRD skills (CTL-322) ([#543](https://github.com/coalesce-labs/catalyst/issues/543)) ([43b1c89](https://github.com/coalesce-labs/catalyst/commit/43b1c89db5d7536a31a82918df8555b579e53f07))

## [7.0.0] — 2026-05-11

### ⚠ BREAKING CHANGES

catalyst-pm is now a focused **strategy and definition** plugin with 12 skills. 30 skills have moved to companion plugins:

- **12 skills → [catalyst-pm-ops](../pm-ops/README.md)**: `analyze-cycle`, `analyze-milestone`, `groom-backlog`, `create-tickets`, `sync-prs`, `daily-plan`, `weekly-plan`, `weekly-review`, `report-daily`, `status-update`, `slack-message`, `connect-mcps`
- **4 skills → [catalyst-meeting-hygiene](../meeting-hygiene/README.md)**: `meeting-agenda`, `meeting-notes`, `meeting-cleanup`, `meeting-feedback`
- **14 skills → [catalyst-discovery](../discovery/README.md)**: `user-interview`, `user-research-synthesis`, `interview-guide`, `journey-map`, `competitor-analysis`, `retention-analysis`, `activation-analysis`, `feature-metrics`, `experiment-metrics`, `experiment-decision`, `metrics-framework`, `prototype`, `prototype-feedback`, `napkin-sketch`

The following skills are permanently removed (not moved):
- `generate-ai-prototype` — subsumed by `prototype` in catalyst-discovery
- `interview-prep` — PM job-search tool, out of scope for project plugins
- `interview-feedback` — PM job-search tool, out of scope for project plugins
- `context-daily` — incomplete; dependencies (`github-metrics`, `thoughts-metrics`, `context-analyzer`) do not exist

7 support agents removed (only `linear-research` remains): `context-analyzer`, `github-metrics`, `thoughts-metrics`, `calendar-analyzer`, `health-scorer`, `code-classifier`, `linear-metrics`.

**Skills retained in catalyst-pm (12)**: `prd-draft`, `prd-review-panel`, `ralph-wiggum`, `define-north-star`, `impact-sizing`, `prioritize`, `write-prod-strategy`, `expansion-strategy`, `strategy-sprint`, `decision-doc`, `launch-checklist`, `feature-results`

### Upgrade path

Install the companion plugins to restore moved skills:

```bash
/plugin install catalyst-pm-ops
/plugin install catalyst-meeting-hygiene
/plugin install catalyst-discovery
```

## [6.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v6.0.3...catalyst-pm-v6.1.0)

Apr 25, 2026

<!-- ai-enhanced -->

### AI-Native Estimation Signal Schema

Foundation data contract for ticket estimation across all PM plugins. Every estimation skill now reads and writes the same `estimation:` YAML block with standardized fields for scope, confidence, methodology, and uncertainty modeling. Linear primitives (`Issue.estimate`, labels) mirror the schema for native filtering and burndown while YAML frontmatter remains the source of truth.



### PRs

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
