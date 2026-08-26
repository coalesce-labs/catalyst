---
name: setup-catalyst
description:
  "Diagnose and fix Catalyst setup issues. Validates tools, database, config, OTel, direnv, the
  Catalyst Cloud replica mirror, and thoughts. Automatically fixes what it can — creates
  directories, initializes the database, sets WAL mode, runs migrations. Use for new installs,
  upgrades, or when something isn't working."
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit
---

# Setup Catalyst

Diagnose the full Catalyst environment, fix everything fixable, and verify the fixes worked.

## Phase 1: Diagnose

Locate and run the health check script:

```bash
source "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}/scripts/require-catalyst-dev.sh" \
    "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}" || exit 1
bash "${CATALYST_DEV_SCRIPTS}/check-setup.sh" 2>&1 || true
```

Categorize every warning/failure into **Auto-fixable**, **Needs user input**, or **Manual only**.

## Before trusting the replica: detect whether this host is cloud-mirrored

Some checks below (Linear workspace state, `botUserId`) read `~/catalyst/catalyst-replica.db`. Don't assume it's authoritative — probe presence + freshness (reuse the existing freshness-gate helper) and the opt-in runtime-config marker first, and fall back loudly when either is missing. This is a checked, recoverable assumption, not a silent one — full detection steps, the loud-fallback wording, and why the fallback is a non-fleet answer only: [references/cloud-detection.md](references/cloud-detection.md).

## Phase 2: Fix

For auto-fixable issues, fix them immediately — don't ask, just do it. These are safe, local, reversible operations. **Exception: thoughts/ repair is never a bare `mkdir`** — see below.

| Situation | Reference |
|---|---|
| Directories, database/WAL, thoughts symlink repair, CLI symlinks, config-template drift (CTL-489), house-rules seeding, dual-harness migration | [references/fix-table.md](references/fix-table.md) |
| Cloud replica mirror health — writer, token, freshness — and what replaced the old daemon proxy audit | [references/cloud-detection.md](references/cloud-detection.md) |
| Linear workspace scaffolding — workflow states, git automations, the app-actor self-echo guard | [references/linear-workspace.md](references/linear-workspace.md) |
| Everything that needs user input or is manual-only (tokens, direnv, Linear settings with no API surface) | [references/needs-user-input.md](references/needs-user-input.md) |
| Non-interactive / headless mode (CI, SSH, cron, `curl \| bash`) | [references/headless-mode.md](references/headless-mode.md) |

## Phase 3: Verify

Re-run the health check (fresh shell — re-resolve `CATALYST_DEV_SCRIPTS`) and the drift check:

```bash
source "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}/scripts/require-catalyst-dev.sh" \
    "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}" || exit 1
bash "${CATALYST_DEV_SCRIPTS}/check-setup.sh" 2>&1 || true
bash plugins/dev/scripts/check-config-drift.sh \
  --config .catalyst/config.json --template plugins/dev/templates/config.template.json
```

Compare before/after. Report: (1) what was fixed, with counts; (2) what still needs attention, with specific next steps; (3) overall status — e.g. `Fixed 4 issues automatically. Still needs attention: Linear API token, OTel stack.`

## Important

- **Always run the check script first** — don't guess what's wrong.
- **Fix silently** — auto-fixable issues are safe operations, don't ask permission for mkdir or sqlite3 pragmas.
- **Always verify after fixing** — run the check script a second time to confirm.
- **Never touch secrets** — don't write API tokens, credentials, or cloud account ids; just tell the user where to put them.
- **Idempotent** — safe to run multiple times, won't break anything that's already working.
