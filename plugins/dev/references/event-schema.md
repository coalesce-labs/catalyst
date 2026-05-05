# Catalyst Event Schema Reference

Authoritative field-level reference for all event types in `~/catalyst/events/YYYY-MM.jsonl`.
Derived directly from the TypeScript source (`orch-monitor/lib/`) and bash scripts in `plugins/dev/scripts/`.

Use this when writing `catalyst-events wait-for --filter` or `catalyst-events tail --filter`
expressions to avoid guessing field names. Wrong field names silently never match.

---

## Envelope formats

Two schemas coexist in the same JSONL file.

### v2 — webhook-sourced (TypeScript)

Written by the orch-monitor webhook receiver. Source: `lib/event-log.ts`.

```json
{
  "ts": "2026-05-05T19:00:00.000Z",
  "id": "evt_abc123",
  "schemaVersion": 2,
  "source": "github.webhook",
  "event": "github.pr.merged",
  "scope": {
    "repo": "org/repo",
    "pr": 342,
    "orchestrator": "orch-foo",
    "worker": null
  },
  "detail": { "action": "closed", "merged": true, "mergedAt": "2026-05-05T19:00:00Z", "draft": false, "mergeable": null },
  "orchestrator": "orch-foo",
  "worker": null
}
```

`scope` fields are all optional. Flat `orchestrator`/`worker` duplicate `scope.orchestrator`/`scope.worker` for backward compatibility. GitHub events: `source = "github.webhook"`. Linear events: `source = "linear.webhook"`.

### v1 — bash-sourced

Written by `catalyst-session.sh`, `catalyst-state.sh`, `catalyst-comms`, and `filter-daemon`.

**Session/heartbeat format** (`catalyst-session.sh`):
```json
{ "ts": "2026-05-05T19:00:00.000Z", "session": "sess_abc123", "event": "phase-changed", "detail": { "to": "implementing", "phase": 3 } }
```

**Orchestrator/comms/filter format** (`catalyst-state.sh`, `catalyst-comms`, `filter-daemon`):
```json
{ "ts": "2026-05-05T19:00:00.000Z", "orchestrator": "orch-foo", "worker": "CTL-210", "event": "attention-raised", "detail": { "attentionType": "waiting-for-user", "reason": "CI failed 3 times" } }
```

---

## GitHub events (v2 envelope, source: `github.webhook`)

### github.pr.{action}

Fired for every GitHub `pull_request` webhook action.

| Field | Value |
|---|---|
| `event` | `github.pr.opened`, `github.pr.closed`, `github.pr.merged`, `github.pr.synchronize`, `github.pr.labeled`, `github.pr.unlabeled`, `github.pr.edited`, `github.pr.ready_for_review`, etc. |
| `scope.repo` | `"org/repo"` |
| `scope.pr` | PR number (integer) |
| `detail.action` | Raw GitHub action string |
| `detail.merged` | `true` / `false` |
| `detail.mergedAt` | ISO timestamp or `null` |
| `detail.draft` | `true` / `false` |
| `detail.mergeable` | `true` / `false` / `null` |

**`github.pr.merged` fires exactly once** — only when `action="closed"` AND `merged=true` simultaneously. Subsequent webhooks on an already-merged PR (label, edit, etc.) emit `github.pr.{action}`, not `github.pr.merged`.

```json
{
  "event": "github.pr.merged",
  "scope": { "repo": "org/repo", "pr": 342 },
  "detail": { "action": "closed", "merged": true, "mergedAt": "2026-05-05T18:00:00Z", "draft": false, "mergeable": null }
}
```

---

### github.pr_review.{action}

| Field | Value |
|---|---|
| `event` | `github.pr_review.submitted`, `github.pr_review.dismissed`, `github.pr_review.edited` |
| `scope.repo` | `"org/repo"` |
| `scope.pr` | PR number |
| `detail.state` | `"APPROVED"`, `"CHANGES_REQUESTED"`, `"COMMENTED"`, etc. |
| `detail.reviewer` | Reviewer login string |
| `detail.body` | Review body text |
| `detail.author.login` | Reviewer login |
| `detail.author.type` | `"User"`, `"Bot"`, `"Mannequin"` |

