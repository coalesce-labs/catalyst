# Releases

Catalyst uses **Release Please** for automated per-plugin releases on a **daily cadence**.

## How It Works

1. **Merge PRs to main** with conventional commit titles (`feat(dev):`, `fix(pm):`, etc.)
2. **Release Please opens/updates a single aggregating Release PR** as commits land
   (`separate-pull-requests: false`, so one PR covers all affected plugins).
3. **A scheduled workflow merges the Release PR once a day** at 05:00 UTC (22:00 PT / 01:00 ET).
   Merging creates git tags, GitHub Releases, updated CHANGELOG.md, and bumped versions.
4. **Empty days skip**: if no PRs merged since the last release, no Release PR is open and the
   scheduled workflow exits 0 without cutting anything.

### Hotfix / urgent release

To cut a release before the next scheduled run, trigger the workflow manually:

```
gh workflow run release-please-scheduled-merge.yml
```

or via the GitHub Actions UI (`Run workflow` on `Release Please Scheduled Merge`).

### Intraday consumption (pre-release / early access)

`plugin.json.version` only changes when the Release PR merges (daily), so users installed via the
public Catalyst marketplace auto-update at most once per day. If you need merged-but-not-yet-
released commits — for example to dogfood changes between cuts — register a local checkout as a
dev marketplace:

```
git clone https://github.com/coalesce-labs/catalyst.git  # or use your existing checkout
bash scripts/install-dev-marketplace.sh                  # registers the local path as a marketplace
```

Run this from the main checkout, **not** a linked git worktree — the script refuses by default
from a worktree because it would freeze the installed plugin at that branch's HEAD. Pass
`--allow-worktree` to override.

#### Refreshing after `git pull`

Claude Code copies plugin files into a version-keyed cache at install time. A `git pull` does NOT
propagate to the cache automatically. Use one of the two supported flows below. (There is no
native live-read mode for `source: directory` marketplaces in Claude Code 2.1.118 —
see `thoughts/shared/research/2026-04-22-CTL-122-plugin-cache-live-read.md` for the full
investigation, including why symlinking the cache isn't the right default.)

**Standard refresh** — works when the daily release has bumped `plugin.json.version` (once per
day on average):

```
git -C /path/to/catalyst pull
claude plugin update catalyst-dev@catalyst     # repeat per plugin: -pm, -meta, -analytics, -debugging
# Restart Claude Code sessions to apply.
```

**Live-read escape hatch** — use during active feature development on a specific plugin, when
you want every `git pull` or local edit to propagate without a version bump:

```
claude --plugin-dir /path/to/catalyst/plugins/dev
# one --plugin-dir flag per plugin; bypasses all caching for the session
```

`--plugin-dir` is the official Claude Code dev mode. It's per-session (does not persist across
restarts) and takes precedence over any installed marketplace plugin of the same name.

To detect when a registered dev marketplace has drifted too far behind `origin/main`, run
`plugins/dev/scripts/check-marketplace-drift.sh` (CTL-121). It warns when a `source: directory`
entry is ≥5 commits or ≥24h behind.

A broader `next` branch + companion marketplace entry (auto-updating for anyone who opts in) is
designed but not yet implemented — see ADR-009 for tradeoffs and the planned follow-up.

## Version Source of Truth

| File | Purpose | Updated By |
|---|---|---|
| `plugins/<x>/version.txt` | Release Please primary version | Release Please |
| `plugins/<x>/.claude-plugin/plugin.json` | Plugin version (authoritative for Claude Code auto-updates) | Release Please (extra-files) |
| `.claude-plugin/marketplace.json` | Marketplace plugin registry (lists plugins, no versions) | Manual |
| `plugins/<x>/CHANGELOG.md` | Per-plugin changelog | Release Please |

### How Claude Code auto-updates work

1. At session start, Claude Code `git fetch`es the marketplace repo
2. Compares the stored commit SHA (in `installed_plugins.json`) against remote HEAD
3. If SHAs differ, reads `plugin.json` at the new commit and compares the `version` string
4. If the version changed → updates the plugin cache. Same version → skips (even if code changed)

The `version` field in `plugin.json` is the gate. Release Please bumps it via the `extra-files`
jsonpath config (`$.version`). The `marketplace.json` lists available plugins and their source
paths but does not carry per-plugin version fields.

## Commit Conventions

| Commit | Effect |
|---|---|
| `feat(dev): add new skill` | Minor bump for catalyst-dev |
| `fix(pm): correct cycle calculation` | Patch bump for catalyst-pm |
| `feat(dev)!: breaking change` | Major bump for catalyst-dev |
| `chore(meta): update docs` | No version bump |

Valid scopes: `dev`, `pm`, `meta`, `analytics`, `debugging`

## Tag Format

Tags follow `<component>-v<version>` format:

- `catalyst-dev-v5.0.0`
- `catalyst-pm-v5.0.0`
- `catalyst-meta-v3.0.0`

## Configuration

- `release-please-config.json` — Plugin paths, release types, extra-files
- `.release-please-manifest.json` — Current version for each plugin
- `.github/workflows/release-please.yml` — opens/updates Release PRs and enhances notes on every
  push to `main`
- `.github/workflows/release-please-scheduled-merge.yml` — cuts the daily release by merging the
  open Release PR at 05:00 UTC (also supports `workflow_dispatch` for manual cuts)

## Verifying Releases Work

1. Merge a PR with a conventional commit title (e.g., `feat(dev): add feature`)
2. Release Please should open/update the Release PR within minutes (label: `autorelease: pending`)
3. The Release PR accumulates changes throughout the day; AI-enhanced CHANGELOGs refresh on each
   push via `enhance-release-notes.sh`
4. At 05:00 UTC, the scheduled-merge workflow merges the Release PR → release-please fires again
   on the merge push and creates tags + GitHub Releases
5. To verify without waiting for the cron, run
   `gh workflow run release-please-scheduled-merge.yml`

## How Commit Routing Works

Release-please routes commits to plugins by **file paths changed**, not by commit message scope:

- A commit touching `plugins/dev/` and `plugins/pm/` bumps **both** plugins, regardless of scope
- The `(scope)` in `fix(dev):` controls **changelog section headers**, not routing
- Squash merges work correctly — GitHub API provides the full file list
- Use the scope matching the primary plugin; cross-plugin changes still bump all affected plugins

## Important

- Never manually edit `version.txt`, `plugin.json` versions, or the manifest
- Release Please manages all versions via conventional commits
