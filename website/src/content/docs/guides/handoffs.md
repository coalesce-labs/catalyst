---
title: Handoff System
description: Context transfer documents for pausing, resuming, and transferring work across sessions.
---

Handoffs are structured documents that capture the full state of in-progress work, enabling it to be paused, resumed, or transferred while preserving critical context.

## When to Create Handoffs

- **Pausing work** for later resumption
- **Context above 60%** — frequent intentional compaction
- **Blocked** by technical challenges or waiting on input
- **Switching machines** or sessions
- **End of day** — resume tomorrow
- **Implementation deviates** significantly from the plan

## Creating a Handoff

```
/catalyst-dev:create_handoff
```

This generates a structured document at `thoughts/shared/handoffs/PROJ-XXXX/YYYY-MM-DD_HH-MM-SS_description.md`.

## Handoff Structure

A handoff document includes:

- **Current task** — What you're working on and the plan reference
- **Progress** — Completed phases with checkmarks
- **Critical references** — Files, plans, research with specific paths
- **Recent changes** — What was done in this session
- **Learnings** — Insights discovered during implementation
- **Blockers/Questions** — What's preventing progress
- **Next steps** — Ordered action items
- **Artifacts created** — Files and outputs from this session

## Resuming from a Handoff

```
/catalyst-dev:resume_handoff
```

Or specify a ticket number to find the latest handoff:

```
/catalyst-dev:resume_handoff PROJ-123
```

The resume process:

1. Reads the handoff document
2. Reads linked research and plans
3. Spawns parallel verification tasks to check current state
4. Presents a comprehensive analysis
5. Proposes next actions
6. Waits for your approval to proceed

## During Implementation

Catalyst agents proactively monitor context during implementation and will prompt you to create handoffs before running out of context. The implementation command tracks progress with plan checkboxes, so handoffs are natural and low-cost.

## Tips

- **Handoffs are cheap** — creating one takes under a minute
- **Better too many than too few** — you can always skip reading stale handoffs
- **Include file:line references** — specific paths are more useful than descriptions
- **Sync after creating** — run `humanlayer thoughts sync` so handoffs are available from other machines
