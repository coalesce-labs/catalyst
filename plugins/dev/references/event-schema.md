# Catalyst Event Schema Reference

Authoritative field-level reference for all event types in `~/catalyst/events/YYYY-MM.jsonl`.
Derived directly from `plugins/dev/scripts/orch-monitor/lib/canonical-event.ts` and
`plugins/dev/scripts/lib/canonical-event.sh`.

Use this when writing `catalyst-events wait-for --filter` or `catalyst-events tail --filter`
expressions to avoid guessing field names. Wrong field names silently never match.

This schema was introduced as a breaking cutover in CTL-300. All producers emit the canonical
envelope. Legacy v1/v2 files on disk were rotated to `*.legacy.jsonl` on first canonical write.
A future OTLP exporter sidecar (CTL-306) will transcode canonical JSONL to OTLP wire format.

---

## Canonical envelope

Every event in `~/catalyst/events/YYYY-MM.jsonl` has this shape. One canonical envelope per line.

```json
{
  "ts": "2026-05-08T18:00:00.000Z",
  "observedTs": "2026-05-08T18:00:00.001Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "traceId": "a3f1c2d4e5b6c7d8e9f0a1b2c3d4e5f6",
  "spanId": "b4d5e6f7a8b9c0d1",
  "resource": {
    "service.name": "catalyst.github",
    "service.namespace": "catalyst",
    "service.version": "8.2.0"
  },
  "attributes": {
    "event.name": "github.pr.merged",
    "event.entity": "pr",
    "event.action": "merged",
    "event.label": "PR #342",
    "event.channel": "webhook",
    "vcs.repository.name": "org/repo",
    "vcs.pr.number": 342
  },
  "body": {
    "message": "PR #342 merged in org/repo",
    "payload": { "merged": true, "mergedAt": "2026-05-08T18:00:00Z", "draft": false, "mergeable": null }
  }
}
```

This shape is intentionally close to OTel `LogRecord` — it is *projectable* to OTLP/JSON by a
future sidecar. It is **not** OTLP wire format directly. OTLP requires nesting under
`resourceLogs[0].scopeLogs[0].logRecords[0]` and wrapping every value in `AnyValue`, which is
hostile for jq. The sidecar (CTL-306) handles that translation mechanically.

---

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `ts` | string (ISO 8601) | yes | When the event happened |
| `observedTs` | string (ISO 8601) | no | When the writer/collector saw it. Defaults to `ts`. |
| `severityText` | `"DEBUG"` \| `"INFO"` \| `"WARN"` \| `"ERROR"` | yes | Human-readable severity |
| `severityNumber` | number | yes | OTel severity number — see table below |
| `traceId` | string (32 hex) \| null | yes | Trace context — null for ambient events |
| `spanId` | string (16 hex) \| null | yes | Span context — null for ambient events |
| `parentSpanId` | string (16 hex) \| null | no | Set when a span has a parent span |
| `resource` | object | yes | Who emitted — service name, namespace, version |
| `attributes` | object | yes | Typed key-value pairs. Keys may contain dots; always double-quote them in jq. |
| `body` | object | yes | `body.message` (human-readable) + `body.payload` (structured) |

### Severity numbers

| severityText | severityNumber | When to use |
|---|---|---|
| `DEBUG` | 5 | Heartbeats, filter-daemon empty wakes |
| `INFO` | 9 | Normal lifecycle events (default) |
| `WARN` | 13 | `attention-raised`, `worker-revived`, `worker-launch-failed`, CI failure on non-merge runs |
| `ERROR` | 17 | `worker-failed`, `orchestrator-failed`, `deployment_status.failure`, `deployment_status.error` |

---

## Resource conventions

`resource.service.namespace` is always `"catalyst"`. `resource.service.version` comes from
`.claude-plugin/plugin.json`. Valid `service.name` values:

| service.name | Producer |
|---|---|
| `catalyst.github` | TS webhook handler (`lib/webhook-handler.ts`) |
| `catalyst.linear` | TS webhook handler (`lib/linear-webhook-handler.ts`) |
| `catalyst.session` | Bash (`catalyst-session.sh`) |
| `catalyst.orchestrator` | Bash (`catalyst-state.sh`, `emit-worker-status-change.sh`) |
| `catalyst.comms` | Bash (`catalyst-comms`) |
| `catalyst.filter` | Bash/daemon (`filter-daemon/index.mjs`) |

