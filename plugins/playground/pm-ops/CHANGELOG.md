# Changelog

## [2.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-ops-v2.1.1...catalyst-pm-ops-v2.2.0)

Jun 30, 2026

<!-- ai-enhanced -->

### Uniform CLI Help Contract

Every user-facing `catalyst-*` CLI now responds to `-h`/`--help` with a real usage block and exits cleanly, and bare invocation prints usage to stderr with a non-zero exit. Tools like `catalyst-broker`, `catalyst-thoughts`, `catalyst-why`, and `workflow-context` previously fell through to error handling or ignored the flag entirely, giving coding agents inconsistent results when probing tool usage. No migration steps required.



### PRs

* **dev:** CTL-1383 — uniform -h/--help + bare-usage on user-facing catalyst-* CLIs ([#2459](https://github.com/coalesce-labs/catalyst/issues/2459)) ([0b137a8](https://github.com/coalesce-labs/catalyst/commit/0b137a8bc35a7aea467f7fb79044f62e07f4b727))

## [2.1.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-ops-v2.1.0...catalyst-pm-ops-v2.1.1) (2026-06-09)


### Bug Fixes

* **dev:** CTL-838 stop inferring dependencies from prose — link them, triage analyzes for missed ones ([#1556](https://github.com/coalesce-labs/catalyst/issues/1556)) ([cf29cf0](https://github.com/coalesce-labs/catalyst/commit/cf29cf038905006c9377dcf5095551bc029ed81e))

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
