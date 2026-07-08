---
title: Worker-Status Labels
description:
  How Catalyst's worker-status label group surfaces what a worker is doing — independent of where a
  ticket is in the pipeline.
---

# Worker-Status Labels

Every ticket Catalyst is working on has two independent states that you can observe in Linear and in
the HUD:

- **Pipeline stage** — where the ticket is in the pipeline (Research, Plan, Implement, etc.). This
  is the Linear workflow status.
- **Worker disposition** — what the worker assigned to that ticket is doing right now. This is the
  `worker-status` label.

They are separate because a ticket can be in "Implement" (stage) while the worker is waiting for
your input (disposition). Keeping them separate means the Linear status always reflects the pipeline
— and the label always reflects the worker's current situation.

## The four dispositions

| Label         | What it means                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`      | The ticket is waiting for a free worker slot. The admission gate is holding it until there is capacity.                                     |
| `blocked`     | The ticket has a dependency that hasn't finished yet. Once the blocker is resolved, the admission gate will pick it up.                     |
| `needs-input` | The worker is paused and waiting for a reply. It received a comment or hit a question it can't resolve autonomously.                        |
| `needs-human` | The worker has escalated. Something went wrong that requires human judgment — a stalled phase, a failed retry cycle, or a watchdog timeout. |

## Only one label at a time

Catalyst enforces a single `worker-status` label per ticket at any moment. If multiple things are
true (for example, a ticket is both `blocked` and `needs-human`), only the highest-priority label is
applied:

```
needs-human > needs-input > blocked > queued
```

`needs-human` is **sticky** — once applied, it stays until you explicitly resolve the situation
(mark the ticket Done, reply to clear the escalation, or re-dispatch). The other labels are
refreshed automatically on every scheduler tick.

## What happens when the situation is resolved

- `queued` / `blocked` — cleared automatically when the ticket is dispatched or the dependency
  resolves.
- `needs-input` — cleared when a human replies to the ticket comment.
- `needs-human` — cleared when the ticket reaches a terminal state (Done) or when a recovery pass
  confirms the issue is resolved.

## The HUD capacity header

The [HUD queue view](/autonomous-workflow/see-your-work/) shows per-disposition badge counts in the
capacity header:

- **triage** — tickets in the triage phase, running as intake. These are **not** counted against
  your `maxParallel` slot ceiling (triage is lightweight and runs separately from build phases).
- **queued** / **blocked** / **needs-input** / **needs-human** — ticket counts per disposition.

Zero-count badges are hidden so the header stays clean.

## Setup

The `worker-status` label group is a workspace-scoped Linear label group created by
`setup-execution-core-states.sh`. It is idempotent — running the setup script twice will not
duplicate the labels. You do not need to create these labels by hand.

See [configuration reference](/reference/configuration/#worker-status-labels) for details.