---

## Attribute conventions

Attribute names contain dots. In jq, always double-quote them: `.attributes."event.name"`.

### `event.*` — catalyst-internal classifier

| Attribute | Type | Description |
|---|---|---|
| `event.name` | string | Dotted: `github.pr.merged`, `session.phase`, `comms.message.posted`, etc. Always present. |
| `event.entity` | string | Entity type: `pr`, `issue`, `check_suite`, `session`, `worker`, `attention`, … |
| `event.action` | string | Action: `merged`, `opened`, `phase`, `attention`, `dispatched`, … |
| `event.label` | string | Primary human-readable identifier: `PR #342`, `CTL-210`, a session id, an interest_id |
| `event.value` | string \| number | Secondary value: `success`, a phase number, etc. |
| `event.channel` | `"webhook"` \| `"sme.io"` | Transport channel. Absent on bash-emitted events. |

### `catalyst.*` — catalyst entities

| Attribute | Type | Description |
|---|---|---|
| `catalyst.orchestrator.id` | string | Orchestration run identifier |
| `catalyst.worker.ticket` | string | Worker ticket key (e.g. `CTL-210`) |
| `catalyst.session.id` | string | Claude session ID (human-readable, for joining) |
| `catalyst.phase` | number | Current phase number |

### `vcs.*` — OTel VCS semconv

| Attribute | Type | Description |
|---|---|---|
| `vcs.repository.name` | string | `"org/repo"` |
| `vcs.pr.number` | number | PR number (integer) |
| `vcs.ref.name` | string | Branch or tag ref (e.g. `"refs/heads/main"`) |
| `vcs.revision` | string | Commit SHA |

### `cicd.*` — OTel CI/CD semconv

| Attribute | Type | Description |
|---|---|---|
| `cicd.pipeline.run.id` | number | GitHub Actions run ID |
| `cicd.pipeline.run.conclusion` | string | `"success"`, `"failure"`, `"cancelled"`, `"skipped"`, `"timed_out"` |
| `cicd.pipeline.name` | string | Workflow name (e.g. `"CI"`) |

### `linear.*` — catalyst-defined (no OTel semconv yet)

| Attribute | Type | Description |
|---|---|---|
| `linear.issue.identifier` | string | Ticket identifier (e.g. `"CTL-210"`) |
| `linear.team.key` | string | Team key (e.g. `"CTL"`) |
| `linear.actor.id` | string | Linear user UUID who triggered the action |

### `deployment.*` — OTel deployment semconv

| Attribute | Type | Description |
|---|---|---|
| `deployment.environment` | string | `"production"`, `"staging"`, etc. |
| `deployment.id` | number | GitHub deployment ID |

---

## Event naming

`event.name` is always `<source-prefix>.<entity>.<action>`, lowercase, dot-separated. The source
prefix is `resource.service.name` with the `catalyst.` namespace stripped:

| resource.service.name | event.name prefix |
|---|---|
| `catalyst.github` | `github` |
| `catalyst.linear` | `linear` |
| `catalyst.session` | `session` |
| `catalyst.orchestrator` | `orchestrator` |
| `catalyst.comms` | `comms` |
| `catalyst.filter` | `filter` |

---

## Trace and span ID derivation

IDs are derived deterministically from orchestrator/worker identifiers. Any producer (TS or bash)
computes the same IDs from the same inputs without coordination.

```
traceId = sha256(orchestratorId).slice(0, 32)
       OR sha256("standalone:" + sessionId).slice(0, 32)
       OR null (ambient event — GitHub webhooks, bare filter events)

spanId  = sha256(workerTicket).slice(0, 16)
       OR sha256(sessionId).slice(0, 16)
       OR null
```

Both are hex-truncated SHA-256. OTel requires 32-hex trace IDs and 16-hex span IDs.
`attributes."catalyst.session.id"` stores the human-readable Claude session ID alongside for joining.

