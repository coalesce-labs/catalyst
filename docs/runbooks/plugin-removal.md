# Runbook — removing a whole plugin

**Worked example: CTL-2222 removed `catalyst-pm` (12 skills, PR merging this file).** Written as
the Tier A pilot (`thoughts/shared/plans/2026-08-25-CTL-2218.md`, Phase A) so A2–A4
(`catalyst-discovery`, `catalyst-meeting-hygiene` + `catalyst-analytics` + `catalyst-debugging`)
can execute without re-deriving this checklist. Follow it top to bottom; every step names the
exact file or command.

## 0. Preconditions — verify, don't assume

The facts below were true for CTL-2222 (2026-08-26) and may have moved by the time you run this.
**Re-verify each one yourself before you start; do not carry these specific claims forward.**

- **release-please is back (CTL-2263, reinstated after CTL-2220 removed it).** Both `release-please-config.json` and `.release-please-manifest.json` are real again — the config carries the full release-please schema (`release-type`, `component`, `extra-files`, …) and the manifest carries a `{"<plugin-dir>": "<version>"}` entry per released package. `scripts/packaging/cli.mjs`'s `readConfigPackageOrder()` still reads the config for plugin order, but you now edit **both** files when removing a plugin — see step 3. `scripts/check-plugin-manifest-parity.sh` fails the build if a manifest entry survives with no matching config package, so a removal that skips the manifest is caught in CI, not silently.
- **CTL-1461 (packaging Phase 7) is merged.** `scripts/packaging/core/inventory-guard.mjs` and
  `assertPluginInventoryAgreement` (called from `scripts/packaging/cli.mjs`) turn a mismatch between
  `release-please-config.json`'s package list and the actual `plugins/` tree into a **named render
  error**, not a silent drop or a crash. This means: if you delete a plugin directory without also
  dropping its `release-please-config.json` entry (or vice versa), `render` will fail loudly and
  tell you which. Do both edits in the same pass.
- **`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` are GENERATED.** Do not
  hand-edit either — `scripts/packaging/cli.mjs render --write` (step 5 below) regenerates both from
  the plugin directories that still exist on disk. If you edit them by hand, `packaging-gate.yml`'s
  drift check will flag it.

## 1. Check for cross-plugin dependencies before you delete anything

**This is the step most likely to surprise you.** A plugin being removed may contain
infrastructure — scripts, schemas, docs — that *other, surviving* plugins' skills actually invoke,
separate from the plugin's own `skills/` directory. CTL-2222 found this the hard way:
`catalyst-pm/scripts/estimate/*.ts` (a corpus-scoring toolchain) was referenced by
`plugins/dev/skills/compound-estimate/SKILL.md` and `plugins/dev/skills/phase-triage/SKILL.md` —
two `catalyst-dev` skills with no other connection to `catalyst-pm`.

Before deleting, run — same instrument as the reference sweep in §5 (absolute `/usr/bin/grep`,
never bare `grep`, plus a positive control proving it actually scanned the files it claims to):

```bash
mapfile -t FILES < <(git ls-files \
  | grep -v '^thoughts/' \
  | grep -v '^\.agents/skills/' \
  | grep -v '/\.codex-plugin/' \
  | grep -v '^scripts/packaging/dist/')

/usr/bin/grep -l -F -- "plugins/playground/<name>" "${FILES[@]}" 2>/dev/null | grep -v "^plugins/playground/<name>/"

# Positive control — prove the instrument fires on a file you KNOW references the plugin
# (its own pack.json, or a sibling plugin's "extracted from" changelog note):
/usr/bin/grep -l -F -- "plugins/playground/<name>" "${FILES[@]}" 2>/dev/null | grep "^plugins/playground/<name>/"
```

Every hit outside the plugin's own tree is a real dependency, not noise. For each one, decide:
**relocate** the depended-on file into the consuming plugin (e.g. `plugins/dev/scripts/<name>/`)
and fix the path in both the moved file's own internal comments and the consuming `SKILL.md`, or
**confirm it's a false positive** (a generic example string, a synthetic test fixture that never
touches the real filesystem — check whether the test resolves the string to a real path or just
validates JSON shape). Do the move with `git mv` so the diff reads as a rename, not a delete+add.

## 2. Delete the plugin

```bash
git rm -r plugins/playground/<name>
```

This takes the skills, `pack.json`, `.claude-plugin/plugin.json`, `.codex-plugin/` (including its
`.generated-by-catalyst-packaging` marker), `agents/`, `sub-agents/`, `templates/`, `README.md`,
`CHANGELOG.md`, and `version.txt` with it — everything under the plugin's directory that step 1
didn't relocate out.

