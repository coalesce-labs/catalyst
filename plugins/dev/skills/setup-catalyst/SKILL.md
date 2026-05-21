---
name: setup-catalyst
description:
  "Diagnose and fix Catalyst setup issues. Validates tools, database, config, OTel, direnv, and
  thoughts. Automatically fixes what it can — creates directories, initializes the database, sets
  WAL mode, runs migrations. Use for new installs, upgrades, or when something isn't working."
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit
---

# Setup Catalyst

Diagnose the full Catalyst environment, fix everything fixable, and verify the fixes worked.

## Phase 1: Diagnose

Locate and run the health check script:

```bash
SCRIPT=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-setup.sh" ]]; then
    SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/check-setup.sh"
elif [[ -f "plugins/dev/scripts/check-setup.sh" ]]; then
    SCRIPT="plugins/dev/scripts/check-setup.sh"
fi

bash "$SCRIPT" 2>&1 || true
```

Parse the output. Categorize every warning and failure into:

- **Auto-fixable** — can be fixed right now without user input
- **Needs user input** — requires API tokens, credentials, or decisions
- **Manual only** — requires tool installation or external action

## Phase 2: Fix

For auto-fixable issues, fix them immediately — don't ask, just do it. These are safe, local,
reversible operations.

**Exception: thoughts/ repair is NOT a bare `mkdir`.** The humanlayer thoughts system expects
`thoughts/shared` and `thoughts/global` to be **symlinks** into a central thoughts repo. A bare
`mkdir` over a clobbered symlink silently routes all subsequent agent writes to a non-syncing
local directory. Always route thoughts repair through `catalyst-thoughts.sh`, and treat a
regular-directory-where-a-symlink-should-be as **fatal** — surface the recovery command to the
user rather than overwriting anything.