GitHub webhook events carry `traceId: null, spanId: null` — they are ambient events not
inherently correlated to a worker. Correlation is done by consumers that join
`attributes."vcs.pr.number"` to a worker's known PR.

---

## Wire format

JSONL at `~/catalyst/events/YYYY-MM.jsonl`. One canonical envelope per line, no pretty-printing.
On first canonical write, if the existing file's first line lacks an `attributes` field
(legacy v1/v2 detection), the file is rotated to `*.legacy.jsonl` before appending — this is a
one-time migration, already complete on any installation that ran CTL-300.

---

## One worked example per producer

### `github.pr.merged` — catalyst.github webhook

`github.pr.merged` fires exactly once: when `action="closed"` AND `merged=true` simultaneously.

```json
{
  "ts": "2026-05-08T18:00:00.000Z",
  "observedTs": "2026-05-08T18:00:00.001Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "traceId": null,
  "spanId": null,
  "resource": {
    "service.name": "catalyst.github",
    "service.namespace": "catalyst",
    "service.version": "8.2.0"
  },
  "attributes": {
    "event.name": "github.pr.merged",
    "event.entity": "pr",
    "event.action": "merged",
    "event.label": "PR #342",
    "event.channel": "webhook",
    "vcs.repository.name": "org/repo",
    "vcs.pr.number": 342
  },
  "body": {
    "message": "PR #342 merged in org/repo",
    "payload": { "merged": true, "mergedAt": "2026-05-08T18:00:00Z", "draft": false, "mergeable": null }
  }
}
```

`traceId`/`spanId` are null — GitHub events are ambient. `event.channel` = `"webhook"`.

**check_suite and workflow_run PR resolution**: `vcs.pr.number` is set only when the associated
`prNumbers` array has exactly one element. When multiple PRs are associated, `vcs.pr.number` is
absent and the consumer must check `body.payload.prNumbers`. Use:
```
(.attributes."vcs.pr.number" == $PR) or (.body.payload.prNumbers // [] | index($PR) != null)
```

---

### `linear.issue.state_changed` — catalyst.linear webhook

```json
{
  "ts": "2026-05-08T18:05:00.000Z",
  "observedTs": "2026-05-08T18:05:00.002Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "traceId": null,
  "spanId": null,
  "resource": {
    "service.name": "catalyst.linear",
    "service.namespace": "catalyst",
    "service.version": "8.2.0"
  },
  "attributes": {
    "event.name": "linear.issue.state_changed",
    "event.entity": "issue",
    "event.action": "state_changed",
    "event.label": "CTL-210",
    "event.channel": "webhook",
    "linear.issue.identifier": "CTL-210",
    "linear.team.key": "CTL",
    "linear.actor.id": "user-uuid-here"
  },
  "body": {
    "message": "linear.issue.state_changed CTL-210",
    "payload": { "action": "update", "updatedFromKeys": ["stateId"] }
  }
}
```

Update topic selection: `stateId` → `state_changed`; `priority` → `priority_changed`;
`assigneeId` → `assignee_changed`; other → `updated`.

---

### `session.phase` — catalyst.session bash

`traceId`/`spanId` are derived from orch/session context at emit time.

```json
{
  "ts": "2026-05-08T18:10:00.000Z",
  "observedTs": "2026-05-08T18:10:00.000Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "traceId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
  "spanId": "d4e5f6a7b8c9d0e1",
  "resource": {
    "service.name": "catalyst.session",
    "service.namespace": "catalyst",
    "service.version": "8.2.0"
  },
  "attributes": {
    "event.name": "session.phase",
    "event.entity": "session",
    "event.action": "phase",
    "event.label": "sess_abc123",
    "catalyst.session.id": "sess_abc123",
    "catalyst.orchestrator.id": "orch-foo",
    "catalyst.worker.ticket": "CTL-210",
    "catalyst.phase": 3
  },
  "body": {
    "message": "phase-changed sess_abc123 → phase 3",
    "payload": { "to": "implementing", "phase": 3 }
  }
}
```