## 3. release-please-config.json and .release-please-manifest.json

Drop the plugin's `"plugins/playground/<name>": {...}` entry from `release-please-config.json`'s
`packages` object. This is the step fact 0 above depends on — skip it and `render` (step 5) fails
with an inventory-agreement error naming the orphaned directory.

Also drop the plugin's `"plugins/playground/<name>": "<version>"` entry from `.release-please-manifest.json`. Skip this and `scripts/check-plugin-manifest-parity.sh` (run in step 7) fails with an orphaned-manifest-entry error — the config and manifest rosters must agree, so removal is a two-file edit, not one.

## 4. The removal checklist — files that reference a plugin by name

Check every one of these. Not all will have a hit for every plugin; report which did.

| File | What to look for |
| --- | --- |
| `README.md` | Install commands (`/plugin install catalyst-<name>`), enable examples, plugin-description bullets |
| `AGENTS.md` | The `plugin-name:skill-name` example, the commit-convention example, the "Valid scopes" list |
| `docs/architecture.md` | The "Plugin Source" bullet's example directory list |
| `docs/releases.md` | Any plugin-specific versioning callouts |
| `.serena/memories/codebase_map.md` | The "other plugins" directory list. ⚠️ No gate asserts on this file, and CTL-2235 missed it — a deleted plugin sat listed as live until a post-batch sweep caught it. Serena serves this map to agents for navigation, so a stale entry actively misdirects them. Check it by hand. |
| `website/astro.config.mjs` | The `plugins` changelog array |
| `website/src/content.config.ts` | The `changelogsLoader` entries array |
| `website/src/content/docs/reference/plugins.md` | The plugin table row + install command |
| `website/src/content/docs/getting-started/index.md` | The optional-plugins install block |
| `website/src/content/docs/reference/configuration.md` | Any "Used by" integration table row naming the plugin |
| `.claude/rules/skill-references.md` | The per-plugin invocation-prefix bullet list |
| `scripts/packaging/core/inventory-guard.mjs` | `REAL_PLUGIN_IDS` — a hardcoded roster this guard explicitly expects to be updated on a real deletion |
| `scripts/check-plugin-version.sh` | Only if it still hardcodes a `PLUGINS=(...)` array (it reads `release-please-config.json` dynamically as of CTL-2220 — verify it hasn't regressed before assuming you need to touch it) |
| `plugins/dev/scripts/setup-plugin-source.sh` | The `retire_catalyst_marketplace` empty-manifest fallback (`plugin_ids=(...)`) |
| `plugins/dev/scripts/execution-core/doctor.mjs` | The `marketplaceIds` empty-`expectedPlugins` fallback array |
| Any `plugins/dev/scripts/__tests__/*.test.sh` | Test cases using the plugin's real path as example data (harmless to leave, but retarget to a surviving plugin for cleanliness — e.g. `docs-gate.test.sh`'s changelog-path case) |
| `plugins/dev/prompts/` | A standalone kickoff/prompt file scoped entirely to the removed plugin (not linked from any `SKILL.md`, so the gates won't catch it — grep for the plugin's skill names) |

Skip anything not applicable and say so. `.release-please-manifest.json` is not in this table because it is covered by step 3 above, not this checklist — don't skip it there.

## 5. Reference sweep — with a positive control

Acceptance requires **zero** matches for the removed plugin's skills and a **proof the search
instrument itself works** (a negative result you can't distinguish from a broken grep is not
evidence). Two traps: bare `grep` on this machine may be aliased to `ugrep --ignore-files`, which
silently skips files — always call `/usr/bin/grep` by absolute path. And an unquoted shell array in
zsh will not word-split the way you expect — iterate a real bash array, or run the script with
`bash script.sh`, not as a zsh one-liner.

```bash
REMOVED_SKILLS=(skill-one skill-two ...)   # every skill the plugin carried

mapfile -t FILES < <(git ls-files \
  | grep -v '^thoughts/' \
  | grep -v '^\.agents/skills/' \
  | grep -v '/\.codex-plugin/' \
  | grep -v '^scripts/packaging/dist/')

for skill in "${REMOVED_SKILLS[@]}"; do
  for pat in "catalyst-<name>:${skill}" "skills/${skill}"; do
    /usr/bin/grep -l -F -- "$pat" "${FILES[@]}" && echo "FAIL: $pat"
  done
done

# Positive control — prove the instrument fires at all, using a SURVIVING skill:
/usr/bin/grep -l -F -- "catalyst-<surviving-plugin>:<surviving-skill>" "${FILES[@]}"
/usr/bin/grep -l -F -- "skills/<surviving-skill-with-a-known-prose-reference>" "${FILES[@]}"
```

