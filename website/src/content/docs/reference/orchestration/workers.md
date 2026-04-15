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
     │                                 │   Phase 5: shipping (opens PR, arms auto-merge)
     │                                 │
     │<─ signal file: pr-created ──────│
     │                                 │ exits
     │                                 │
     │ (Phase 4 poll loop, orchestrator side)
     │    gh pr view → merged? ──> yes: writes mergedAt, Linear=Done
```

The split between worker and orchestrator matters: the worker subprocess reliably exits at its final tool-use, before merge completes. **Polling until merged is the orchestrator's responsibility**, not the worker's. A worker that claims to poll-until-merged burns tokens and produces false signals.

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

### The `pr` subobject

```json
{
  "number": 123,
  "url": "https://github.com/org/repo/pull/123",
  "ciStatus": "pending",
  "prOpenedAt": "2026-04-14T19:15:30Z",
  "autoMergeArmedAt": "2026-04-14T19:15:32Z",
  "mergedAt": null
}
```

- `ciStatus`: `pending` | `passing` | `failing` | `unknown` | `merged`
- `prOpenedAt` — set by worker the moment the PR is created
- `autoMergeArmedAt` — set by worker after `gh pr merge --squash --auto`
- `mergedAt` — **always** set by the orchestrator (or standalone `/merge-pr`), never by the worker

### State machine

```
dispatched → researching → planning → implementing → validating → shipping → pr-created
                                                                                   │
                                                                         (orchestrator polls)
                                                                                   │
                                                                                   v
                                                                              merging → done
                                                                                   │
                                                                                   v
                                                          (at any stage) → failed | stalled
```

The worker writes statuses up through `pr-created`. The orchestrator writes `merging` and `done` (or `failed`/`stalled` if the wave times out or verification fails).

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
| `done` | PR merged, Linear=Done | Orchestrator (after observing merge) |
| `failed` | Unrecoverable error, quality gates exhausted, or human escalation | Worker (writes attention reason) |
| `stalled` | No heartbeat / no progress for 15+ min | Orchestrator |

Terminal states set `completedAt`. No further writes to the signal file happen once terminal is reached.

## Why signal files and not IPC

File-based signals are intentionally boring:

- **Debuggable** with `cat workers/*.json | jq`
- **Survive process death** on both sides — neither the worker crashing nor the orchestrator restarting destroys state
- **Atomic on POSIX** via tmp+rename writes
- **Pickled history** — old signal files live in archived orchestrator dirs, so you can audit past waves

The cost is polling latency — the orch-monitor uses `fs.watch` to avoid polling, but some consumers do poll. That's fine for a one-machine setup; for multi-host you'd front this with a real event bus.
