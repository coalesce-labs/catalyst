# Releases

Catalyst uses **Release Please** for automated per-plugin releases on a **daily cadence**.

## How It Works

1. Merge PRs to `main` with conventional commit titles (`feat(dev):`, `fix(pm):`, etc.).
2. Release Please opens/updates **a single aggregating Release PR** as commits land (`separate-pull-requests: false` → one PR covers all affected plugins).
3. A scheduled workflow merges the Release PR **once a day at 05:00 UTC** (22:00 PT / 01:00 ET). Merging creates git tags, GitHub Releases, updated CHANGELOGs, and bumped versions.
4. Empty days skip: with no merged PRs since the last release, no Release PR is open and the scheduled workflow exits 0.

### Hotfix / urgent release

Trigger the scheduled-merge workflow manually (`workflow_dispatch`):

```
gh workflow run release-please-scheduled-merge.yml
```

### Intraday consumption (pre-release)

`plugin.json.version` only changes when the Release PR merges (daily), so marketplace installs auto-update at most once per day. To dogfood merged-but-not-yet-released commits, register a local checkout as a dev marketplace:

```
bash scripts/install-dev-marketplace.sh   # registers the local path as a marketplace
```

Run from the **main checkout, not a linked worktree** — the script refuses from a worktree (it would freeze the plugin at that branch's HEAD; CTL-120). Pass `--allow-worktree` to override.

#### Refreshing after `git pull`

Claude Code copies plugin files into a version-keyed cache at install time; `git pull` does NOT propagate to the cache. Two supported flows:

- **Standard** (after the daily release bumped `plugin.json.version`): `git -C <repo> pull` then `claude plugin update <plugin>@catalyst` per plugin, then restart.
- **Live-read** (active dev on one plugin, every edit propagates without a version bump): `claude --plugin-dir <repo>/plugins/<x>` — the official per-session dev mode, takes precedence over the installed plugin, does not persist across restarts.

There is no native live-read for `source: directory` marketplaces (see `thoughts/shared/research/2026-04-22-CTL-122-plugin-cache-live-read.md`). To detect a drifted dev marketplace, run `plugins/dev/scripts/check-marketplace-drift.sh` (CTL-121) — warns at ≥5 commits (`DRIFT_COMMIT_THRESHOLD`) or ≥24h (`DRIFT_AGE_HOURS`) behind `origin/main`.

A `next` branch + auto-updating companion marketplace is designed but not built — see ADR-009.

## Version Source of Truth

| File | Purpose | Updated By |
|---|---|---|
| `plugins/<x>/version.txt` | Canonical version (`release-type: simple`) | Release Please |
| `plugins/<x>/.claude-plugin/plugin.json` | Plugin version — gate for Claude Code auto-updates | Release Please (`extra-files` jsonpath `$.version`) |
| `plugins/<x>/.codex-plugin/plugin.json` | Codex plugin version (CTL-1463) | Release Please (`extra-files` jsonpath `$.version`) |
| `plugins/<x>/CHANGELOG.md` | Per-plugin changelog | Release Please |
| `.claude-plugin/marketplace.json` | Claude plugin registry (paths only, **no versions**) | Manual |
| `.agents/plugins/marketplace.json` | Codex plugin catalog (paths only, **no versions**) (CTL-1463) | Generated (`bun scripts/packaging/cli.mjs render --target codex --write`) |

The `version` field in `plugin.json` is the auto-update gate: at session start Claude Code fetches the marketplace repo, and if `plugin.json.version` at the new HEAD differs from the installed version, it refreshes the cache. Same version → skipped even if code changed.

**CTL-1463 invariant**: release-please writes BOTH `plugin.json` files' `$.version` in the same commit, via two `extra-files` entries per package — the Claude and Codex manifests can never drift because they are never bumped separately. `scripts/packaging/cli.mjs` (the vendor-neutral packaging pipeline — see `docs/specs/accepted/vendor-neutral-packaging/spec.md`) never writes a version itself: its Claude emitter copies `$.version` verbatim from the existing file, and its Codex emitter seeds from the Claude manifest on create and FAILS on regenerate if the two disagree. The compiler reads and asserts a version; it is never the version's source. `.codex-plugin/` and `.agents/plugins/` are **generated, gitattributes-marked** trees — never hand-edited — regenerated with `bun scripts/packaging/cli.mjs render --target <claude|codex|agentsSkills> --write`.

## Commit Conventions

| Commit | Effect |
|---|---|
| `feat(dev): …` | Minor bump (catalyst-dev) |
| `fix(pm): …` | Patch bump (catalyst-pm) |
| `feat(dev)!: …` | Major bump (catalyst-dev) |
| `chore(meta): …` | No version bump |

Scopes (one per plugin): `dev`, `pm`, `meta`, `analytics`, `debugging`, `pm-ops`, `meeting-hygiene`, `discovery`, `legacy`, `foundry`.

**Routing is by file paths changed, not scope.** A commit touching `plugins/dev/` and `plugins/playground/pm/` bumps **both** plugins regardless of scope; the `(scope)` only sets the changelog section header. Squash merges work (GitHub API supplies the full file list). Use the scope of the primary plugin.

## Tags

Format `<component>-v<version>`, e.g. `catalyst-dev-v12.14.0`.

## Configuration

- `release-please-config.json` — plugin paths, `release-type: simple`, components, extra-files
- `.release-please-manifest.json` — current version per plugin
- `.github/workflows/release-please.yml` — opens/updates Release PRs + enhances notes on every push to `main` (and `workflow_dispatch`)
- `.github/workflows/release-please-scheduled-merge.yml` — merges the open Release PR at 05:00 UTC (also `workflow_dispatch`)

## Troubleshooting

- The open Release PR (label `autorelease: pending`, find via `gh pr list --label "autorelease: pending"`) is the authoritative summary of what's pending. AI-enhanced CHANGELOGs refresh on each push via `scripts/enhance-release-notes.sh`.
- In `release-please.yml` logs, `✔ No user facing commits found since <sha> - skipping` is **per-plugin**: that plugin had no `feat:`/`fix:`/`perf:` commits under its `plugins/<x>/` paths since its last tag. `<sha>` is that plugin's last-release SHA (two plugins bootstrapped together can share it).
- For stuck releases run `bash scripts/check-release-health.sh` (also daily via `release-health.yml`) — reports `UNHEALTHY` only when releasable commits exist with no open release PR.

> Never hand-edit `version.txt`, `plugin.json` versions, or the manifest — Release Please owns them.
