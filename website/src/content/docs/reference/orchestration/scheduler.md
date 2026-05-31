---
title: Scheduler Reference
description: Global priority+stage sort, preemption, and resume for the execution-core pull-loop scheduler.
---

# Execution-core Scheduler

The execution-core pull-loop scheduler runs on every tick and drives the
full phase-agent pipeline. This page covers the **global ranking**, the
**preemption mechanism**, and the safety guards that prevent thrash.

## Global comparator

Every tick, the scheduler builds a unified view of all in-flight workers
**and** all queued (Ready) tickets, then sorts them by a 4-key total order:

```
priority (asc) → stage (desc) → createdAt (asc) → identifier (asc)
```

| Key | Direction | Tie-break semantics |
|---|---|---|
| **priority** | ascending | 1=Urgent, 2=High, 3=Medium, 4=Low, 5=No Priority |
| **stage** | descending | later pipeline phase = closer to done; queued tickets default to `-1` |
| **createdAt** | ascending | FIFO fairness within a band; absent sorts last |
| **identifier** | ascending | deterministic final tie-break |

### Stage scale

Each pipeline phase maps to an integer stage index:

| Phase | Stage |
|---|---|
| triage | 0 |
| research | 1 |
| plan | 2 |
| implement | 3 |
| remediate | 4 |
| verify | 5 |
| review | 6 |
| pr | 7 |
| monitor-merge | 8 |
| monitor-deploy | 9 |

Queued tickets carry `stage = -1`, so within the same priority band an
in-flight worker always ranks ahead of a newly-queued ticket — only a
strictly higher-priority queued ticket can displace in-flight work.

## Priority persistence (`priority.json`)

When a ticket is dispatched for the first time (new-work pull, sweep 2),
the scheduler writes `workers/<TICKET>/priority.json`:

```json
{ "priority": 2, "createdAt": "2026-05-01T00:00:00Z" }
```

This file is read on every subsequent tick when the ticket is in-flight,
so the global rank requires **no per-tick Linear API calls**. Legacy
workers dispatched before CTL-705 land have no `priority.json` and default
to `priority: 5` (lowest band).

## Sweep order

Each tick runs six sweeps in sequence:

| Sweep | Name | What it does |
|---|---|---|
| 0 | Reclaim/Revive | For each dead worker (per the local `state.json` lifecycle): close its signal if work is done, revive it if it made forward progress, or stop + flag needs-human if it made none |
| 0.5 | Preemption | Stop the lowest-ranked worker when Urgent is queued and all slots are full |
| 1 | Advancement | Dispatch the FSM-owed next phase for each in-flight ticket |
| 1.5 | Resume | Re-dispatch preempted workers at `parkedFrom` when a slot frees |
| 2 | New-work pull | Fill remaining free slots with top-ranked Ready tickets |
| 3 | Terminal-Done | Apply Linear `Done` state + worktree teardown for completed tickets |

## Preemption (sweep 0.5)

When `liveBackgroundCount()` is at or above `maxParallel` **and** the
top-ranked queued ticket out-ranks the lowest-ranked preemptable in-flight
worker, the scheduler preempts that worker:

1. `claude stop <bgJobId>` — deregisters the worker from the live bg count.
2. Rewrites the worker's phase signal: `status: "preempted"`, `parkedFrom: <phase>`, `attentionReason: "preempted-by-priority"`.
3. Emits `phase.<phase>.preempted.<TICKET>` to the unified event log.

The preempted worker is excluded from the reclaim sweep — its signal status is
`"preempted"` (non-terminal but not a crash), so the reclaim sweep's death
trigger and progress gate never treat it as a dead worker to revive — and from
the advancement sweep (status ≠ `"done"`).

### Safety guards

All guards must pass before preemption fires. If the bottom-ranked candidate
fails a guard, the next-lowest candidate is tried; if none qualifies,
preemption is skipped this tick.

| Guard | Threshold | Rationale |
|---|---|---|
| Non-preemptable phase | `triage`, `monitor-deploy` | Triage is brief; monitor-deploy is a passive observer |
| Min-runtime floor | 60 seconds | Prevents stopping a worker that just started |
| Implement quiet-window | `phase-implement.json` mtime > 10s | Worker may be in the middle of a commit |
| Hysteresis | Queued ticket must have out-ranked candidate for ≥30s | Prevents thrash on transient priority changes |

Note: preemption→resume is **multi-tick**. `claude stop` may not deregister
within the same tick's `liveBackgroundCount()`, so the freed slot fills on a
subsequent tick.

## Resume-after-preemption (sweep 1.5)

When a slot is free, the resume sweep re-dispatches parked tickets
**before** new-work pull so a preempted worker is never delayed by a
brand-new ticket. The sweep:

1. Collects all tickets with `status: "preempted"` across the workers tree.
2. Sorts them by the same global comparator (priority → stage → createdAt).
3. For each, while free slots remain:
   - Resolves a `--resume-session` UUID from the dead worker's `bg_job_id` (if available).
   - Dispatches at `parkedFrom` phase, passing `--resume-session` when found.
   - On success: emits `phase.<phase>.resumed-after-preemption.<TICKET>`.
   - On failure: records a dispatch cool-down, emits `phase.dispatch.failed.<TICKET>`.
4. Subtracts the resumed count from the free-slots budget before new-work pull.

If the UUID cannot be resolved (worker's job dir is gone), the re-dispatch
proceeds **without** `--resume-session` — a cold fresh start at the same
phase.

## Configuration

Preemption is always active when the execution-core scheduler is running.
The guard thresholds are compiled constants; the only operator-visible knob
is `maxParallel` (via `.catalyst/config.json → catalyst.orchestration.executionCore.maxParallel`).

## Migration notes

Existing in-flight workers dispatched before CTL-705 merged have no
`priority.json`. Their `readWorkerPriority` defaults to `{ priority: 5 }`,
placing them in the lowest-priority band. During the rollout window such a
worker could be a preemption candidate if a higher-priority ticket is queued;
the 60s min-runtime and 30s hysteresis guards limit the blast radius. The
condition is transient — every new dispatch writes `priority.json`.

## Related

- [Workflow descriptors](/reference/orchestration/workflows/) — the stage ranks and the
  non-preemptable set are sourced from the descriptor's per-step `rank` / `preemptable` fields
- [Phase agents](/reference/orchestration/phase-agents/) — the phase pipeline the scheduler dispatches
