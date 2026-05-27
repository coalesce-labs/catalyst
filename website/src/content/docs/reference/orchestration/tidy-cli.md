---
title: Audit & cleanup CLI (catalyst-execution-core)
description:
  Operator-facing audit and reaping CLI built into the execution-core daemon manager — finds and
  cleans up leaked `claude --bg` sessions, worktrees, and branches. Every prune defaults to
  dry-run.
sidebar:
  order: 7
---

`catalyst-execution-core` is the management binary for the **execution-core daemon** — the
long-lived machine-level process that composes the Todo-state monitor, the pull-loop scheduler, and
the recovery contract, then directory-watches the enrollment records that
`/catalyst-dev:orchestrate` writes in execution-core dispatch mode.

The same binary also hosts the **audit & cleanup CLI** added by CTL-649. Phase-agent runs dispatch
one short-lived `claude --bg` job per phase, and those jobs — along with their worktrees and
branches — can leak: a `--bg` session persists idle long after its phase completes, a worktree
outlives a merged PR, a branch lingers after its worktree is gone. The audit CLI exists to make
that leak class **discoverable and reapable**:

- `sessions` — inventory and reap leaked `claude --bg` sessions.
- `worktrees` — inventory and clean up orphaned/merged worktrees.
- `branches` — inventory and delete merged or orphaned branch refs.
- `tidy` — the umbrella that runs all three in the only safe order.

The binary needs no new wrapper symlink or launchd plist — the audit nouns live inside
`catalyst-execution-core` itself and dispatch to `execution-core/cli/<noun>.mjs` via whichever of
`bun`/`node` is on `PATH`.

## Quick start

Always start with a dry run. It mutates nothing and prints exactly what a real prune would touch:

```bash
catalyst-execution-core tidy --dry-run
```

When the plan looks right, commit to it with `--yes`:

```bash
catalyst-execution-core tidy --yes
```

You can also audit one resource type at a time — `list` is always read-only:

```bash
catalyst-execution-core sessions list
catalyst-execution-core worktrees list
catalyst-execution-core branches list
```

## Safety model

:::danger[Every prune defaults to dry-run]
No prune subcommand mutates anything unless you pass `--yes`. The live condition is
`--yes AND NOT --dry-run` — so `--dry-run` always wins, and a bare `prune` (or `tidy`) only prints a
plan. The summary line ends in `planned (dry-run)` until you opt in.
:::

Additional guardrails baked into every path:

- **Interactive-session protection.** `claude agents --json` reports each session's `.kind` as
  `interactive` (a window you opened in your own terminal) or `background` (a `claude --bg` phase
  worker). The periodic orphan reaper and `sessions prune` only ever reap `background` sessions —
  interactive sessions are **never** reaped by default. This is the *primary* protection for your
  own windows, and it is stronger than the self-session guard below: the kind filter spares **every**
  interactive session you have open, whereas the self-session guard only covers the single
  controlling session the CLI happens to be running inside. Opt in with `--include-interactive`
  (off by default) only when you deliberately want interactive rows in scope.
- **Recency / minimum-idle threshold.** The orphan reaper and `sessions prune` will not reap a
  session whose LAST_SEEN (now − transcript-JSONL mtime, i.e. how recently it was active) is below a
  minimum-idle threshold — **default 900 seconds / 15 min** — even when it is classified
  DONE/ORPHAN/DUPLICATE. A recently-touched session is treated as in use. Tune with
  `--min-idle-seconds <N>` (config key `catalyst.orchestration.orphanReaper.minIdleSeconds`).
- **Self-session protection.** `sessions prune` reads `$CLAUDE_CODE_SESSION_ID` and will never reap
  the session the CLI is running inside. It logs `skipping self-session <id> (controlling session)`
  and moves on. Note this only covers the one controlling session — the kind filter above is what
  protects your *other* interactive windows.
- **`--yes` is mandatory to act.** There is no other "confirm" flag and no interactive prompt — this
  is a non-interactive operator tool.
- **`--force` gates destructive branch deletes.** `branches prune` only deletes merged refs by
  default. Unmerged classes (`ORPHAN_LOCAL`, `STALE_REMOTE`, `CLOSED_NO_MERGE`) are skipped unless
  you add `--force`, because they may carry commits that never landed.
- **`--max` caps the blast radius.** Each prune stops after N planned actions (the cap applies to
  the dry-run plan too, so what you preview is what you get).
- **Reaper indirection for sessions & worktrees.** `sessions` and `worktrees` prune never call
  `claude stop`, `git worktree remove`, or `git branch -D` directly — they emit **reap-intent
  events** into the unified event log (`~/catalyst/events/YYYY-MM.jsonl`), and the daemon's reaper
  performs the actual stop/removal through a single executor seam. (`branches` is the exception — see
  below.)

