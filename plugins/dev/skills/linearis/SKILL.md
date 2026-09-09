---
name: linearis-cli
description:
  Linear access rule + Linearis CLI reference. READS → query the local replica by direct SQL (`~/catalyst/catalyst-replica.db`); WRITES and list/search → the `linearis` CLI. Use when working with Linear tickets, cycles, projects, milestones, or ticket IDs like TEAM-123.
---

# Linearis CLI Reference

> Verified against Linearis v2026.4.9 (2026-05-31). ⚠️ **READ vs WRITE.** Linear **READS** → the local replica by direct SQL, or `linear_read_ticket <ID>`. **Never** shell `linearis issues read` for a routine read — it 429s the shared fleet quota. **WRITES** → `linearis`. Read [Gotchas](#gotchas--traps) before scripting.

## Setup check (first, every session)

`bash "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh"` — the same gate `create-pr`/`merge-pr` run, and since CTL-2300 it also names every identity it could NOT resolve (tenant, human, team, cloud host). A write addressed to the wrong team or the wrong workspace does not error; it lands somewhere plausible, which is why this runs before the first read as well as the first write.

## Reading Linear
> **Single source of the Linear read rule** — other skills point here, they don't restate it.

1. **Cloud detection, every session** — reuse the existing helpers, never write new ones:
   ```bash
   source "${CLAUDE_PLUGIN_ROOT:?}/scripts/lib/linear-read-replica.sh"
   replica_fresh; rf=$?                      # 0 = writer heartbeat <5min AND seeded
   source "${CLAUDE_PLUGIN_ROOT:?}/scripts/lib/plugin-dirs.sh"
   marker="$(plugin_dirs_repo_config_path)"  # "" if no .catalyst/config.json found
   ```
   Either failing → **no cloud mirror**: say so **loudly** (never silent) and fall back to direct `linearis`/API reads — the **non-fleet path** (protects the 2500/hr quota), wrong to recommend on the fleet. Same pattern: `steward`'s `references/cloud-detection.md`.
2. **Cloud mode confirmed → query the replica and TRUST it.** Don't re-verify against live Linear.
3. **Row missing / not fresh → an ALARM, not a silent reroute.** Loud fallback, file a ticket.

**The only reads you should shell directly are through the helper — it is the freshness gate, not a convenience wrapper.** Never run a bare `sqlite3` query against the replica yourself: it skips the `$rf`/`$marker` checks above and can return stale data (or an empty DB) with no fallback.

```bash
json=$(linear_read_ticket ENG-123) || return 1   # freshness-gate → SQL → loud fallback, ONE call
title=$(printf '%s' "$json" | jq -r '.title // empty')
```

Raw SQL syntax (only after the helper's gate already ran), schema discovery, apply-drift caveat, deprecated wrapper: [`references/reading-linear-detail.md`](references/reading-linear-detail.md).

## Core Operations
Reads → direct SQL via the gated helper above; writes always `linearis` — run `linearis usage` / `linearis <domain> usage` for authoritative, current flag syntax. **`linear_read_ticket` covers a single ticket only** — a scope-wide list/search still goes through `linearis` (no bulk-query replica form yet; see [Reading Linear](references/reading-linear-detail.md#still-needs-linearis)).

```bash
state() { bash "$CLAUDE_PLUGIN_ROOT/scripts/linear-transition.sh" --print-state --transition "$1" --team "$TEAM"; }  # ⛔ never TYPE a stage name
linearis issues search "auth bug" --team "$TEAM" --status "$(state todo)"
linearis issues update ENG-123 --status "$(state inProgress)" --labels "bug" --label-mode add
```

> ⛔ **Agent comments → `linear-reply.mjs`, never `issues discuss`/`reply`** — those post AS THE HUMAN (personal token; ask-resolution gate reads that as the human deciding, CTL-1567).
```bash
direnv exec . node "$CLAUDE_PLUGIN_ROOT/scripts/linear-reply.mjs" ENG-123 --as <AGENT> --body-file <path> --top
#   --body-file <path>  for anything longer than a one-line body; --body REFUSES a path (CTL-2204)
```
`issues discussions <id>` (read-only) is safe. Full CRUD, comment-thread commands, common mistakes, other domains: [`references/core-operations.md`](references/core-operations.md).

## Workflow: Status Transitions
> **Single source of the Linear `stateMap` table** — `linear`, `create-plan`, `implement-plan`, `create-pr`, `research-codebase` point here; none restates it.

⛔ **A stage is addressed by SLOT, never by name (CTL-2300).** The table below deliberately has no column of stage names: a tenant renames its stages freely — CTC-1597 renamed one mid-flight — and this repo's own board calls `inProgress` something other than "In Progress" today. Resolve the slot with `linear-transition.sh --print-state --transition <slot> --team <KEY>`, which walks the one resolution chain (per-project `stateMap` → global `stateMap` → registry `triageStatus` → bootstrap) and REFUSES rather than substituting our word when a tenant declares a `stateMap` without the slot. The reason this matters more than it looks: `--status` is server-side and **fails empty on a typo** (Gotcha 1) — a name the board does not have returns an empty list, not an error.

| Workflow Phase | Slot (config key) |
| --- | --- |
| New tickets | `stateMap.backlog` |
| Acknowledged | `stateMap.todo` |
| Research / Planning started | `stateMap.research` / `.planning` |
| Implementation | `stateMap.inProgress` |
| Verify / Review phase | `stateMap.verifying` / `.reviewing` |
| PR created | `stateMap.inReview` |
| Completed / Canceled | `stateMap.done` / `.canceled` |

Names come from `.catalyst/config.json`'s `linear.stateMap` (`null` skips a transition); the canonical bootstrap for a repo that declares none is `scripts/lib/tenant-contract.default.json`. UUID calls + the team-key allowlist cache (`linear-team-keys.json`): [`references/status-transitions.md`](references/status-transitions.md).

## Gotchas & Traps
1. `issues list` **hides the done stage** (shows the canceled one) — pass `--status "$(state done)"`, or `issues read <ID>` for one.
2. `linearis` **consumes stdin** in a loop — append `</dev/null`.
3. **No `--json` flag** — JSON is the default; pipe to `jq`.
4. `--status` is server-side and **fails empty on a typo** — not an error; also deprecated `--query` (use `issues search`).
5. `--status`/`--cycle` require `--team`; `--milestone` requires `--project`; names collide across projects/teams.
6. `project-milestones` fails **silently** to the help dump — the domain is `milestones`.
7. `status`/`state` are zsh read-only vars (`st`/`s`/`lstate`); `auth status` is the diagnostic entry point when calls return nothing.

Cookbook, one topic per file: grooming/triage/stale sweeps — [`references/backlog-grooming.md`](references/backlog-grooming.md); milestone create/rename/audit — [`references/milestones.md`](references/milestones.md); labels + the cross-team same-name trap — [`references/labels.md`](references/labels.md); cycle review — [`references/cycles.md`](references/cycles.md).
