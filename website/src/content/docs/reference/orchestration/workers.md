---
title: Workers and signal files
description: How the orchestrator dispatches workers, how they report progress, and the full signal-file schema.
sidebar:
  order: 1
---

When `/catalyst-dev:orchestrate` runs a wave, it dispatches one **worker** per ticket. Each worker is a separate Claude Code subprocess running `/catalyst-dev:oneshot` inside a dedicated git worktree. The worker communicates progress back to the orchestrator exclusively through its **signal file**.

## Worker lifecycle

```
Orchestrator                   Worker subprocess
     │                                │
     │─ creates signal file ──────────>│
     │─ launches claude -p ────────────>│ starts /catalyst-dev:oneshot
     │                                 │   Phase 1: researching
     │                                 │   Phase 2: planning
     │                                 │   Phase 3: implementing
     │                                 │   Phase 4: validating
     │                                 │   Phase 5: shipping
     │                                 │     emits agent.checkin {claimed_pr} →
     │                                 │       broker auto-registers pr_lifecycle interest (CTL-303)
     │                                 │     opens PR → enters catalyst-events wait-for loop
     │                                 │     resolves CI failures, bot review threads, BEHIND
     │                                 │     gh pr merge --squash --delete-branch
     │                                 │     writes pr.mergedAt + status: done → emits agent.checkout → exits
     │                                 │
     │<─ signal file: done ────────────│
     │   (orchestrator's Phase 4 is a safety-net fallback for stalled/crashed workers)
```

The worker owns the full PR lifecycle end-to-end: it opens the PR, enters an event-driven listen loop via `catalyst-events wait-for`, resolves blockers (CI failures, bot review threads, BEHIND) inline, executes `gh pr merge --squash --delete-branch` when the PR is CLEAN, and writes `status: "done"` before exiting. The orchestrator's Phase 4 is a fallback that handles workers that stalled before completing their own merge.

## The signal file

Located at `<orchestrator-dir>/workers/<ticket>.json`. The orchestrator creates an empty skeleton; the worker writes into it.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `ticket` | string | The ticket ID (e.g., `CTL-48`) |
| `orchestrator` | string | Orchestrator ID |
| `workerName` | string | Human-readable worker name (used for tmux titles, etc.) |
| `status` | string | Current status — see state machine below |
| `phase` | number | 0–6, matching oneshot phases |
| `startedAt` | ISO string | When the worker was dispatched |
| `updatedAt` | ISO string | Last write to the signal file |
| `lastHeartbeat` | ISO string | Most recent heartbeat (~60s cadence during long phases) |
| `completedAt` | ISO string or `null` | Set when terminal state reached |
| `worktreePath` | string | Absolute path to the worker's git worktree |
| `phaseTimestamps` | object | Map of status → ISO timestamp; populated at each transition |
| `pr` | object or `null` | Populated at Phase 5 PR creation |
| `linearState` | string or `null` | Current Linear state name |
| `definitionOfDone` | object | Populated at Phase 4 + 5 with real results |
| `pid` | number | Worker's Claude process PID |
| `cost` | object\|null | Usage/cost object populated by `orchestrate-roll-usage.sh` after the worker stream contains a `result` event. Shape: `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUSD, numTurns, durationMs }` |

### The `pr` subobject

```json
{
  "number": 123,
  "url": "https://github.com/org/repo/pull/123",
  "ciStatus": "pending",
  "prOpenedAt": "2026-04-14T19:15:30Z",
  "mergedAt": null
}
```

- `ciStatus`: `pending` | `passing` | `failing` | `unknown` | `merged`
- `prOpenedAt` — set by worker the moment the PR is created
- `mergedAt` — set by the worker after `gh pr merge --squash --delete-branch` completes; set by the orchestrator (fallback) for stalled workers

### State machine

```
dispatched → researching → planning → implementing → validating → shipping → pr-created
                                                                                   │
                                                                     (worker listen loop)
                                                                       resolves blockers
                                                                                   │
                                                                                   v
                                                                                 done  ← worker (primary path)
                                                                                   │     orchestrator (fallback for stalled workers)
                                                                                   v
                                                          (at any stage) → failed | stalled
```

The worker writes all statuses through `done`. In the `pr-created` → `done` transition, the worker enters a `catalyst-events wait-for` listen loop, resolves CI failures and review blockers inline, and executes `gh pr merge --squash --delete-branch` when the PR is CLEAN. The orchestrator writes `done` only as a safety-net fallback for workers that wrote `stalled` or crashed before completing their own merge.

The listen loop is enabled by [`catalyst-broker`](/observability/catalyst-broker/)
auto-correlation (CTL-303): the worker's `agent.checkin {claimed_pr}` event causes the broker to
derive a `pr_lifecycle` interest for that PR, so `wait-for` receives PR/CI/review events without
the worker calling `filter.register` manually. On `agent.checkout` the broker auto-deregisters
the derived interests.

## The global state

In parallel with the signal file, workers also write to `~/catalyst/state.json` via `catalyst-state.sh worker`. This is the fleet-wide aggregate that the dashboard reads — it unifies workers across multiple orchestrators. Writes are atomic (jq + mkdir-based locking).

Schema:

```json
{
  "orchestrators": {
    "orch-2026-04-14-abc123": {
      "project": "CTL",
      "startedAt": "...",
      "lastHeartbeat": "...",
      "wave": 2,
      "totalWaves": 3,
      "workers": {
        "CTL-48": { /* same shape as signal file */ }
      },
      "attention": [
        { "type": "verification-failed", "ticket": "CTL-48", "message": "..." }
      ]
    }
  }
}
```

The `attention` array is the orchestrator's way of flagging something that needs human decision. Never auto-resolved by the orchestrator itself.

## Heartbeats

During long phases (implementation, CI waits), workers update `lastHeartbeat` without changing status. The orch-monitor treats a worker as stalled if `now - lastHeartbeat > 15 minutes`. A stalled worker is never auto-restarted — it becomes an attention item.

If you're writing a custom worker, heartbeat every ~60s at minimum. More often is fine; less often trips false stalled detections.

## Terminal states

A worker reaches a terminal state in one of three ways:

| State | Means | Signal writer |
|-------|-------|---------------|
| `done` | PR merged, Linear=Done | Worker (after executing merge); Orchestrator (fallback for stalled workers) |
| `failed` | Unrecoverable error, quality gates exhausted, or human escalation | Worker (writes attention reason) |
| `stalled` | Worker could not resolve a blocker (CI, reviews, conflicts) or no heartbeat for 15+ min | Worker (on unrecoverable blocker); Orchestrator (on heartbeat timeout) |

Terminal states set `completedAt`. No further writes to the signal file happen once terminal is reached.

## Why signal files and not IPC

File-based signals are intentionally boring:

- **Debuggable** with `cat workers/*.json | jq`
- **Survive process death** on both sides — neither the worker crashing nor the orchestrator restarting destroys state
- **Atomic on POSIX** via tmp+rename writes
- **Pickled history** — old signal files live in archived orchestrator dirs, so you can audit past waves

The cost is polling latency — the orch-monitor uses `fs.watch` to avoid polling, but some consumers do poll. That's fine for a one-machine setup; for multi-host you'd front this with a real event bus.