## Daemon lifecycle

These verbs manage the daemon **process**, distinct from `/catalyst-dev:orchestrate --stop`, which
only deregisters a single project. The model is the same nohup + PID-file pattern as
`catalyst-broker`.

```bash
catalyst-execution-core daemon start
catalyst-execution-core daemon stop
catalyst-execution-core daemon restart
catalyst-execution-core daemon probe
catalyst-execution-core daemon status
```

For operator muscle memory, the five verbs are also accepted as **backcompat top-level aliases** —
`catalyst-execution-core start` is identical to `catalyst-execution-core daemon start`, and likewise
for `stop`, `restart`, `probe`, and `status`.

| Verb      | What it does                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `start`   | Starts the daemon in the background (idempotent — no-ops if already running). Resolves `bun` then `node`.    |
| `stop`    | Sends `SIGTERM`, waits up to ~3s, then `SIGKILL` if still alive, and removes the PID file.                   |
| `restart` | `stop` then `start`. Also re-applies OTEL env hygiene by re-warming a fresh daemon.                          |
| `probe`   | Silent. Exits `0` if the daemon is running, non-zero otherwise — for scripting.                             |
| `status`  | Prints `running (pid N)` or `stopped`.                                                                       |

**PID and log location.** By default the daemon writes its PID file to
`~/catalyst/execution-core/daemon.pid` and its log to `~/catalyst/execution-core/daemon.log`.
Override with `EXECUTION_CORE_PID_FILE` / `EXECUTION_CORE_LOG_FILE` (and `CATALYST_DIR` to relocate
the whole `~/catalyst` root). PID-file presence means "process up" — the
`execution-core daemon started` log line is the fully-booted signal.

## `sessions`

Inventories live `claude --bg` sessions by joining `claude agents --json` (the authoritative live
source), the per-run worker signal files (`workers/<ticket>/phase-<phase>.json` across all runs), a
single `ps` snapshot for RSS attribution, and an optional Linear-state cache. Prune emits one
`phase.abort.reap-requested` intent per prunable row and lets the daemon's reaper do the work.

### Subcommands

| Subcommand        | Description                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| `list`            | Read-only classified inventory (table, or JSON with `--json`).                    |
| `show <ticket>`   | Detail (JSON) for a single ticket's sessions.                                     |
| `prune`           | Emit reap intents for prunable rows. Dry-run unless `--yes`.                      |

### Flags

| Flag              | Applies to          | Meaning                                                                  |
| ----------------- | ------------------- | ------------------------------------------------------------------------ |
| `--json`          | `list`              | Emit the inventory as JSON instead of the table.                         |
| `--ticket <X>`    | `list` / `prune`    | Scope to a single ticket. (`show` takes the ticket as a positional arg.) |
| `--phase <Y>`     | `list` / `prune`    | Scope to a single phase.                                                 |
| `--yes`           | `prune`             | Actually emit reap intents. Without it, prune is a dry-run.              |
| `--dry-run`       | `prune`             | Force dry-run even with `--yes`. Plan only.                              |
| `--max <N>`       | `prune`             | Cap planned reaps (default `20`).                                        |
| `--include-idle`  | `prune`             | Also reap `IDLE` rows (opt-in — an idle session may be between turns).   |
| `--include-interactive` | `prune`       | Also reap `interactive` sessions (opt-in — off by default; these are your own terminal windows). |
| `--min-idle-seconds <N>` | `prune`      | Skip any session whose LAST_SEEN is below `N` seconds (default `900`). A recently-active session is left alone even if classified DONE/ORPHAN/DUPLICATE. |
| `--categories <L>`| `prune`             | Comma-separated classification list to act on, overriding the default.   |

### Classification taxonomy

Each session is classified by the priority chain **DONE → ORPHAN → IDLE → UNKNOWN → KEEP**, with
`DUPLICATE` applied afterward across siblings in the same `ticket|phase` group.

| Class       | Meaning                                                                                     | Pruned by default? |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------ |
| `KEEP`      | Live worker, intact cwd, has a signal — a healthy in-flight job.                            | No                 |
| `DUPLICATE` | A non-canonical sibling in a `ticket\|phase` group (an older `KEEP`/`IDLE` than the newest).| Yes                |
| `IDLE`      | Has a signal and an intact cwd, but `claude agents` reports it idle.                         | No (opt-in via `--include-idle`) |
| `UNKNOWN`   | A live session with an intact cwd but **no** matching worker signal.                        | No                 |
| `ORPHAN`    | The session's cwd no longer exists on disk — its worktree was removed out from under it.    | Yes                |
| `DONE`      | The worker signal is in a terminal state — the phase finished but the session lingers.      | Yes                |