```json
{
  "event": "github.pr_review.submitted",
  "scope": { "repo": "org/repo", "pr": 342 },
  "detail": { "state": "APPROVED", "reviewer": "octocat", "body": "LGTM", "author": { "login": "octocat", "type": "User" } }
}
```

---

### github.pr_review_thread.{action}

| Field | Value |
|---|---|
| `event` | `github.pr_review_thread.resolved`, `github.pr_review_thread.unresolved` |
| `scope.repo` | `"org/repo"` |
| `scope.pr` | PR number |
| `detail.threadId` | Thread ID (integer) |

```json
{
  "event": "github.pr_review_thread.resolved",
  "scope": { "repo": "org/repo", "pr": 342 },
  "detail": { "threadId": 12345678 }
}
```

---

### github.check_suite.{status}

> **⚠ `.scope.pr` is absent.** PR numbers are in `detail.prNumbers` (integer array).
> Filter: `(.detail.prNumbers // [] | contains([${PR_NUMBER}]))`

| Field | Value |
|---|---|
| `event` | `github.check_suite.completed`, `github.check_suite.queued`, `github.check_suite.in_progress` |
| `scope.repo` | `"org/repo"` |
| `scope.pr` | **ABSENT** — not populated on check_suite events |
| `detail.conclusion` | `"success"`, `"failure"`, `"cancelled"`, `"skipped"`, `"timed_out"`, `null` |
| `detail.status` | `"completed"`, `"queued"`, `"in_progress"` |
| `detail.prNumbers` | `[342, 343]` — integer array of associated PRs |

```json
{
  "event": "github.check_suite.completed",
  "scope": { "repo": "org/repo" },
  "detail": { "conclusion": "success", "status": "completed", "prNumbers": [342] }
}
```

---

### github.status.{state}

| Field | Value |
|---|---|
| `event` | `github.status.success`, `github.status.failure`, `github.status.pending`, `github.status.error` |
| `scope.repo` | `"org/repo"` |
| `scope.sha` | Commit SHA |
| `detail.state` | `"success"`, `"failure"`, `"pending"`, `"error"` |

```json
{
  "event": "github.status.success",
  "scope": { "repo": "org/repo", "sha": "abc123def456" },
  "detail": { "state": "success" }
}
```

---

### github.push

> **⚠ `.scope.pr` is absent.** Use `.scope.ref` to match a branch.

| Field | Value |
|---|---|
| `event` | `github.push` |
| `scope.repo` | `"org/repo"` |
| `scope.ref` | `"refs/heads/main"` |
| `scope.sha` | Head commit SHA |
| `detail.baseSha` | Previous head SHA |
| `detail.headSha` | New head SHA |
| `detail.commits` | `[{id: "abc123", message: "feat: ..."}]` |

```json
{
  "event": "github.push",
  "scope": { "repo": "org/repo", "ref": "refs/heads/main", "sha": "abc123" },
  "detail": { "baseSha": "def456", "headSha": "abc123", "commits": [{ "id": "abc123", "message": "feat: add feature" }] }
}
```

---

### github.issue_comment.{action}

Only PR-attached comments are logged (issue-only comments are discarded by the parser).

| Field | Value |
|---|---|
| `event` | `github.issue_comment.created`, `github.issue_comment.edited`, `github.issue_comment.deleted` |
| `scope.repo` | `"org/repo"` |
| `scope.pr` | PR number |
| `detail.commentId` | Comment ID (integer) |
| `detail.body` | Comment text |
| `detail.htmlUrl` | GitHub URL |
| `detail.author.login` | Comment author login |
| `detail.author.type` | `"User"`, `"Bot"`, etc. |

---

### github.pr_review_comment.{action}

| Field | Value |
|---|---|
| `event` | `github.pr_review_comment.created`, `github.pr_review_comment.edited`, `github.pr_review_comment.deleted` |
| `scope.repo` | `"org/repo"` |
| `scope.pr` | PR number |
| `detail.commentId` | Comment ID (integer) |
| `detail.body` | Comment text |
| `detail.htmlUrl` | GitHub URL |
| `detail.author.login` | Author login |
| `detail.author.type` | `"User"`, `"Bot"`, etc. |

---

### github.deployment.created