ID derivation for this envelope:
- `traceId = sha256("orch-foo").slice(0, 32)` — because an orchestrator is present
- `spanId = sha256("CTL-210").slice(0, 16)` — because a worker ticket is present
- For a standalone (non-orchestrated) session: `traceId = sha256("standalone:sess_abc123").slice(0, 32)`, `spanId = sha256("sess_abc123").slice(0, 16)`

---

### `orchestrator.worker.status_terminal` — catalyst.orchestrator bash

Emitted by `emit-worker-status-change.sh` when a worker reaches a terminal state. `event.value`
mirrors the `to` state so HUD/filter can check it without descending into payload.

```json
{
  "ts": "2026-05-08T18:15:00.000Z",
  "observedTs": "2026-05-08T18:15:00.000Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "traceId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
  "spanId": "d4e5f6a7b8c9d0e1",
  "resource": {
    "service.name": "catalyst.orchestrator",
    "service.namespace": "catalyst",
    "service.version": "8.2.0"
  },
  "attributes": {
    "event.name": "orchestrator.worker.status_terminal",
    "event.entity": "worker",
    "event.action": "status_terminal",
    "event.label": "CTL-210",
    "event.value": "done",
    "catalyst.orchestrator.id": "orch-foo",
    "catalyst.worker.ticket": "CTL-210"
  },
  "body": {
    "message": "worker CTL-210 status_terminal → done",
    "payload": { "from": "implementing", "to": "done", "pr": 342 }
  }
}
```

---

### `comms.message.posted` — catalyst.comms bash (including attention variant)

Normal posted message (`severityText: "INFO"`):

```json
{
  "ts": "2026-05-08T18:20:00.000Z",
  "observedTs": "2026-05-08T18:20:00.000Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "traceId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
  "spanId": "d4e5f6a7b8c9d0e1",
  "resource": {
    "service.name": "catalyst.comms",
    "service.namespace": "catalyst",
    "service.version": "8.2.0"
  },
  "attributes": {
    "event.name": "comms.message.posted",
    "event.entity": "comms",
    "event.action": "posted",
    "event.label": "CTL-210",
    "catalyst.orchestrator.id": "orch-foo",
    "catalyst.worker.ticket": "CTL-210"
  },
  "body": {
    "message": "comms.message.posted from CTL-210",
    "payload": { "channel": "orch-foo-2026-05-08", "type": "info", "msgId": "msg_abc123", "to": null, "body": "Implementing phase 3 now." }
  }
}
```

Attention variant — `event.action` is overridden to `"attention"` and `severityText` becomes
`"WARN"`. `event.name` stays `"comms.message.posted"` for OTLP parity. Filter on either:
- `event.action`: `.attributes."event.action" == "attention"`
- severity: `.severityNumber >= 13`

```json
{
  "severityText": "WARN",
  "severityNumber": 13,
  "attributes": {
    "event.name": "comms.message.posted",
    "event.action": "attention",
    "event.value": "attention"
  }
}
```

---

### `filter.wake` — catalyst.filter

The `interest_id` is in `event.label` and `body.payload.interest_id`, not in the event name.
Filters that previously matched `.event == "filter.wake.${id}"` now match:
`.attributes."event.name" == "filter.wake" and .attributes."event.label" == "${id}"`.

```json
{
  "ts": "2026-05-08T18:25:00.000Z",
  "observedTs": "2026-05-08T18:25:00.000Z",
  "severityText": "INFO",
  "severityNumber": 9,
  "traceId": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
  "spanId": null,
  "resource": {
    "service.name": "catalyst.filter",
    "service.namespace": "catalyst",
    "service.version": "8.2.0"
  },
  "attributes": {
    "event.name": "filter.wake",
    "event.entity": "filter",
    "event.action": "wake",
    "event.label": "orch-foo"
  },
  "body": {
    "message": "filter.wake orch-foo",
    "payload": {
      "reason": "CI failure event matched worker CTL-210 interest",
      "source_event_ids": [],
      "interest_id": "orch-foo"
    }
  }
}
```

---

## All event names by producer

### catalyst.github