Pick the second control pattern's skill carefully — bare `skills/<name>` path fragments don't
appear in prose for every skill (most only show up inside generated trees you've already excluded).
`create-plan` is a safe bet in this repo (referenced by path in
`plugins/dev/scripts/test-session-instrumentation.sh`); verify your choice fires before relying on
it. Paste both the zero-match block and the positive-control hits into the PR body — that pairing
*is* the evidence.

## 6. Render the packaging targets

```bash
bun scripts/packaging/cli.mjs render --write
```

**On current `main` this may fail with `FAILED: unacknowledged losses` even with no changes of
yours** — that gate (`core/loss.mjs`) is about pre-existing codex/agentsSkills degradations
unrelated to a plugin removal. Establish this *before* blaming your change:

```bash
# In a clean worktree of unmodified main:
bun scripts/packaging/cli.mjs render --write   # note the exit code and loss counts
# Then the same invocation on your branch:
bun scripts/packaging/cli.mjs render --write   # compare — loss counts should only go DOWN
                                                # (fewer skills = fewer possible losses), never up
```

If both fail the same way, use `--allow-losses` on your branch and say in the PR body that the
failure is pre-existing and cite the before/after loss counts as proof you introduced no new ones.
Do **not** reach for `--allow-losses` to hide a loss your own change introduced — that's exactly
what the flag's gate exists to catch.

**mtime positive control** — prove `render --write` actually rewrote files rather than skipping
them:

```bash
stat -f "%Sm %N" .claude-plugin/marketplace.json .agents/plugins/marketplace.json   # before
sleep 1
bun scripts/packaging/cli.mjs render --write --allow-losses
stat -f "%Sm %N" .claude-plugin/marketplace.json .agents/plugins/marketplace.json   # after — must differ
```

Then `git status --porcelain` must show only the expected diffs (the two marketplace.json files
losing the removed plugin's entries) — no untracked new files, no diffs outside what you touched
by hand.

## 6a. `packaging-gate`'s own hardcoded plugin count (easy to miss — not caught by §6)

`render --write` succeeding does **not** mean `bun test scripts/packaging/__tests__/` is green.
Three fixtures in that suite assert an exact plugin count as a literal integer, independent of the
render step above — a removal that changes the total plugin count fails them even when the render
diff itself is clean:

```
scripts/packaging/__tests__/cli-render.test.mjs:      expect(results.length).toBe(<N>);
scripts/packaging/__tests__/local-provider.test.mjs:  expect(pluginRelPaths.length).toBe(<N>);  (two tests)
scripts/packaging/__tests__/pack-manifest.test.mjs:   expect(pluginRelPaths.length).toBe(<N>);
```

Update all four assertions (and their test-title strings, which also spell out the count) to the
new total plugin count, then run `bun test scripts/packaging/__tests__/` locally and confirm
**0 fail** before opening the PR — this is what CI's `packaging-gate` job runs, and it is a
separate step from `render --write`. (`inventory-fixture.test.mjs` and `inventory-guard.test.mjs`
use a synthetic 2-plugin fixture, not the real count — don't touch those.)

## 7. Gates

Run before opening the PR: `skills-gate`, `audit-references`, `docs-gate`, `check-versions` (né
`check-plugin-version.sh`), `execution-core-tests`, `packaging-gate`, `gitleaks`, `agents-md-gate`,
plus the website build. `validate-release-config` **no longer exists** (removed by CTL-2220) — don't
go looking for it as a required check.

## 8. PR body

State: what was removed and why (cite the ticket), the before/after sweep output (both halves —
zero-match and positive-control), the render before/after loss counts if you hit the pre-existing
failure, and **uninstall/enable guidance for anyone with the plugin currently installed** — e.g.:

> If you have `catalyst-<name>` installed: `/plugin uninstall catalyst-<name>` (or `/plugin disable
> catalyst-<name>` if you'd rather keep the marketplace registration and just stop loading it).
> Reinstalling after this PR merges will fail — the plugin no longer exists in the marketplace
> catalog.

---

_Last CI-verified against this exact removal: 2026-08-26 (CTL-2222, PR #4035)._