Alongside the class, each `list` row surfaces three more columns: `KIND` (`interactive` or
`background`, from `claude agents --json`), `AGE` (now − `startedAt`, how long ago the session was
created), and `LAST_SEEN` (now − transcript-JSONL mtime, how recently it was active). `interactive`
rows are still **shown** in the inventory but are tagged protected and excluded from prune by
default — only `--include-interactive` pulls them in. Taken together with the recency guard, the
effective default auto-reap set is now **`background` + `{DONE, ORPHAN, DUPLICATE}` + LAST_SEEN past
the `--min-idle-seconds` threshold** — a background, terminal/orphaned/duplicate session that has
also been idle long enough to be safe.

RSS is attributed per process tree (a `--bg` session plus its MCP servers, pty helper, and
children), so the table's totals reflect the real memory the leak holds, not just the root process.

### Example

```bash
# See what's running and how much memory it holds:
catalyst-execution-core sessions list

# Plan a reap scoped to one ticket:
catalyst-execution-core sessions prune --ticket CTL-649 --dry-run

# Reap finished/orphaned/duplicate sessions for real, including idle ones:
catalyst-execution-core sessions prune --yes --include-idle
```

## `worktrees`

Inventories git worktrees by joining `git worktree list --porcelain`, `gh pr list --state all`, the
live session inventory (to know which worktrees still have a session cwd'd inside them), and an
optional Linear-state lookup. Prune emits, **per row**, a `worktree.presweep.reap-requested` (stop
any straggler sessions) followed by a `pr.merged.cleanup-requested` (remove the worktree and its
local branch) — both flowing through the daemon reaper. This module never runs `git worktree remove`
itself.

### Subcommands

| Subcommand | Description                                                            |
| ---------- | --------------------------------------------------------------------- |
| `list`     | Read-only classified inventory (table, or JSON with `--json`).        |
| `prune`    | Emit presweep + cleanup intents for prunable rows. Dry-run unless `--yes`. |

### Flags

| Flag               | Applies to       | Meaning                                                            |
| ------------------ | ---------------- | ------------------------------------------------------------------ |
| `--json`           | `list`           | Emit JSON instead of the table.                                    |
| `--stale-days <N>` | `list` / `prune` | Age threshold (days) for the `STALE` class. Default `14`.          |
| `--yes`            | `prune`          | Actually emit cleanup intents.                                     |
| `--dry-run`        | `prune`          | Force dry-run. Plan only.                                          |
| `--max <N>`        | `prune`          | Cap planned prunes (default `50`).                                 |
| `--include-stale`  | `prune`          | Also prune `STALE` worktrees (opt-in).                             |

### Classification taxonomy

Priority: **LIVE → MERGED → CLOSED_NO_MERGE → ACTIVE (open PR) → ABANDONED → STALE → ACTIVE
(default)**. Linear-driven `ABANDONED` classification only fires when a caller supplies a Linear
state lookup (off by default, so the rate-limited `linearis` path is never hit from a plain
`list`/`prune`).

| Class             | Meaning                                                            | Pruned by default? |
| ----------------- | ------------------------------------------------------------------ | ------------------ |
| `LIVE`            | A session is still cwd'd inside this worktree.                     | No                 |
| `MERGED`          | The worktree's PR is merged.                                       | Yes                |
| `CLOSED_NO_MERGE` | The PR was closed without merging.                                 | Yes                |
| `ACTIVE`          | Open PR, or a fresh/in-progress worktree (safe default).           | No                 |
| `ABANDONED`       | No PR, but Linear says the ticket is Done/Cancelled.               | Yes (when Linear state is supplied) |
| `STALE`           | Aged out (older than `--stale-days`) with no other disposition.    | No (opt-in via `--include-stale`) |

The default prune set is `MERGED, ABANDONED, CLOSED_NO_MERGE`.

:::note[Force-branch-delete is MERGED-only]
The cleanup intent sets `force: true` (so the reaper's branch delete won't falsely refuse a
squash-merged branch) **only** for `MERGED` rows — a confirmed GitHub merge is squash-safe. For
`CLOSED_NO_MERGE`, `ABANDONED`, and `STALE`, force is left off so the reaper's `git branch -d`
refuses to destroy any unmerged commits.
:::

### Example

```bash
# Inventory, showing PR state and whether a live session is attached:
catalyst-execution-core worktrees list

# Plan cleanup of merged/closed/abandoned worktrees:
catalyst-execution-core worktrees prune --dry-run

# Clean up for real, also sweeping worktrees idle for >7 days:
catalyst-execution-core worktrees prune --yes --include-stale --stale-days 7
```

## `branches`

Inventories local and/or remote branch refs and deletes prunable ones. Unlike `sessions` and
`worktrees`, a bare branch has no `claude`-session aspect, so this module deletes refs **directly**
(`git branch -D` / `git push origin --delete`) rather than routing through the reaper — there is no
executor seam to swap for a ref delete.

### Subcommands

| Subcommand | Description                                                            |
| ---------- | --------------------------------------------------------------------- |
| `list`     | Read-only classified inventory (table, or JSON with `--json`).        |
| `prune`    | Delete prunable branch refs. Dry-run unless `--yes`.                  |

### Flags

| Flag                          | Applies to       | Meaning                                                      |
| ----------------------------- | ---------------- | ------------------------------------------------------------ |
| `--json`                      | `list`           | Emit JSON instead of the table.                              |
| `--scope local\|remote\|both` | `list` / `prune` | Which side(s) to consider/act on. Default `both`.            |
| `--stale-days <N>`            | `list` / `prune` | Age threshold (days) for `STALE_REMOTE`. Default `30`.       |
| `--yes`                       | `prune`          | Actually delete refs.                                        |
| `--dry-run`                   | `prune`          | Force dry-run. Plan only.                                    |
| `--force`                     | `prune`          | Also delete the unmerged classes (see below).                |
| `--max <N>`                   | `prune`          | Cap planned deletions (default `100`).                       |

### Classification taxonomy

Priority: **WORKTREE_BACKED → CLOSED_NO_MERGE → MERGED_REMOTE → MERGED_LOCAL → ORPHAN_LOCAL →
STALE_REMOTE → ACTIVE (default)**.

| Class             | Meaning                                                                         | Pruned by default? |
| ----------------- | ------------------------------------------------------------------------------- | ------------------ |
| `WORKTREE_BACKED` | A worktree has this branch checked out — defer to `worktrees prune`.            | No (never deleted) |
| `CLOSED_NO_MERGE` | The branch's PR was closed without merging.                                     | Only with `--force`|
| `MERGED_REMOTE`   | Remote branch whose PR is merged.                                               | Yes                |
| `MERGED_LOCAL`    | Local branch merged into `main` (or with a merged PR, local scope).             | Yes                |
| `ORPHAN_LOCAL`    | Local-only branch with no PR and no remote — likely abandoned, may be unmerged. | Only with `--force`|
| `STALE_REMOTE`    | Remote-only branch, no PR, older than `--stale-days`.                           | Only with `--force`|
| `ACTIVE`          | Safe default — anything not matching a deletable class.                         | No                 |

The default prune set is `MERGED_LOCAL, MERGED_REMOTE`. The unmerged classes
(`ORPHAN_LOCAL`, `STALE_REMOTE`, `CLOSED_NO_MERGE`) are added only when you pass `--force`.

### Example

```bash
# Audit local + remote branches:
catalyst-execution-core branches list

# Plan deletion of merged branches on both sides:
catalyst-execution-core branches prune --dry-run

# Delete merged branches for real, local only:
catalyst-execution-core branches prune --yes --scope local

# Also clean up orphaned/stale unmerged branches (destructive):
catalyst-execution-core branches prune --yes --force
```

## `tidy`

The umbrella. It runs the three resource prunes and a final `git worktree prune` (admin-record
cleanup) in a fixed order:

```
sessions → worktrees → branches → git worktree prune
```

```bash
catalyst-execution-core tidy --dry-run     # plan everything (mutates nothing)
catalyst-execution-core tidy --yes         # run the full sweep
```

### Why the order is load-bearing

Sessions must be reaped **before** their worktrees are removed. Removing a worktree while a session
is still cwd'd inside it is exactly what manufactures the `ORPHAN` sessions this tool exists to clean
up — the leak class, inverted. Running `sessions` first means every `worktrees` step finds its
stragglers already reaped (and the per-row presweep is a belt-and-suspenders backstop). The standalone
nouns let an operator deliberately do otherwise; the umbrella enforces the safe order.

### Abort on first failure

If any step fails, `tidy` **aborts the chain** rather than press on — better to stop than to run
`git worktree prune` after a half-done session sweep and manufacture fresh orphans. The summary line
reports which steps completed and where it stopped (`aborted at <step>`), and the process exits
non-zero.

`--dry-run`, `--yes`, and the resource flags (`--include-idle`, `--include-stale`, `--force`,
`--max`) propagate to every step. The sessions-specific safety flags `--include-interactive` and
`--min-idle-seconds <N>` likewise propagate to the `sessions` step (so a full `tidy` honors the same
interactive-protection and recency guards as a standalone `sessions prune`). The final
`git worktree prune` only runs under `--yes` (it is a real mutation, so it is skipped in dry-run).
