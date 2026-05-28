---
title: Todo column convention
description: How the Todo Linear state signals the daemon to start work, and what the daemon does automatically when a ticket enters that column.
sidebar:
  order: 4
---

The **Todo** column in Linear is the daemon's eligible-work signal. Moving a ticket into Todo hands it to the execution-core orchestrator — no other action is required.

## How it works

The daemon's `eligibleQuery.status` is set to `"Todo"` in `.catalyst/config.json`. On each reconcile cycle the daemon polls Linear for all tickets matching that query and holds them as the eligible set. The periodic scheduler then picks from that set and dispatches work.

### Auto-transition on first dispatch

When the daemon dispatches the **triage phase agent** for a Todo ticket, it immediately writes the Linear state from **Todo → Triage**. The board column updates as soon as the agent is launched — the ticket does not linger visually in Todo during the triage phase.

This write is **verified**: after shelling to `linear-transition.sh`, the daemon re-reads the ticket's state and confirms it matches the configured `stateMap.triage` value (default `"Triage"`). If the transition exits 0 but the re-read shows the state is still Todo (the [silent-success failure mode](/observability/)), the daemon records `verified: false` in the event and logs a warning — the dispatch still proceeds, but the false-success is observable.

### Observability event

Every dispatch emits a `phase.triage.linear-transition.<TICKET>` INFO event appended to the canonical event log at `~/catalyst/events/YYYY-MM.jsonl`. The event payload carries:

```json
{
  "phase": "triage",
  "ticket": "CTL-123",
  "from_state": "Todo",
  "to_state": "Triage",
  "verified": true,
  "applied": true,
  "reason": null
}
```

This event is **observability-only** — the broker's pipeline routing does not match `linear-transition` actions, so it cannot advance the pipeline state machine.

## Putting a ticket into work

1. Set the ticket's state to **Todo** in Linear (drag it to the column, or use `linearis issues update <TICKET> --status Todo`).
2. The daemon picks it up on the next reconcile (up to 10 minutes, or immediately on a `state_changed` broker event).
3. The triage phase agent launches. Linear flips **Todo → Triage** automatically.
4. The pipeline continues through Research → Plan → Implement → Validate → PR → Done.

For more on the phases themselves, see [Understanding phases](./phases.md).

## Configuration

The eligible-query status is set per project in `.catalyst/config.json`:

```json
{
  "eligibleQuery": {
    "status": "Todo",
    "triageStatus": "Triage"
  }
}
```

`triageStatus` is the target state the daemon verifies after writing. Rename it here if your Linear workspace uses a different name for the Triage column.