| Issue | Fix |
|-------|-----|
| `~/catalyst/` missing | `mkdir -p ~/catalyst/{wt,events,history}` |
| `~/catalyst/wt/` missing | `mkdir -p ~/catalyst/wt` |
| `~/catalyst/events/` missing | `mkdir -p ~/catalyst/events` |
| Database missing or schema incomplete | Run `catalyst-db.sh init` (locating it the same way as the check script) |
| `schema_migrations` table missing | Run `catalyst-db.sh init` — it's idempotent |
| WAL mode not set | `sqlite3 ~/catalyst/catalyst.db 'PRAGMA journal_mode=WAL;'` |
| `thoughts/shared/<dir>` missing | Run `bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair` (re-uses humanlayer when configured; warns loudly when no thoughts repo is set up) |
| `~/.catalyst/bin/` missing OR any catalyst-* symlink absent/broken | Run `bash plugins/dev/scripts/install-cli.sh` — idempotent, safe to re-run. If `$HOME/.catalyst/bin` is not on `$PATH`, the script prints the exact line to add to `~/.zshrc` or `~/.bashrc` — relay that to the user so they can finish the one-time PATH setup. |
| `thoughts/shared` is a regular directory (not a symlink) | **Fatal — do not auto-fix.** Tell the user the humanlayer symlink was clobbered and show recovery: `mv thoughts/shared thoughts/shared.orphaned-$(date +%Y%m%d)` then `bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair` |
| Drift detected: keys present in `plugins/dev/templates/config.template.json` but missing from `.catalyst/config.json` (CTL-489) | Enumerate via `bash plugins/dev/scripts/check-config-drift.sh --json`. Generate a preview merge to a temp file via `--merge-into /tmp/merged.json` and show the user `diff -u .catalyst/config.json /tmp/merged.json`. On user confirmation, `jq` deep-merge into the real file: `bash plugins/dev/scripts/check-config-drift.sh --merge-into .catalyst/config.json.new && mv .catalyst/config.json.new .catalyst/config.json`. Merge preserves every existing user value (project on the right of jq's `*` recursive merge). |
| Profile drift between `.catalyst/config.json` and humanlayer mapping | Run `bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair` — it now auto-repairs drift by running `humanlayer thoughts uninit --force && humanlayer thoughts init --profile <config profile> --directory <config directory>`. (Plain `humanlayer thoughts init --force` does NOT update an existing repo→profile mapping, so the `uninit` step is required.) |

**Config-template drift (CTL-489).** When the template gains a key that an existing project's
`.catalyst/config.json` lacks (the original CTL-487 silent-fallback bug — catalyst itself ran in
`oneshot-legacy` for two months because `orchestration.dispatchMode` was absent), Phase 2 surfaces
a unified diff and asks for confirmation before merging. Concretely:

1. Run `bash plugins/dev/scripts/check-config-drift.sh --json --config .catalyst/config.json
   --template <template>` to enumerate missing leaves. The template path comes from
   `$CLAUDE_PLUGIN_ROOT/templates/config.template.json` in production, or
   `plugins/dev/templates/config.template.json` when dogfooding from the repo.
2. If the array is non-empty, generate a preview merge file via
   `bash plugins/dev/scripts/check-config-drift.sh --merge-into /tmp/merged.json` and show the user
   the unified diff: `diff -u .catalyst/config.json /tmp/merged.json`.
3. Ask: "Apply these template additions? [y/N]". Default is NO — drift is non-fatal and the
   warning will keep showing on subsequent workflow invocations until the user opts in.
4. On confirmation, write the merged file atomically to `.catalyst/config.json` (`mv` from a
   sibling `.tmp` file). The merge uses jq's `*` operator with the project on the right —
   existing values always win, missing keys are added.
5. The merge **never** overwrites existing user values. If the user has a custom
   `catalyst.filter.groqModel`, the template's default is NOT applied to that key.
6. If the user declines, leave `.catalyst/config.json` untouched. The drift warning continues to
   appear on subsequent workflow invocations, providing passive nagging until resolved.

**Execution-core state contract (CTL-564).** When a repo's
`catalyst.orchestration.dispatchMode` is `execution-core`, `setup-catalyst.sh`
runs an extra step — `setup_execution_core_states` — right after the Linear
workflow-state fetch. That step delegates to the standalone
`plugins/dev/scripts/setup-execution-core-states.sh`, which ensures the team's
contract workflow states exist (`Ready` + `Research`, `Plan`, `Implement`,
`Validate`, `PR`; `Triage` already exists), writes the 9-phase → 5-state
collapse `stateMap`, refreshes `stateIds`, and upserts the team's entry in the
central `~/catalyst/execution-core/registry.json`. The step is a silent no-op
for `phase-agents` / `oneshot-legacy` repos, and a Linear-permission failure in
the standalone script never aborts setup. The standalone script is also
idempotent and can be run directly per team (`setup-execution-core-states.sh
--config .catalyst/config.json [--dry-run] [--json]`).

For issues needing user input, explain what's needed and how to provide it:

| Issue | What to tell the user |
|-------|----------------------|
| Linear API token not set | Show the secrets file path, explain where to get the token from Linear settings |
| No project config | Suggest running `setup-catalyst.sh` or offer to create a minimal `.catalyst/config.json` interactively |
| direnv not installed | Show `brew install direnv` and the shell hook setup |

**Observability (OTel) is optional.** If Docker or OTel containers aren't found, note it as
informational — don't treat it as an issue. Point the user to
https://github.com/ryanrozich/claude-code-otel if they want to set it up.

## Phase 3: Verify

After fixing, run the health check script again:

```bash
bash "$SCRIPT" 2>&1 || true
```

Re-run the drift check independently to confirm zero remaining drift (CTL-489):

```bash
bash plugins/dev/scripts/check-config-drift.sh \
  --config .catalyst/config.json \
  --template plugins/dev/templates/config.template.json
```

Compare the before/after results. Report:

1. What was fixed (with counts)
2. What still needs attention (with specific next steps)
3. Overall status

## Output Format

```
── Catalyst Setup ──────────────────────────────

[Phase 1 output from check-setup.sh]

── Fixing Issues ───────────────────────────────
  ✅ Created ~/catalyst/events/
  ✅ Initialized session database
  ✅ Set WAL mode
  ✅ Created thoughts/shared/reports/

── Config Drift ────────────────────────────────
Detected 2 missing template keys:
  • catalyst.orchestration.dispatchMode → "phase-agents"
  • catalyst.filter.groqModel → "llama-3.1-8b-instant"

Preview diff:
  --- .catalyst/config.json
  +++ /tmp/merged.json
  +    "orchestration": { "dispatchMode": "phase-agents" },
  +    "filter": { "groqModel": "llama-3.1-8b-instant" },

Apply these template additions? [y/N] y
  ✅ Merged 2 keys into .catalyst/config.json (existing values preserved)

── Verification ────────────────────────────────

[Phase 3 output from check-setup.sh]

── Summary ─────────────────────────────────────
Fixed 4 issues automatically.

Still needs attention:
  • Linear API token — add to ~/.config/catalyst/config-<project>.json
  • OTel stack — run: docker compose up -d
```

## Important

- **Always run the check script first** — don't guess what's wrong
- **Fix silently** — auto-fixable issues are safe operations, don't ask permission for mkdir or
  sqlite3 pragmas
- **Always verify after fixing** — run the check script a second time to confirm
- **Never touch secrets** — don't write API tokens or credentials, just tell the user where to put
  them
- **Idempotent** — safe to run multiple times, won't break anything that's already working
