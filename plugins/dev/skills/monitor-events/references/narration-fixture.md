# Narration — BAD/GOOD Fixture and Applicability (CTL-369)

_Read this when reviewing a transcript for correct wake-narration, or when implementing a new
event-driven wait loop and need the exact required line shapes._

Every Monitor wake and every event-driven `wait-for` return MUST be acknowledged with a single
short line of assistant text before the agent returns to waiting. This is the canonical way to
defeat the `Human:\n<task-id>` rendering bleed — without it, transcripts become unreadable.

**Why this is non-negotiable.** The Claude Code harness wraps every Monitor wake in a user-role
`<task-notification>` XML message whose `<summary>` is the `description` field you passed to the
`Monitor` tool. If the assistant returns an `end_turn` containing only `thinking` blocks (no `text`
content), the UI renders the next `<task-notification>` raw and the `<task-id>` element leaks into
the visible transcript as a phantom user message.

## Wake-narration fixture (BAD vs GOOD)

```text
# BAD — orchestrator returned thinking-only end_turn, task-id leaks

⏺ Monitor event: "orch-adv-931 events (PR/CI/worker/comms)"
⏺ Human:
  ba18h9cyy
⏺ Monitor event: "orch-adv-931 events (PR/CI/worker/comms)"
⏺ Human:
  c9a4f2x1q

# GOOD — orchestrator narrates every wake; no task-id bleed

⏺ Monitor event: "orch-adv-931 events (PR/CI/worker/comms)"
⏺ wake: github.check_suite.completed #412 [interest=pr_lifecycle] —
       CI failed on PR #412, dispatching auto-fixup
⏺ Monitor event: "orch-adv-931 events (PR/CI/worker/comms)"
⏺ wake: orchestrator.worker.phase_advanced — routine, staying in event loop
```

## Required line shapes

Pick the one that matches the wake. Each is a single line under ~120 characters; both "what
arrived" and "what we're doing about it" must appear (even if "what we're doing" is "nothing").

| Situation | Line shape |
|---|---|
| Actionable wake | `wake: <event.name> #<pr> [interest=<type>] — <action being taken>` |
| Non-actionable / routine | `wake: <event.name> — routine, staying in event loop` |
| Already addressed (stale broker re-fire) | `wake: <event.name> — already addressed, no-op` |
| Idle-timeout safety-net scan | `wake: idle-timeout — running periodic reconciliation scan` |
| Daemon-down / REST fallback | `wake: rest-poll — broker down, polling gh api` |

Include the matched filter clause or interest type when available. Broker wakes
(`filter.wake.<sid>`) carry `.body.payload.interest_id` and `.body.payload.reason`; surface both.

## Where this applies

This requirement applies to **every** event-driven listen loop in Catalyst skills:

- `orchestrate` Phase 4 (orchestrator's own Monitor over `catalyst-events tail`)
- `orchestrate` worker dispatch prompt (each worker's listen loop)
- `oneshot` Phase 5 (worker's PR listen loop)
- Any new skill that wraps `Monitor` or `catalyst-events wait-for`

The narration line is not for the agent — it is for the *operator reading the transcript later*.
Treat the wake as a question; treat the line as the answer.
