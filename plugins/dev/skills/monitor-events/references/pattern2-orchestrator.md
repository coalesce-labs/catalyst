# Pattern 2 — Long-lived orchestrator wakes on multiple event types

_Read this when wiring up the orchestrator's Phase 4 Monitor loop, or when building a scope-aware multi-event filter for a long-lived session._

The orchestrator's Phase 4 used to poll every 2–3 minutes for every active worker. With CTL-210, the orchestrator runs a `Monitor` watching all PR/CI/push/lifecycle events, and the reactive scan drops to a 10-minute idle fallback as the safety net (CTL-243).

**Preferred (when `catalyst-filter` is running, CTL-257 + CTL-269):** the orchestrate skill emits `filter.register` at Phase 4 start with a prompt covering CI events, PR transitions, BEHIND-state pushes, comms attention from workers, and Linear ticket changes. Phase 4 then waits on `filter.wake.${ORCH_NAME}` for a single unified wake covering all those concerns. See [[catalyst-filter]]. The `Monitor`-over-`tail` pattern below is the **fallback** for environments without the daemon.

The recommended shape is **scope-aware**, generated from the orchestrator's worker signal directory (CTL-240):

```text
Use the `Monitor` tool with this command:

FILTER=$(catalyst-events build-orchestrator-filter "$ORCH_DIR")
catalyst-events tail --filter "$FILTER"

When a notification arrives, re-evaluate the affected worker's state via the
canonical `gh pr view` query. Do NOT trust the event's payload as the source
of truth — use it only as a wake-up trigger.
```

`build-orchestrator-filter` reads `${ORCH_DIR}/workers/*.json` and emits a single jq predicate that scopes catalyst-origin events by orchestrator name, github events by branch-ref prefix and PR-number set, `check_suite` / `workflow_run` events by `detail.prNumbers`, and linear events by ticket. Re-build it after dispatching new workers so the PR/ticket sets stay in sync.

If you need a hand-rolled equivalent (e.g. the orchestrator name isn't yet known, or you only want broad event-type coverage and don't care about scoping out sibling orchestrators), the broad form is:

```text
catalyst-events tail --filter '
  (.attributes."event.name" | startswith("github.pr.")) or
  (.attributes."event.name" | startswith("github.pr_review")) or
  (.attributes."event.name" | startswith("github.issue_comment")) or
  (.attributes."event.name" | startswith("github.check_")) or
  (.attributes."event.name" | startswith("github.workflow_run")) or
  (.attributes."event.name" | startswith("github.deployment")) or
  (.attributes."event.name" == "github.push") or
  (.attributes."event.name" | startswith("linear.issue.")) or
  (.attributes."event.name" == "orchestrator.worker.phase_advanced") or
  (.attributes."event.name" == "orchestrator.worker.status_terminal") or
  (.attributes."event.name" == "orchestrator.worker.pr_created") or
  (.attributes."event.name" == "orchestrator.worker.done") or
  (.attributes."event.name" == "orchestrator.worker.failed") or
  (.attributes."event.name" == "orchestrator.attention.raised") or
  (.attributes."event.name" == "orchestrator.attention.resolved")
'
```

`pr_review_comment` events are where Codex review threads land (required for CTL-64 BLOCKED auto-fixup detection); `workflow_run.completed` is the most reliable CI-done signal. The filter is intentionally broad — it covers every event type that could require a dashboard re-render, a fix-up dispatch, or a merge-confirmation re-scan. See `orchestrate/SKILL.md` Phase 4 for the wake-up classification table that maps each event to its reaction.

The orchestrator continues to maintain its 10-minute fallback scan (defense-in-depth). The fast path is event-driven; the slow path is the safety net.

**Cross-orchestrator scoping (CTL-234).** When multiple orchestrators run on the same machine, narrow the filter with `(.attributes."catalyst.orchestrator.id" == "orch-foo")` to ignore events from sibling runs. As of CTL-234, the webhook receiver stamps `.attributes."catalyst.orchestrator.id"` (and the back-compat top-level `.orchestrator`) on `github.*` events for PRs whose head branch starts with `<orchId>-`, so the filter

```jq
(.attributes."catalyst.orchestrator.id" == "orch-foo") and (
  (.attributes."event.name" | startswith("github.pr.")) or
  (.attributes."event.name" | startswith("github.check_")) or
  (.attributes."event.name" == "github.push") or
  (.attributes."event.name" | startswith("worker-"))
)
```

works for **both** worker-lifecycle events (already attributed) and webhook events (now attributed via PR-number lookup or head-ref prefix). Events that don't belong to any active orchestrator (human-merged PRs to main, dependabot PRs, etc.) keep `.orchestrator == null` and are filtered out, which is the desired behaviour.