| Field | Value |
|---|---|
| `event` | `github.deployment.created` |
| `scope.repo` | `"org/repo"` |
| `scope.environment` | `"production"`, `"staging"`, etc. |
| `scope.sha` | Deployment SHA |
| `scope.ref` | Ref name (branch or tag) |
| `detail.deploymentId` | Deployment ID (integer) |
| `detail.payloadUrl` | Payload URL or `null` |

---

### github.deployment_status.{state}

| Field | Value |
|---|---|
| `event` | `github.deployment_status.success`, `github.deployment_status.failure`, `github.deployment_status.pending`, `github.deployment_status.error`, `github.deployment_status.in_progress` |
| `scope.repo` | `"org/repo"` |
| `scope.environment` | `"production"`, `"staging"`, etc. |
| `detail.deploymentId` | Deployment ID (integer) |
| `detail.state` | `"success"`, `"failure"`, `"pending"`, etc. |
| `detail.targetUrl` | CI link or `null` |
| `detail.environmentUrl` | Live URL or `null` |

```json
{
  "event": "github.deployment_status.success",
  "scope": { "repo": "org/repo", "environment": "production" },
  "detail": { "deploymentId": 999, "state": "success", "targetUrl": null, "environmentUrl": "https://app.example.com" }
}
```

---

### github.release.{action}

| Field | Value |
|---|---|
| `event` | `github.release.published`, `github.release.created`, `github.release.edited`, `github.release.deleted`, `github.release.prereleased`, `github.release.released` |
| `scope.repo` | `"org/repo"` |
| `scope.tag` | Tag name (e.g. `"v8.0.0"`) |
| `detail.action` | GitHub action string |
| `detail.releaseId` | Release ID (integer) |
| `detail.name` | Release name |
| `detail.draft` | `true` / `false` |
| `detail.prerelease` | `true` / `false` |
| `detail.htmlUrl` | GitHub release URL |

---

### github.workflow_run.{action}

> **⚠ `.scope.pr` is absent.** PR numbers are in `detail.prNumbers` (integer array).
> Filter: `(.detail.prNumbers // [] | contains([${PR_NUMBER}]))`

| Field | Value |
|---|---|
| `event` | `github.workflow_run.completed`, `github.workflow_run.in_progress`, `github.workflow_run.requested` |
| `scope.repo` | `"org/repo"` |
| `scope.sha` | Head commit SHA |
| `scope.pr` | **ABSENT** — not populated on workflow_run events |
| `detail.action` | `"completed"`, `"in_progress"`, `"requested"` |
| `detail.runId` | Run ID (integer) |
| `detail.workflowId` | Workflow ID (integer) |
| `detail.name` | Workflow name (e.g. `"CI"`, `"Build"`) |
| `detail.headBranch` | Branch name |
| `detail.status` | `"completed"`, `"in_progress"`, `"queued"` |
| `detail.conclusion` | `"success"`, `"failure"`, `"cancelled"`, `"skipped"`, `null` |
| `detail.runNumber` | Sequential run number |
| `detail.htmlUrl` | GitHub Actions URL |
| `detail.prNumbers` | `[342]` — integer array |

```json
{
  "event": "github.workflow_run.completed",
  "scope": { "repo": "org/repo", "sha": "abc123" },
  "detail": { "action": "completed", "runId": 12345, "workflowId": 678, "name": "CI", "headBranch": "my-feature", "status": "completed", "conclusion": "success", "runNumber": 42, "htmlUrl": "https://github.com/org/repo/actions/runs/12345", "prNumbers": [342] }
}
```

---

## Linear events (v2 envelope, source: `linear.webhook`)

### linear.issue.{topic}

| Field | Value |
|---|---|
| `event` | `linear.issue.created`, `linear.issue.state_changed`, `linear.issue.priority_changed`, `linear.issue.assignee_changed`, `linear.issue.updated`, `linear.issue.removed` |
| `scope.ticket` | Ticket identifier (e.g. `"CTL-210"`) or `undefined` if absent |
| `detail.action` | `"create"`, `"update"`, `"remove"` |
| `detail.ticket` | Ticket identifier or `null` |
| `detail.teamKey` | Team key (e.g. `"CTL"`) or `null` |
| `detail.updatedFromKeys` | Array of changed field names (e.g. `["stateId"]`) |
| `detail.actorId` | Linear user UUID who triggered the action, or `null` |

