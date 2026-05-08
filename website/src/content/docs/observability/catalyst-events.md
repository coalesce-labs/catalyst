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

# Only GitHub webhook events
catalyst-events tail --filter '.event | startswith("github.")'

# Linear issue state changes for a specific ticket
catalyst-events tail --filter '.event == "linear.issue.state_changed" and .body.payload.identifier == "CTL-48"'

# All worker lifecycle events
catalyst-events tail --filter '.event | startswith("worker-")'

# Events for one orchestrator
catalyst-events tail --filter '.orchestrator == "orch-ctl-2026-05-01"'

# Comms messages on a specific channel
catalyst-events tail --filter '.event == "comms.message.posted" and .attributes."comms.channel" == "orch-ctl-ux"'
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
  --filter '.event == "github.check_suite.completed" and (.body.payload.prNumbers // [] | contains([87]))' \
  --timeout 120

# Wait for a specific PR to merge
catalyst-events wait-for \
  --filter '.event == "github.pr.merged" and .attributes."vcs.pr.number" == 87'

# Wait for a filter daemon wake event (CTL-269 semantic interests)
catalyst-events wait-for \
  --filter '.attributes."event.name" == "filter.wake" and .attributes."event.label" == "sess_abc123"' \
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
[Setting up the webhook tunnel](./setup/#5-set-up-the-webhook-tunnel).

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

The unified event log contains events from multiple writers. Two envelope shapes coexist:

### v1 envelope (legacy)

Written by `catalyst-state.sh event` and most bash skills:

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

### v2 envelope (OTel-shaped)

Written by the webhook receiver (`lib/webhook-events.ts`) and `catalyst-comms send` (CTL-300):

```json
{
  "ts": "2026-05-01T12:00:00Z",
  "attributes": {
    "event.name": "github.pr.merged",
    "vcs.pr.number": 87,
    "vcs.revision": "abc123def456"
  },
  "body": {
    "payload": { "...full webhook payload..." }
  },
  "resource": {
    "service.name": "orch-monitor"
  }
}
```

Top-level fields: `ts`, `attributes` (OTel attribute map), `body`, `resource`. The `.event`
shorthand field is absent — use `.attributes."event.name"` instead.

### Identifying the envelope version

```bash
# v1 events have a top-level .event field
catalyst-events tail --filter '.event != null'

# v2 events have .attributes."event.name"
catalyst-events tail --filter '.attributes."event.name" != null'
```

Both shapes coexist indefinitely. New tools should write v2; `catalyst-state.sh event`
continues to write v1 for backward compatibility.

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
--filter '.event | startswith("worker-")'                     # v1 worker lifecycle
--filter '.attributes."event.name" | startswith("github.")'  # v2 GitHub webhook
--filter '.attributes."event.name" | startswith("linear.")'  # v2 Linear webhook
```

### Match by orchestrator scope

```bash
# v1 orchestrator events
--filter '.orchestrator == "orch-ctl-2026-05-01"'

# v2 events don't carry .orchestrator — filter by session or ticket instead
--filter '.attributes."worker.ticket" == "CTL-48"'
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
