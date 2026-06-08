# Changelog

## [2.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-ops-v2.0.1...catalyst-pm-ops-v2.1.0) (2026-06-08)


### Features

* **dev:** CTL-880 wire gherkin-ticket standard into ticket-creation skills ([#1508](https://github.com/coalesce-labs/catalyst/issues/1508)) ([4b21363](https://github.com/coalesce-labs/catalyst/commit/4b21363b49ea74853f701d2329e07f61cd23334d))

## [2.0.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-ops-v2.0.0...catalyst-pm-ops-v2.0.1) (2026-06-08)


### Bug Fixes

* **dev:** CTL-844 fresh-machine installer gaps — no-sudo, npm humanlayer, real gh CLI, bun required ([#1457](https://github.com/coalesce-labs/catalyst/issues/1457)) ([0c5e94d](https://github.com/coalesce-labs/catalyst/commit/0c5e94d851e4dd34066baecb9401035883852989))

## [2.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-ops-v1.0.0...catalyst-pm-ops-v2.0.0)

May 11, 2026

<!-- ai-enhanced -->

### PM Operations Plugin Split

The Linear/GitHub integration, daily cadence, and team communication skills have been extracted from catalyst-pm into a dedicated catalyst-pm-ops plugin. This gives you focused project management operations in a standalone package with 12 specialized skills and 4 agents. Skills that were at `/catalyst-pm:<name>` are now at `/catalyst-pm-ops:<name>` — update any shortcuts or CLAUDE.md references to use the new paths.



### PRs

* **pm-ops:** extract Linear/cadence/comms skills from catalyst-pm (CTL-319) ([#537](https://github.com/coalesce-labs/catalyst/issues/537))
* **pm-ops:** extract Linear/cadence/comms skills from catalyst-pm (CTL-319) ([#537](https://github.com/coalesce-labs/catalyst/issues/537)) ([5a9c582](https://github.com/coalesce-labs/catalyst/commit/5a9c58279129349645997d0e7b20928f93b32c4a))
* **pm-ops:** initial plugin — extracted from catalyst-pm ([CTL-319](https://linear.app/coalesce-labs/issue/CTL-319))
