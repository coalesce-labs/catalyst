# Releases

Catalyst uses **Release Please** for automated per-plugin releases.

## How It Works

1. **Merge PRs to main** with conventional commit titles (`feat(dev):`, `fix(pm):`, etc.)
2. **Release Please opens release PRs** — one per affected plugin, accumulating changes
3. **Merge a release PR** to create: git tag, GitHub Release, updated CHANGELOG.md, bumped versions

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
- `.github/workflows/release-please.yml` — CI workflow

## Verifying Releases Work

1. Merge a PR with a conventional commit title (e.g., `feat(dev): add feature`)
2. Release Please should open a release PR within minutes
3. The release PR updates CHANGELOG.md and version files
4. Merging the release PR creates a git tag and GitHub Release

## How Commit Routing Works

Release-please routes commits to plugins by **file paths changed**, not by commit message scope:

- A commit touching `plugins/dev/` and `plugins/pm/` bumps **both** plugins, regardless of scope
- The `(scope)` in `fix(dev):` controls **changelog section headers**, not routing
- Squash merges work correctly — GitHub API provides the full file list
- Use the scope matching the primary plugin; cross-plugin changes still bump all affected plugins

## Important

- Never manually edit `version.txt`, `plugin.json` versions, or the manifest
- Release Please manages all versions via conventional commits