Update topic selection priority: `stateId` → `state_changed`; `priority` → `priority_changed`; `assigneeId` → `assignee_changed`; other → `updated`.

```json
{
  "event": "linear.issue.state_changed",
  "scope": { "ticket": "CTL-210" },
  "detail": { "action": "update", "ticket": "CTL-210", "teamKey": "CTL", "updatedFromKeys": ["stateId"], "actorId": "user-uuid-here" }
}
```

---

### linear.comment.{action}d

| Field | Value |
|---|---|
| `event` | `linear.comment.created`, `linear.comment.updated`, `linear.comment.removed` |
| `scope.ticket` | Ticket identifier or `undefined` |
| `detail.action` | `"create"`, `"update"`, `"remove"` |
| `detail.commentId` | Comment UUID or `null` |
| `detail.issueId` | Issue UUID or `null` |
| `detail.ticket` | Ticket identifier or `null` |

---

### linear.cycle.{action}d

| Field | Value |
|---|---|
| `event` | `linear.cycle.created`, `linear.cycle.updated`, `linear.cycle.removed` |
| `scope` | `{}` (empty — no ticket or repo) |
| `detail.action` | `"create"`, `"update"`, `"remove"` |
| `detail.cycleId` | Cycle UUID or `null` |
| `detail.teamKey` | Team key or `null` |

---

### linear.reaction.{action}d

| Field | Value |
|---|---|
| `event` | `linear.reaction.created`, `linear.reaction.updated`, `linear.reaction.removed` |
| `scope` | `{}` |
| `detail.action` | `"create"`, `"update"`, `"remove"` |
| `detail.reactionId` | Reaction UUID or `null` |

---

### linear.issue_label.{action}d

| Field | Value |
|---|---|
| `event` | `linear.issue_label.created`, `linear.issue_label.updated`, `linear.issue_label.removed` |
| `scope` | `{}` |
| `detail.action` | `"create"`, `"update"`, `"remove"` |
| `detail.labelId` | Label UUID or `null` |

---

## Catalyst session events (v1, source: `catalyst-session.sh`)

Format: `{ ts, session, event, detail }`

### session-started

```json
{ "ts": "...", "session": "sess_abc123", "event": "session-started",
  "detail": { "skill": "oneshot", "ticket": "CTL-210", "label": null, "workflow": null, "status": "researching" } }
```

| `detail` field | Type | Description |
|---|---|---|
| `skill` | string | Skill name that started the session |
| `ticket` | string \| null | Linear ticket key |
| `label` | string \| null | Human-readable label |
| `workflow` | string \| null | Parent workflow session ID |
| `status` | string | Initial status |

---

### phase-changed

```json
{ "ts": "...", "session": "sess_abc123", "event": "phase-changed",
  "detail": { "to": "implementing", "phase": 3 } }
```

| `detail` field | Type | Description |
|---|---|---|
| `to` | string | New status (e.g. `"researching"`, `"planning"`, `"implementing"`) |
| `phase` | number \| null | Phase number |

---

### pr-opened

```json
{ "ts": "...", "session": "sess_abc123", "event": "pr-opened",
  "detail": { "pr": 342, "url": "https://github.com/org/repo/pull/342", "ci": null } }
```

| `detail` field | Type | Description |
|---|---|---|
| `pr` | number | PR number |
| `url` | string \| null | PR URL |
| `ci` | string \| null | CI status |

---

### session-ended

```json
{ "ts": "...", "session": "sess_abc123", "event": "session-ended",
  "detail": { "status": "done" } }
```

| `detail` field | Type | Description |
|---|---|---|
| `status` | `"done"` \| `"failed"` | Terminal status |
| `reason` | string | (optional) Failure reason |

---

### heartbeat

```json
{ "ts": "...", "session": "sess_abc123", "event": "heartbeat", "detail": null }
```

---

### phase-iteration

```json
{ "ts": "...", "session": "sess_abc123", "event": "phase-iteration",
  "detail": { "kind": "fix", "count": 2, "by": 1 } }
```

| `detail` field | Type | Description |
|---|---|---|
| `kind` | `"plan"` \| `"fix"` | Iteration type |
| `count` | number | New cumulative count |
| `by` | number | Increment amount |

---

