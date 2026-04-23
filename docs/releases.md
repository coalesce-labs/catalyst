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
released commits — for example to dogfood changes between cuts — point Claude Code at a local
checkout of this repo:

```
git clone https://github.com/coalesce-labs/catalyst.git  # or use your existing checkout
bash scripts/install-dev-marketplace.sh                  # registers the local path as a marketplace
```

Run this from the main checkout, **not** a linked git worktree — the script refuses by default
from a worktree because it would freeze the installed plugin at that branch's HEAD. Pass
`--allow-worktree` to override.

Afterwards, `git pull` in the checkout and restart Claude Code sessions to pick up the latest
`main`. See `scripts/install-dev-marketplace.sh` for details and for the `--plugin-dir` escape
hatch if caching surprises you.

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
