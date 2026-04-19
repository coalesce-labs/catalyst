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
| `thoughts/shared` is a regular directory (not a symlink) | **Fatal — do not auto-fix.** Tell the user the humanlayer symlink was clobbered and show recovery: `mv thoughts/shared thoughts/shared.orphaned-$(date +%Y%m%d)` then `bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair` |
| Profile drift between `.catalyst/config.json` and humanlayer mapping | Show the user: `humanlayer thoughts init --force --profile <profile from .catalyst/config.json> --directory <directory from .catalyst/config.json>` |

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
