---
name: monitor-events
description:
  Reference for the canonical event-driven wait pattern in Catalyst skills. Use when a skill
  needs to block on a state change (PR merged, CI completed, push to branch, ticket
  transitioned) WITHOUT polling. Pairs the `catalyst-events` CLI with the Claude Code
  `Monitor` tool and `wait-for` for short-lived workers.
---

# monitor-events — Event-driven waits in skill prose

CTL-210 unified the Catalyst event log: every GitHub webhook, Linear webhook, comms post,
and orchestrator/worker lifecycle event flows through `~/catalyst/events/YYYY-MM.jsonl`.
This skill documents the canonical patterns. Use as a reference — do not invoke as a slash command.

## Prerequisite — orch-monitor daemon must be running

`catalyst-events tail`/`wait-for` read from `~/catalyst/events/YYYY-MM.jsonl`, populated
by `orch-monitor`. When the daemon is down, `tail` returns empty and `wait-for` times out.

Liveness check:

```bash
plugins/dev/scripts/catalyst-monitor.sh status        # human-readable
plugins/dev/scripts/catalyst-monitor.sh status --json # {"running":true,"pid":...}
```

Skills that invoke `check-project-setup.sh` (orchestrate, oneshot, merge-pr) handle this
automatically. For other callers: start with `catalyst-monitor.sh start` or plan for the
polling fallback.

## Pattern selection & cost tradeoffs

| Pattern | Mechanism | When to use |
|---|---|---|
| **Broker interest** (preferred) | Daemon classifies events between turns; emits `filter.wake.{id}` on semantic match. Zero context turns while blocked. | Whenever broker is running. |
| **`catalyst-events wait-for`** | Blocking CLI; one jq predicate; exits on first match. Zero context turns. | Short-lived `claude -p` workers; one-shot waits; CI scripts. |
| **`Monitor` over `tail`** | Every matching line wakes a Claude turn. Highest context cost. | Long-lived orchestrators only — **never** for `claude -p` workers. |

> **Worker contract:** dispatched workers prefer the broker, fall back to `wait-for` when
> the daemon is down, and never use `Monitor`/`tail`. See `oneshot` Phase 5 and the
> `orchestrate` dispatch prompt.

> **Narration invariant:** all `monitor-events` consumers must include the two required narration
> lines (Current status + Waiting for). See [narration-fixture.md](references/narration-fixture.md).

## Load on demand

| Situation | Reference |
|---|---|
| Worker blocking on PR merge — two-phase wait-for + REST check | [pattern1-worker-pr.md](references/pattern1-worker-pr.md) |
| Long-lived orchestrator — scope-aware Monitor, cross-orch scoping | [pattern2-orchestrator.md](references/pattern2-orchestrator.md) |
| Reactive PR loop — CI, reviews, BEHIND, merge/close events | [pattern3-reactive-pr.md](references/pattern3-reactive-pr.md) |
| Pattern 3 misbehaves — jq filter issues, bash quoting, runaway | [pattern3-gotchas.md](references/pattern3-gotchas.md) |
| Narration lines BAD/GOOD fixture and applicability | [narration-fixture.md](references/narration-fixture.md) |
| Reading broker wake payload — `wake-extract`, watchdog wake | [wake-payload.md](references/wake-payload.md) |
| Worker phase-event severity tiers and coalesced batches (CTL-229) | [phase-events.md](references/phase-events.md) |
| Silent live-tail — diagnostic mode, flow-verification recipes | [diagnostic-mode.md](references/diagnostic-mode.md) |
| Filter cookbook, Pattern 4 by-ticket tail, envelope versions | [filter-cookbook.md](references/filter-cookbook.md) |

## Quick reference

```bash
# Blocking wait (worker pattern — preferred over Monitor)
catalyst-events wait-for --timeout 600 --filter '<jq-predicate>'

# Streaming tail (orchestrator pattern)
Monitor(command="catalyst-events tail --filter '<jq-predicate>'", description="...")

# Tail from beginning (diagnostic mode — verifies tunnel health)
catalyst-events tail --since-line 0 --filter '...' | tail -5
```

⚠️ **Safety net, every time:** pair every `wait-for` with an authoritative one-shot check after
it returns (a `gh api` / `linearis` re-check of the actual state). When the broker or webhook
infra is down, `wait-for` only times out — nothing rechecks the requested state for you.
