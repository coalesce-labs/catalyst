---
name: linearis-cli
description:
  Linear access rule + Linearis CLI reference. READS → query the local replica by direct SQL
  (`~/catalyst/catalyst-replica.db`); WRITES and list/search → the `linearis` CLI. Use when working with Linear tickets, cycles, projects, milestones, or ticket IDs like TEAM-123.
---

# Linearis CLI Reference

> Verified against Linearis v2026.4.9 (2026-05-31). ⚠️ **READ vs WRITE.** Linear **READS** → the
> local replica by direct SQL, or `linear_read_ticket <ID>`. **Never** shell `linearis issues
> read` for a routine read — it 429s the shared fleet quota. **WRITES** → `linearis`. Read
> [Gotchas](#gotchas--traps) before scripting.

## Reading Linear
> **Single source of the Linear read rule** — other skills point here, they don't restate it.

1. **Cloud detection, every session** — reuse the existing helpers, never write new ones:
   ```bash
   source "${CLAUDE_PLUGIN_ROOT:?}/scripts/lib/linear-read-replica.sh"
   replica_fresh; rf=$?                      # 0 = writer heartbeat <5min AND seeded
   source "${CLAUDE_PLUGIN_ROOT:?}/scripts/lib/plugin-dirs.sh"
   marker="$(plugin_dirs_repo_config_path)"  # "" if no .catalyst/config.json found
   ```
   Either failing → **no cloud mirror**: say so **loudly** (never silent) and fall back to direct
   `linearis`/API reads — the **non-fleet path** (protects the 2500/hr quota), wrong to recommend
   on the fleet. Same pattern: `steward`'s `references/cloud-detection.md`.
2. **Cloud mode confirmed → query the replica and TRUST it.** Don't re-verify against live Linear.
3. **Row missing / not fresh → an ALARM, not a silent reroute.** Loud fallback, file a ticket.

```bash
DB="${CATALYST_REPLICA_DB:-${CATALYST_DIR:-$HOME/catalyst}/catalyst-replica.db}"
sqlite3 -json "$DB" "SELECT identifier, title, state, estimate FROM issues
  WHERE identifier='ENG-123' AND removed_at IS NULL;"
json=$(linear_read_ticket ENG-123) || return 1   # freshness-gate → SQL → loud fallback, one call
```

Schema discovery, apply-drift caveat, deprecated wrapper: [`references/reading-linear-detail.md`](references/reading-linear-detail.md).

## Core Operations
Reads → direct SQL (above); writes always `linearis` — run `linearis usage` / `linearis <domain> usage` for authoritative, current flag syntax.

```bash
linearis issues search "auth bug" --team ENG --status "Todo"
linearis issues update ENG-123 --status "In Progress" --labels "bug" --label-mode add
```

> ⛔ **Agent comments → `linear-reply.mjs`, never `issues discuss`/`reply`** — those post AS THE
> HUMAN (personal token; ask-resolution gate reads that as the human deciding, CTL-1567).
```bash
direnv exec . node "$CLAUDE_PLUGIN_ROOT/scripts/linear-reply.mjs" ENG-123 --as <AGENT> --body-file <path> --top
#   --body-file <path>  for anything longer than a one-line body; --body REFUSES a path (CTL-2204)
```
`issues discussions <id>` (read-only) is safe. Full CRUD, comment-thread commands, common mistakes, other domains: [`references/core-operations.md`](references/core-operations.md).

## Workflow: Status Transitions
> **Single source of the Linear `stateMap` table** — `linear`, `create-plan`, `implement-plan`,
> `create-pr`, `research-codebase` point here; none restates it.

| Workflow Phase | Default State | Config Key |
| --- | --- | --- |
| New tickets | Backlog | `stateMap.backlog` |
| Acknowledged | Todo | `stateMap.todo` |
| Research / Planning started | In Progress | `stateMap.research` / `.planning` |
| Implementation | In Progress | `stateMap.inProgress` |
| PR created | In Review | `stateMap.inReview` |
| Completed / Canceled | Done / Canceled | `stateMap.done` / `.canceled` |

Names come from `.catalyst/config.json`'s `linear.stateMap` (`null` skips a transition). UUID calls + the team-key allowlist cache (`linear-team-keys.json`): [`references/status-transitions.md`](references/status-transitions.md).

## Gotchas & Traps
1. `issues list` **hides Done** (shows Canceled) — `--status "Done"`, or `issues read <ID>` for one.
2. `linearis` **consumes stdin** in a loop — append `</dev/null`.
3. **No `--json` flag** — JSON is the default; pipe to `jq`.
4. `--status` is server-side and **fails empty on a typo** — not an error; also deprecated `--query` (use `issues search`).
5. `--status`/`--cycle` require `--team`; `--milestone` requires `--project`; names collide across projects/teams.
6. `project-milestones` fails **silently** to the help dump — the domain is `milestones`.
7. `status`/`state` are zsh read-only vars (`st`/`s`/`lstate`); `auth status` is the diagnostic entry point when calls return nothing.

Cookbook, one topic per file: grooming/triage/stale sweeps — [`references/backlog-grooming.md`](references/backlog-grooming.md); milestone create/rename/audit — [`references/milestones.md`](references/milestones.md); labels + the cross-team same-name trap — [`references/labels.md`](references/labels.md); cycle review — [`references/cycles.md`](references/cycles.md).
