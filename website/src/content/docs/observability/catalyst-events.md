---
title: catalyst-events CLI
description: Command-line interface for reading and waiting on the unified event log at ~/catalyst/events/YYYY-MM.jsonl.
sidebar:
  order: 6
---

`catalyst-events` is the command-line interface for the unified event log at
`~/catalyst/events/YYYY-MM.jsonl`. It supports streaming subscription, blocking waits for
specific events, and filter construction helpers. Skills use it to synchronize on external
events (CI results, PR merges, webhook deliveries) without polling.

:::tip[Skill-author reference]
If you're writing a Catalyst skill and need the full protocol for building jq filters and
handling the two-phase fallback, see
[`plugins/dev/skills/monitor-events/SKILL.md`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/skills/monitor-events/SKILL.md).
This page covers the user-facing CLI interface.
:::

## Commands

### `tail`

```bash
catalyst-events tail [--filter <jq>] [--since-line <N>]
```

Streams the current month's event log as new lines arrive. Prints each matching line as a
pretty-printed JSON object. Runs until interrupted.

| Flag | Description |
|------|-------------|
| `--filter <jq>` | jq expression — only print lines where the expression returns truthy |
| `--since-line <N>` | Skip the first N lines of the file (resume from a cursor) |

```bash
# All events in real time
catalyst-events tail

# Only GitHub webhook events (canonical envelope, CTL-300)
catalyst-events tail --filter '.attributes."event.name" | startswith("github.")'

# Linear issue state changes for a specific ticket
catalyst-events tail --filter '.attributes."event.name" == "linear.issue.state_changed" and .body.payload.identifier == "CTL-48"'

# All worker lifecycle events (v1 envelope writers)
catalyst-events tail --filter '.event | startswith("worker-")'

# Events for one orchestrator
catalyst-events tail --filter '.attributes."catalyst.orchestrator.id" == "orch-ctl-2026-05-01"'

# Comms messages on a specific channel
catalyst-events tail --filter '.attributes."event.name" == "comms.message.posted" and .attributes."comms.channel" == "orch-ctl-ux"'

# Agent checkin / checkout (CTL-303)
catalyst-events tail --filter '.attributes."event.name" == "agent.checkin" or .attributes."event.name" == "agent.checkout"'

# Broker daemon startup
catalyst-events tail --filter '.attributes."event.name" == "broker.daemon.startup"'

# All ticket_lifecycle wake events (CTL-303)
catalyst-events tail --filter '.attributes."event.name" | startswith("filter.wake.")'

# All phase-agent pipeline events (CTL-452) — only emitted when dispatchMode = "phase-agents"
catalyst-events tail --filter '.attributes."event.name" | startswith("phase.")'
```

### `wait-for`

```bash
catalyst-events wait-for --filter <jq> [--timeout <seconds>]
```

Blocks until a matching event appears in the log, then prints it and exits. Returns non-zero
on timeout or infrastructure error. Used by skills that need to synchronize on a specific
external event without busy-polling.

| Flag | Description |
|------|-------------|
| `--filter <jq>` | Required. jq expression — block until a line where this returns truthy |
| `--timeout <seconds>` | Max wait time in seconds. Default: 600 (10 minutes) |

```bash
# Wait up to 120s for a CI result on PR #87
catalyst-events wait-for \
  --filter '.attributes."event.name" == "github.check_suite.completed" and (.body.payload.prNumbers // [] | contains([87]))' \
  --timeout 120

# Wait for a specific PR to merge
catalyst-events wait-for \
  --filter '.attributes."event.name" == "github.pr.merged" and .attributes."vcs.pr.number" == 87'

# Wait for a broker wake event (CTL-303 — semantic interests)
catalyst-events wait-for \
  --filter '.attributes."event.name" == "filter.wake" and .attributes."event.label" == "sess_abc123"' \
  --timeout 600

# Wait for a specific phase-agent phase to complete (CTL-452)
catalyst-events wait-for \
  --filter '.attributes."event.name" == "phase.research.complete.CTL-48"' \
  --timeout 600
```

