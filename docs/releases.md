# Releases

Catalyst uses **Release Please** for automated per-plugin releases.

## How It Works

1. **Merge PRs to main** with conventional commit titles (`feat(dev):`, `fix(pm):`, etc.)
2. **Release Please opens release PRs** — one per affected plugin, accumulating changes
3. **Merge a release PR** to create: git tag, GitHub Release, updated CHANGELOG.md, bumped versions
4. **marketplace.json syncs automatically** via post-release CI step

## Version Source of Truth

| File | Purpose | Updated By |
|---|---|---|
| `plugins/<x>/version.txt` | Release Please primary version | Release Please |
| `plugins/<x>/.claude-plugin/plugin.json` | Plugin manifest | Release Please (extra-files) |
| `.claude-plugin/marketplace.json` | Marketplace registry | Post-release sync script |
| `plugins/<x>/CHANGELOG.md` | Per-plugin changelog | Release Please |

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

## Important

- Never manually edit `version.txt`, `plugin.json` versions, or the manifest
- Release Please manages all versions via conventional commits
- The `scripts/bump-version.sh` script has been removed — use Release Please