## Orchestrator lifecycle events (v1, source: `catalyst-state.sh`)

Format: `{ ts, orchestrator, worker, event, detail }`

### orchestrator-started

```json
{ "ts": "...", "orchestrator": "orch-foo", "worker": null, "event": "orchestrator-started",
  "detail": { "tickets": ["CTL-210", "CTL-211"] } }
```

### attention-raised

```json
{ "ts": "...", "orchestrator": "orch-foo", "worker": "CTL-210", "event": "attention-raised",
  "detail": { "attentionType": "waiting-for-user", "reason": "CI failed after 3 attempts" } }
```

### attention-resolved

```json
{ "ts": "...", "orchestrator": "orch-foo", "worker": "CTL-210", "event": "attention-resolved",
  "detail": null }
```

### orchestrator-failed

```json
{ "ts": "...", "orchestrator": "orch-foo", "worker": null, "event": "orchestrator-failed",
  "detail": { "reason": "heartbeat expired — presumed dead" } }
```

---

## Comms events (v1, source: `catalyst-comms`)

Format: `{ ts, orchestrator, worker, event, detail }`

### comms.message.posted

```json
{ "ts": "...", "orchestrator": "orch-foo", "worker": "CTL-210", "event": "comms.message.posted",
  "detail": { "channel": "orch-foo-2026-05-05", "type": "info", "msgId": "msg_abc123", "to": null } }
```

| `detail` field | Type | Description |
|---|---|---|
| `channel` | string | Channel name |
| `type` | string | Message type (`"info"`, `"attention"`, `"done"`) |
| `msgId` | string | Message ID |
| `to` | string \| null | Directed recipient (null = broadcast) |

---

## Filter daemon events (v1, source: `filter-daemon/index.mjs`)

Format: `{ ts, event, orchestrator, worker, detail }`

### filter.register (written by orchestrators)

```json
{ "ts": "...", "event": "filter.register", "orchestrator": "orch-foo", "worker": null,
  "detail": { "interest_id": "orch-foo", "notify_event": "filter.wake.orch-foo",
               "prompt": "any worker CI failure", "context": null, "persistent": false } }
```

| `detail` field | Type | Description |
|---|---|---|
| `interest_id` | string | Unique ID for this interest |
| `notify_event` | string | Event name the daemon will emit on match (default: `filter.wake.{id}`) |
| `prompt` | string | Natural language query for Groq classification |
| `context` | object \| null | Optional context (e.g. `{workers: ["CTL-210"]}`) |
| `persistent` | bool | If false, deregistered after first match |

### filter.deregister (written by orchestrators)

```json
{ "ts": "...", "event": "filter.deregister", "orchestrator": "orch-foo", "worker": null,
  "detail": { "interest_id": "orch-foo" } }
```

### filter.wake.{id} (written by filter-daemon on semantic match)

```json
{ "ts": "...", "event": "filter.wake.orch-foo", "orchestrator": "orch-foo", "worker": null,
  "detail": { "reason": "CI failure event matched worker CTL-210 interest",
               "source_event_ids": ["evt_abc123"], "interest_id": "orch-foo" } }
```

| `detail` field | Type | Description |
|---|---|---|
| `reason` | string | One sentence from Groq explaining the match |
| `source_event_ids` | string[] | IDs of events that triggered the match (empty for watchdog wakes) |
| `interest_id` | string | Interest that was matched |

---

## Filter pitfalls summary

| Event | Common mistake | Correct filter |
|---|---|---|
| `github.check_suite.*` | `.scope.pr == N` | `(.detail.prNumbers // [] \| contains([N]))` |
| `github.workflow_run.*` | `.scope.pr == N` | `(.detail.prNumbers // [] \| contains([N]))` |
| `github.push` | `.scope.pr == N` | `.scope.ref == "refs/heads/branch-name"` |
| `github.pr_review.*` | `.detail.state == "approved"` | `.detail.state == "APPROVED"` (uppercase) or add `\| ascii_downcase` |
| Any v1 event | `.scope.repo` / `.scope.pr` | `.event` / `.orchestrator` / `.worker` (no `scope` in v1) |
| `catalyst-events tail --since "5 minutes ago"` | `--since` flag does not exist | Use `--since-line <N>` with a line count offset |
