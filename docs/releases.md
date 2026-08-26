# Releases

**CTL-2220 (2026-08-26): release-please was removed from this repo at Ryan's direct request.** There is no automated versioning or changelog generation today — see "Versioning (post release-please)" below for exactly what that means in practice, and the open decision it leaves unresolved.

## Versioning (post release-please)

- No workflow bumps `version.txt` or either `plugin.json`'s `$.version`, opens a release PR, cuts a git tag, creates a GitHub Release, or writes a CHANGELOG entry. All of that was release-please; none of it has a replacement.
- `scripts/check-plugin-version.sh` (the `check-versions` required PR check) still runs. It cannot bump anything — it only checks whether a plugin's files changed without its version changing, and if so, whether the branch's commits are conventional-commit-shaped. A conventional-commit message makes the check pass **without** touching the version; it is an escape hatch for the gate, not a signal that something downstream will bump the version later. If a change should ship a new version, bump `version.txt` and both `plugin.json` files by hand, in the same PR.
- Existing per-plugin `CHANGELOG.md` files (e.g. `plugins/dev/CHANGELOG.md`) are kept as historical record of what release-please generated while it was live. They are not maintained going forward by any automation.
- `scripts/packaging/cli.mjs render --write` (the vendor-neutral packaging pipeline — see `docs/specs/accepted/vendor-neutral-packaging/spec.md`) still never writes a version itself: its Claude emitter copies `$.version` verbatim from the existing file, and its Codex emitter seeds from the Claude manifest on create and fails on regenerate if the two disagree. That invariant is unchanged by this removal — the compiler reads and asserts a version, it was never the version's source.
- `scripts/check-plugin-manifest-parity.sh` (the `check-plugin-manifest-parity` required-adjacent PR check, CTL-2220) still runs on every PR. It has no release-please dependency — it directly compares the real `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` version values for every plugin, and checks that neither marketplace catalog carries a `version` field. This is the real-tree successor to the old `validate-release-config.sh` Checks 9–11 (deleted with the rest of that release-please-specific script); it exists precisely so that removing release-please's automation didn't also remove the only PR-time guard against the Claude and Codex manifests silently drifting apart.

**Open decision — no replacement was specified.** Ryan's removal request didn't name a replacement mechanism for automated versioning or changelog generation. Nothing here should be read as "hand-semver is the plan" or "this doesn't matter until someone brings it up" — it's an unresolved gap, tracked on CTL-2220.

## Version Source of Truth

| File | Purpose | Updated By |
|---|---|---|
| `plugins/<x>/version.txt` | Canonical version | Manual (no automation — see above) |
| `plugins/<x>/.claude-plugin/plugin.json` | Plugin version — gate for Claude Code auto-updates | Manual |
| `plugins/<x>/.codex-plugin/plugin.json` | Codex plugin version (CTL-1463) | Manual, kept in sync with the Claude manifest by `cli.mjs`'s regenerate-time equality check and `check-plugin-manifest-parity.sh`'s PR-time check |
| `plugins/<x>/CHANGELOG.md` | Per-plugin changelog | Historical only — not updated going forward |
| `.claude-plugin/marketplace.json` | Claude plugin registry (paths only, **no versions**) | Manual |
| `.agents/plugins/marketplace.json` | Codex plugin catalog (paths only, **no versions**) (CTL-1463) | Generated (`bun scripts/packaging/cli.mjs render --target codex --write`) |

The `version` field in `plugin.json` is the auto-update gate: at session start Claude Code fetches the marketplace repo, and if `plugin.json.version` at the new HEAD differs from the installed version, it refreshes the cache. Same version → skipped even if code changed.

## Commit Conventions

Conventional-commit messages are still expected — they're what `scripts/check-plugin-version.sh` looks for as its pass-without-a-manual-bump escape hatch (see above), and they keep history readable. See `AGENTS.md` → "Commit Conventions" for the format and valid scopes.

## `release-please-config.json`

This file still exists in the repo, but it is **no longer release-please's config** — release-please itself is removed. It has been stripped down to a plain `{"packages": {"<plugin-dir>": {"component": "<name>"}}}` roster of the 10 plugin directories, because `scripts/packaging/cli.mjs` (owned by the in-flight CTL-1461 packaging work, out of scope for this removal) hardcodes that exact filename as its plugin-order source, and `check-plugin-version.sh`/`check-plugin-manifest-parity.sh` read the same roster. Renaming or deleting it requires editing `scripts/packaging/cli.mjs`, which this ticket did not touch — see CTL-2220's PR body for the full reasoning, and CTL-2247 for the follow-up.

## Troubleshooting

There is no scheduled release job, release-health check, or release PR anymore — if plugin files changed and the `check-versions` PR check fails, see "Versioning (post release-please)" above. If the `check-plugin-manifest-parity` check fails, it means the Claude and Codex `plugin.json` versions (or a marketplace catalog's stray `version` field) actually disagree — fix the value, this check does not auto-correct anything.