| event.name | entity | action | severity | vcs.pr.number | notes |
|---|---|---|---|---|---|
| `github.pr.{action}` | `pr` | `{action}` | INFO | yes | merged, opened, closed, synchronize, labeled, etc. |
| `github.pr_review.{action}` | `pr_review` | `{action}` | INFO | yes | submitted, dismissed, edited |
| `github.pr_review_thread.{state}` | `pr_review_thread` | `{state}` | INFO | yes | resolved, unresolved |
| `github.check_suite.{status}` | `check_suite` | `{status}` | INFO (WARN if conclusion=failure) | only if single PR | `body.payload.prNumbers` for multi-PR |
| `github.status.{state}` | `status` | `{state}` | INFO/WARN/ERROR | no | `vcs.revision` = sha |
| `github.push` | `push` | `pushed` | INFO | no | `vcs.ref.name`, `vcs.revision` |
| `github.issue_comment.{action}` | `issue_comment` | `{action}` | INFO | yes | PR-attached only |
| `github.pr_review_comment.{action}` | `pr_review_comment` | `{action}` | INFO | yes | |
| `github.deployment.created` | `deployment` | `created` | INFO | no | `deployment.environment`, `deployment.id` |
| `github.deployment_status.{state}` | `deployment_status` | `{state}` | INFO/ERROR | no | ERROR on failure/error states |
| `github.release.{action}` | `release` | `{action}` | INFO | no | `event.label` = tag name |
| `github.workflow_run.{action}` | `workflow_run` | `{action}` | INFO (WARN if conclusion=failure) | only if single PR | `cicd.pipeline.run.id`, `cicd.pipeline.name` |

### catalyst.linear

| event.name | entity | action | severity | attributes |
|---|---|---|---|---|
| `linear.issue.{topic}` | `issue` | `{topic}` | INFO | `linear.issue.identifier`, `linear.team.key`, `linear.actor.id` |
| `linear.comment.{action}` | `comment` | `{action}` | INFO | `linear.issue.identifier?` |
| `linear.cycle.{action}` | `cycle` | `{action}` | INFO | `linear.team.key?` |
| `linear.reaction.{action}` | `reaction` | `{action}` | INFO | — |
| `linear.issue_label.{action}` | `issue_label` | `{action}` | INFO | — |

### catalyst.session

| event.name | entity | action | severity | notes |
|---|---|---|---|---|
| `session.started` | `session` | `started` | INFO | `body.payload` = `{skill, ticket, label, workflow, status}` |
| `session.phase` | `session` | `phase` | INFO | `catalyst.phase` attribute; `body.payload` = `{to, phase}` |
| `session.iteration` | `session` | `iteration` | INFO | `body.payload` = `{kind, count, by}` |
| `session.pr_opened` | `pr` | `opened` | INFO | `vcs.pr.number`; `body.payload` = `{pr, url, ci}` |
| `session.ended` | `session` | `ended` | INFO (ERROR if failed) | `body.payload` = `{status, reason?}` |
| `session.heartbeat` | `session` | `heartbeat` | DEBUG | `body.payload` = null |

### catalyst.orchestrator

| event.name | entity | action | severity | notes |
|---|---|---|---|---|
| `orchestrator.started` | `orchestrator` | `started` | INFO | `body.payload` = `{tickets}` |
| `orchestrator.failed` | `orchestrator` | `failed` | ERROR | `body.payload` = `{reason}` |
| `orchestrator.archived` | `orchestrator` | `archived` | INFO | `body.payload` = `{reason?}` |
| `orchestrator.worker.dispatched` | `worker` | `dispatched` | INFO | |
| `orchestrator.worker.pr_created` | `pr` | `created` | INFO | `vcs.pr.number` |
| `orchestrator.worker.pr_merged` | `pr` | `merged` | INFO | `vcs.pr.number` |
| `orchestrator.worker.done` | `worker` | `done` | INFO | |
| `orchestrator.worker.failed` | `worker` | `failed` | ERROR | `body.payload` = `{reason}` |
| `orchestrator.worker.launch_failed` | `worker` | `launch_failed` | WARN | `body.payload` = `{pid, graceSeconds}` |
| `orchestrator.worker.revived` | `worker` | `revived` | WARN | `body.payload` = `{pid, sessionId, reviveCount, reason}` |
| `orchestrator.worker.status_terminal` | `worker` | `status_terminal` | INFO | `event.value` = terminal state; `body.payload` = `{from, to, pr?}` |
| `orchestrator.worker.phase_advanced` | `worker` | `phase_advanced` | INFO | `body.payload` = `{windowSec, changes}` |
| `orchestrator.attention.raised` | `attention` | `raised` | WARN | `body.payload` = `{attentionType, reason}` |
| `orchestrator.attention.resolved` | `attention` | `resolved` | INFO | |