#### Exit codes

| Code | Meaning |
|------|---------|
| `0` | A matching event was found |
| `1` | Timeout elapsed without a match |
| `2` | Infrastructure error (log file unreadable, malformed JSON line) |

When the orch-monitor is running with webhooks configured, `wait-for` returns within ~1s of
the event arriving via GitHub/Linear webhook. Without the monitor tunnel, the daemon falls
back to polling the event log file at 10-minute intervals — up to 600s maximum latency. See
[Setting up the webhook tunnel](./setup/#7-set-up-the-webhook-tunnel).

### `build-orchestrator-filter`

```bash
catalyst-events build-orchestrator-filter --orch <orch-id> [--wave <N>]
```

Generates the canonical jq filter string used by the orchestrator's Phase 4 polling loop.
The output is a jq expression ready to pass directly to `--filter` on `wait-for` or `tail`.

```bash
FILTER=$(catalyst-events build-orchestrator-filter --orch orch-ctl-2026-05-01)
catalyst-events wait-for --filter "$FILTER" --timeout 3600
```

## Event Envelope Schemas

The unified event log contains events from multiple writers. Two envelope shapes coexist —
the canonical OTel-shaped envelope (CTL-300) is the default for new emitters, and the
legacy v1 envelope is preserved for `catalyst-state.sh event` and the bash skills that call
it.

### Canonical envelope (CTL-300, default)

Written by the webhook receiver (`lib/webhook-events.ts`), `catalyst-comms send`,
`catalyst-broker`, `catalyst-otel-forward`, `catalyst-session.sh`, and the OTel emit scripts
under `plugins/dev/scripts/orch-monitor/lib/`:

```json
{
  "ts": "2026-05-01T12:00:00Z",
  "observedTs": "2026-05-01T12:00:00Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "traceId": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "spanId": "1122334455667788",
  "parentSpanId": null,
  "resource": {
    "service.name": "orch-monitor",
    "service.namespace": "catalyst",
    "service.version": "8.1.0"
  },
  "attributes": {
    "event.name": "github.pr.merged",
    "event.entity": "pr",
    "event.action": "merged",
    "vcs.pr.number": 87,
    "vcs.revision": "abc123def456"
  },
  "body": {
    "message": "PR #87 merged",
    "payload": { "...full webhook payload..." }
  }
}
```

Top-level fields: `ts`, `observedTs`, `severityText`, `severityNumber`, `traceId`, `spanId`,
`parentSpanId`, `resource`, `attributes`, `body`. The bare `.event` shorthand is absent —
use `.attributes."event.name"`. The `traceId` is populated by webhook-emitted events
(CTL-310) and is derived deterministically from orchestrator/worker identifiers.

### v1 envelope (legacy)

Written by `catalyst-state.sh event` and the older bash skills that call it:

```json
{
  "ts": "2026-05-01T12:00:00Z",
  "event": "worker-pr-created",
  "orchestrator": "orch-ctl-2026-05-01",
  "worker": "CTL-48",
  "detail": {
    "pr": 87,
    "url": "https://github.com/org/repo/pull/87"
  }
}
```

Top-level fields: `ts`, `event`, `orchestrator` (nullable), `worker` (nullable), `detail` (nullable object).

### Identifying the envelope version

```bash
# v1 events have a top-level .event field
catalyst-events tail --filter '.event != null'

# Canonical events have .attributes."event.name"
catalyst-events tail --filter '.attributes."event.name" != null'
```

Both shapes coexist indefinitely. New tools write the canonical envelope;
`catalyst-state.sh event` continues to write v1 for backward compatibility.

## jq Filter Cookbook

### Match by PR number

```bash
# v2 GitHub webhook events
--filter '.attributes."vcs.pr.number" == 87'

# v2 check suite (uses prNumbers array, not vcs.pr.number)
--filter '(.body.payload.prNumbers // [] | contains([87]))'

# Either (covers both)
--filter '(.attributes."vcs.pr.number" == 87) or (.body.payload.prNumbers // [] | contains([87]))'
```

### Match by event prefix

```bash
--filter '.event | startswith("worker-")'                     # v1 worker lifecycle (legacy)
--filter '.attributes."event.name" | startswith("github.")'  # canonical GitHub webhook
--filter '.attributes."event.name" | startswith("linear.")'  # canonical Linear webhook
--filter '.attributes."event.name" | startswith("agent.")'   # broker agent identity (CTL-303)
--filter '.attributes."event.name" | startswith("filter.")'  # broker register/deregister/wake
--filter '.attributes."event.name" | startswith("broker.")'  # broker daemon lifecycle
--filter '.attributes."event.name" | startswith("phase.")'   # phase-agent pipeline (CTL-452)
```

### Match by orchestrator scope

```bash
# v1 orchestrator events (legacy)
--filter '.orchestrator == "orch-ctl-2026-05-01"'

# Canonical envelope — orchestrator id lives under attributes
--filter '.attributes."catalyst.orchestrator.id" == "orch-ctl-2026-05-01"'

# Canonical envelope — filter by ticket
--filter '.attributes."worker.ticket" == "CTL-48"'
```

### Match by phase event (CTL-452 — phase-agent pipeline)

Phase-agent events follow the deterministic shape
`phase.<name>.<action>.<TICKET>` where `<name>` is one of the nine canonical phases
(triage, research, plan, implement, verify, review, pr, monitor-merge, monitor-deploy),
`<action>` is `dispatched`, `complete`, or `failed`, and `<TICKET>` is the Linear key
(e.g. `CTL-48`). The broker's `phase_lifecycle` interest matches the same regex
deterministically — see [Phase agents](/reference/orchestration/phase-agents/).

```bash
# All phase-agent events
--filter '.attributes."event.name" | startswith("phase.")'

# All phase events for one ticket
--filter '(.attributes."event.name" | startswith("phase.")) and (.attributes."event.name" | endswith(".CTL-48"))'

# A single phase complete (exact match)
--filter '.attributes."event.name" == "phase.research.complete.CTL-48"'

# All phase failures across every ticket
--filter '.attributes."event.name" | test("^phase\\.[^.]+\\.failed\\.")'

# All `implement` phase events across every ticket (any action, any ticket)
--filter '.attributes."event.name" | test("^phase\\.implement\\.")'
```

### Match a ticket_lifecycle interest (CTL-303)

```bash
# Wait for any state change on a Linear ticket — the broker's deterministic
# ticket_lifecycle router computes the wake.
catalyst-events wait-for \
  --filter '.attributes."event.name" | startswith("filter.wake.")' \
  --timeout 600
```

### Match the comms feed

```bash
# broker wake event (CTL-303) — emitted when comms.message.posted arrives for a watched channel
catalyst-events tail \
  --filter '.attributes."event.name" == "comms.message.posted" and .attributes."comms.channel" == "orch-ctl-ux"'
```

### PR lifecycle — wait for any status change

```bash
catalyst-events wait-for \
  --filter '(
    (.attributes."vcs.pr.number" == 87 or (.body.payload.prNumbers // [] | contains([87])))
    and (
      .attributes."event.name" == "github.pr.merged" or
      .attributes."event.name" == "github.check_suite.completed" or
      (.attributes."event.name" | startswith("github.pr_review")) or
      .attributes."event.name" == "github.push"
    )
  )' \
  --timeout 180
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CATALYST_DIR` | `~/catalyst` | Root directory for all Catalyst runtime state |
| `CATALYST_EVENTS_DIR` | `$CATALYST_DIR/events` | Directory containing monthly JSONL log files |

Setting `CATALYST_EVENTS_DIR` overrides the log file location without changing other runtime
paths. Useful when testing with a separate log directory.

## Related

- [Event architecture](./events/) — how signal files, global state, and the SSE stream connect
- [Event flow](./event-flow/) — end-to-end: how a GitHub push becomes a `wait-for` wake
- [GitHub webhooks for orch-monitor](./webhooks/) — configure near-real-time event delivery
- Skill-author reference: `plugins/dev/skills/monitor-events/SKILL.md`
