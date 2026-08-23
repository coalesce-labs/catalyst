---
name: broker
description:
  Protocol reference for the Catalyst event broker daemon. Covers agent identity (agent.checkin/
  checkout), auto-correlation of ticket↔PR interests, ticket_lifecycle deterministic routing for
  Linear events, and the existing pr_lifecycle + Groq prose routing paths. Use when an agent needs
  to wait for events related to its own ticket/PR, watch another ticket's lifecycle, or register
  any semantic interest in the event stream.
---

# Catalyst Event Broker — Protocol Reference (CTL-303)

The broker daemon evolved from the `catalyst-filter` daemon (CTL-284). It adds structured agent
identity (`agent.checkin` / `agent.checkout`), `ticket_lifecycle` deterministic routing for Linear
events, auto-correlation of `pr_lifecycle` from check-in data, and backward-compatible Groq prose
classification.

## Daemon Management

```bash
catalyst-broker status   # → "running (pid N)" or "stopped"
catalyst-broker start
catalyst-broker stop
catalyst-broker restart
catalyst-broker logs
```

## Interest Types Summary

| Interest type | Routing | Use case |
|---|---|---|
| `pr_lifecycle` | Deterministic | Watch CI, reviews, merge, deployment for a known PR number |
| `ticket_lifecycle` | Deterministic | Watch Linear state changes, comments, PR links for a ticket |
| `comms_lifecycle` | Deterministic | Watch comms-channel messages (worker → orchestrator attention/done) |
| `phase_lifecycle` | Deterministic | Watch `phase.<name>.complete/failed/turn-cap-exhausted.<ticket>` events |
| (prose prompt) | Groq LLM (env-gated off; CTL-357) | Ambiguous, cross-cutting conditions — `CATALYST_BROKER_PROSE_ENABLED=1` |

## Load on demand

| When you need to… | Read |
|---|---|
| Understand check-in/checkout, auto-correlation, claimed_pr wiring | [references/agent-lifecycle.md](references/agent-lifecycle.md) |
| Debug `worker.waiting` / `worker.resumed` events | [references/worker-waiting.md](references/worker-waiting.md) |
| Use `orchestrator.status` events and state file | [references/orchestrator-status.md](references/orchestrator-status.md) |
| Register `ticket_lifecycle` interests, read `wake_on` values | [references/ticket-lifecycle.md](references/ticket-lifecycle.md) |
| Register `comms_lifecycle` interests (orchestrator or worker) | [references/comms-lifecycle.md](references/comms-lifecycle.md) |
| Register `phase_lifecycle` interests | [references/phase-lifecycle.md](references/phase-lifecycle.md) |
| Register `pr_lifecycle` interests (explicit PR number) | [references/pr-lifecycle.md](references/pr-lifecycle.md) |
| Use Groq prose interests | [references/groq-prose.md](references/groq-prose.md) |
| Deregister, query agent state, broker fallback | [references/deregistration.md](references/deregistration.md) |
| Parse the wake event envelope fields | [references/wake-payload-reference.md](references/wake-payload-reference.md) |
| Decode wake reason strings by interest type | [references/wake-reason-strings.md](references/wake-reason-strings.md) |