### catalyst.comms

| event.name | event.action | severity | notes |
|---|---|---|---|
| `comms.message.posted` | `posted` | INFO | Normal message |
| `comms.message.posted` | `attention` | WARN | Attention message; `event.value = "attention"` |

### catalyst.filter

| event.name | entity | action | severity | notes |
|---|---|---|---|---|
| `filter.register` | `filter` | `register` | INFO | `body.payload` = `{interest_id, notify_event, prompt, context, persistent}` |
| `filter.deregister` | `filter` | `deregister` | INFO | `body.payload` = `{interest_id}` |
| `filter.wake` | `filter` | `wake` | INFO | `event.label` = interest_id; `body.payload` = `{reason, source_event_ids, interest_id}` |

---

## jq predicate cheatsheet

Attribute names contain dots — **always double-quote them in jq**. Single-quoting the outer
expression is the simplest approach:

```bash
# Match by event name
jq -c 'select(.attributes."event.name" == "github.pr.merged")'

# Match by event name (any pr action)
jq -c 'select(.attributes."event.name" | startswith("github.pr."))'

# PR number — direct attribute
jq -c 'select(.attributes."vcs.pr.number" == 342)'

# PR number — check_suite/workflow_run (may be in body.payload.prNumbers if multi-PR)
jq -c --argjson pr 342 'select(
  (.attributes."vcs.pr.number" == $pr) or
  (.body.payload.prNumbers // [] | index($pr) != null)
)'

# Severity filter
jq -c 'select(.severityNumber >= 13)'       # WARN and above
jq -c 'select(.severityText == "ERROR")'

# Repository filter
jq -c 'select(.attributes."vcs.repository.name" == "org/repo")'

# Commit SHA
jq -c 'select(.attributes."vcs.revision" | startswith("abc123"))'

# Branch ref
jq -c 'select(.attributes."vcs.ref.name" == "refs/heads/main")'

# Deployment environment
jq -c 'select(.attributes."deployment.environment" == "production")'

# CI pipeline conclusion
jq -c 'select(.attributes."cicd.pipeline.run.conclusion" == "failure")'

# Linear ticket
jq -c 'select(.attributes."linear.issue.identifier" == "CTL-210")'

# Worker ticket
jq -c 'select(.attributes."catalyst.worker.ticket" == "CTL-210")'

# Body payload field
jq -c 'select(.body.payload.status == "done")'

# filter.wake for a specific interest
jq -c 'select(.attributes."event.name" == "filter.wake" and .attributes."event.label" == "orch-foo")'

# Attention messages (two equivalent expressions)
jq -c 'select(.attributes."event.action" == "attention")'
jq -c 'select(.severityNumber == 13 and (.attributes."event.name" | startswith("comms.")))'
```

---

## Filter pitfalls

| Scenario | Common mistake | Correct expression |
|---|---|---|
| `check_suite` / `workflow_run` PR | `.attributes."vcs.pr.number" == N` alone | Also check `.body.payload.prNumbers // [] \| index(N) != null` |
| `github.push` | `.attributes."vcs.pr.number"` | Push events have no PR; use `.attributes."vcs.ref.name"` |
| PR review state casing | `.body.payload.state == "approved"` | `.body.payload.state == "APPROVED"` or add `\| ascii_downcase` |
| GitHub events orchestrator | `.attributes."catalyst.orchestrator.id"` | Always null on GitHub events — do not filter by it |
| `filter.wake` for specific id | `.attributes."event.name" == "filter.wake.${id}"` | `.attributes."event.name" == "filter.wake" and .attributes."event.label" == "${id}"` |
| Attribute dot-notation in jq | `.attributes.event.name` | `.attributes."event.name"` (must double-quote) |
