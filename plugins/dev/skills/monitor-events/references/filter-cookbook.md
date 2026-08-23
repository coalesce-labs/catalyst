# Filter Cookbook, Pattern 4, and Envelope Versions

_Read this when you need a ready-made jq filter, want to tail everything for a ticket (Pattern 4),
or need to understand v1/v2/canonical envelope differences._

## Filter cookbook

All `event.name` values are the canonical OTel form that appears on disk. The
authoritative list of actionable names for workers lives in
[[event-name-allowlist]]; the rows below are illustrative filters built from it.

| Need | Filter |
|---|---|
| All GitHub webhook events | `.attributes."event.name" \| startswith("github.")` |
| All Linear webhook events | `.attributes."event.name" \| startswith("linear.")` |
| One PR's merge | `.attributes."event.name" == "github.pr.merged" and .attributes."vcs.pr.number" == 342` |
| Any push to a branch | `.attributes."event.name" == "github.push" and .attributes."vcs.ref.name" == "refs/heads/main"` |
| CI completion | `.attributes."event.name" \| startswith("github.check_suite.")` |
| CI failure for one PR | `.attributes."event.name" == "github.check_suite.completed" and .attributes."cicd.pipeline.run.conclusion" == "failure" and (.body.payload.prNumbers // [] \| index(342) != null)` |
| Review changes-requested by a bot | `.attributes."event.name" == "github.pr_review.submitted" and .body.payload.state == "changes_requested" and .body.payload.author.type == "Bot"` |
| Comment from a human on a PR | `.attributes."event.name" == "github.issue_comment.created" and (.body.payload.author.type // "User") != "Bot"` |
| Linear ticket state change | `.attributes."event.name" == "linear.issue.state_changed" and .attributes."linear.issue.identifier" == "CTL-210"` |
| Comms message in one channel | `.attributes."event.name" == "comms.message.posted" and .body.payload.channel == "orch-foo"` |
| Routine worker phase transitions (info-tier, coalesced batches; CTL-229) | `.attributes."event.name" == "orchestrator.worker.phase_advanced"` |
| Worker terminal transitions (PR-created, merging, done, fail; CTL-229) | `.attributes."event.name" == "orchestrator.worker.status_terminal"` |
| One worker's terminal events with PR number | `.attributes."event.name" == "orchestrator.worker.status_terminal" and .attributes."catalyst.worker.ticket" == "CTL-210" and (.body.payload.pr.number // null)` |
| Worker reached terminal state | `.attributes."event.name" == "orchestrator.worker.done" or .attributes."event.name" == "orchestrator.worker.failed"` |
| PR review activity | `(.attributes."event.name" \| startswith("github.pr_review")) or (.attributes."event.name" == "github.issue_comment.created")` |
| Deploy outcome | `.attributes."event.name" \| startswith("github.deployment")` |
| Attention raised in this orchestrator | `.attributes."event.name" == "orchestrator.attention.raised" and .attributes."catalyst.orchestrator.id" == "orch-foo"` |

## Pattern 4 — Tail everything happening to a ticket

Useful for live debugging or operator dashboards:

```bash
# linear.issue.identifier for Linear-event context; catalyst.worker.ticket for worker/orchestrator context
catalyst-events tail --filter '.attributes."linear.issue.identifier" == "CTL-210" or .attributes."catalyst.worker.ticket" == "CTL-210"'
```

Captures GitHub PR events scoped to that ticket, Linear webhook events for the issue,
comms posts where the ticket is the from/parent, and orchestrator/worker lifecycle events.

## v1 vs v2 vs canonical envelopes

The event log carries two legacy schemas plus the new canonical shape (CTL-300):

- **v1** (bash writers, `catalyst-state.sh event`): `{ ts, event, orchestrator, worker, detail }`
- **v2** (TypeScript writers, webhook receiver, CTL-209+): adds `id`, `schemaVersion: 2`,
  `source`, `scope` (replacing flat `orchestrator` / `worker` with a nested object;
  v2 still emits the flat fields too as backward-compat aliases).
- **canonical** (CTL-300+): OTel-shaped envelope with `attributes."event.name"`, `attributes."vcs.pr.number"`,
  etc. All new producers emit canonical; filters in this doc target canonical paths.

Filters that read `.attributes."vcs.repository.name"` / `.attributes."vcs.pr.number"` /
`.attributes."linear.issue.identifier"` only match canonical envelopes. Filters that read
`.attributes."event.name"` work for canonical; `.event` / `.worker` / `.orchestrator` work for
v1/v2. Choose based on which sources you need to match — webhook events use canonical,
orchestrator events may still use v1/v2.
