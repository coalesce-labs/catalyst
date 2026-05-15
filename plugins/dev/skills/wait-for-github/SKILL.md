---
name: wait-for-github
version: 1.2.0
description:
  Reference for safe GitHub event waits. Preferred path uses broker auto-detect (broker_claim_pr
  + filter.wake) for deterministic routing; falls back to two-phase catalyst-events wait-for
  when the daemon is absent. Includes a 3-minute diagnostic checkpoint to catch silent filter
  mismatches before they cause multi-hour stalls. Not a slash command — reference doc for skill
  authors.
---

# wait-for-github — Safe GitHub event wait

## What this is for

GitHub's GraphQL API costs points per call. `gh pr view --json` and `gh pr checks` both use
GraphQL. A single worker polling every 30 s burns 120 calls/hr; three concurrent workers drain
the 5,000 point/hr budget in under 15 minutes.

`catalyst-events wait-for` with a long timeout silently never fires when a filter is wrong.
Observed in production: a worker sat idle for hours because `.attributes."vcs.pr.number"` was null on GitHub
webhook events (root cause tracked in CTL-234). The 3-minute diagnostic checkpoint in this
skill catches that class of failure quickly.

Do not invoke this as a slash command — it is a reference document for skill authors.

## Pre-flight: verify event infrastructure

Before starting any wait, confirm the event infrastructure is running:

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')

STATUS=$(catalyst-monitor status --json 2>/dev/null)
TUNNEL=$(echo "$STATUS" | jq -r '.webhookTunnel.connected // false' 2>/dev/null)
if [ $? -ne 0 ] || [ "$TUNNEL" != "true" ]; then
  echo "WARN: catalyst-monitor not running or tunnel not connected — using REST fallback directly"
  USE_REST=true
fi
```

If `catalyst-monitor` is not running or the tunnel is not connected, skip to the REST fallback.
Do not attempt event-driven waits against a dead daemon.

## Preferred path: broker auto-detect

When the broker daemon is running, register via `broker_claim_pr` so the broker auto-derives a
`pr_lifecycle` interest and wakes this worker via `filter.wake.${CATALYST_SESSION_ID}`. This
single semantic wake covers all concerns (CI, reviews, comms, BEHIND) with routing-layer dedup
and watchdog support. When the daemon is absent, fall back to the two-phase raw event wait.

`broker_claim_pr` handles the health check internally via `wait_for_broker_ready`, which retries
up to 3 times (CTL-429) before declaring the daemon absent.

### Prerequisites

These must be defined before calling `broker_claim_pr`:

- `$CATALYST_SESSION_ID` — set by `catalyst-session.sh start` at oneshot startup
- `$STATE_SCRIPT` — path to `catalyst-state.sh` (set at oneshot startup)
- `broker_claim_pr`, `wait_for_broker_ready`, `broker_daemon_running` functions from `oneshot/SKILL.md`

### Snippet

```bash
USE_FILTER_DAEMON=false
PR_BASE_BRANCH=$(gh pr view "$PR_NUMBER" --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "main")
if broker_claim_pr "$PR_NUMBER" "$TICKET_ID" "$(git branch --show-current)" "$REPO" "$PR_BASE_BRANCH"; then
  USE_FILTER_DAEMON=true
  echo "[Phase 5] Broker registered pr_lifecycle for session ${CATALYST_SESSION_ID} on PR #${PR_NUMBER}"
else
  # Broker absent — emit telemetry and use two-phase fallback
  "$STATE_SCRIPT" event "$(jq -nc \
    --arg sid "${CATALYST_SESSION_ID:-}" --arg pr "${PR_NUMBER:-}" \
    '{ts: (now | todate), event: "broker.fallback.taken",
      detail: {reason: "daemon absent", session_id: $sid, pr: ($pr | tonumber? // $pr)}}')" \
    2>/dev/null || true
  echo "[Phase 5] Broker unavailable — using two-phase wait-for fallback for PR #${PR_NUMBER}"
fi

PR_DONE=false
while [ "$PR_DONE" = "false" ]; do
  if [ "$USE_FILTER_DAEMON" = "true" ] && [ "$USE_REST" != "true" ]; then
    # Broker path: single semantic wake covers all concerns (CI, reviews, comms, BEHIND)
    EVENT=$(catalyst-events wait-for \
      --filter ".attributes.\"event.name\" == \"filter.wake.${CATALYST_SESSION_ID}\"" \
      --timeout 600 2>/dev/null || true)
    WAKE_REASON=$(echo "$EVENT" | jq -r '.body.payload.reason // "unknown"' 2>/dev/null || echo "unknown")
    echo "wake: filter.wake #${PR_NUMBER} — ${WAKE_REASON}"
  else
    # Two-phase fallback — see "Manual fallback" section below
    EVENT=$(catalyst-events wait-for \
      --filter "(.attributes.\"vcs.pr.number\" == ${PR_NUMBER} or (.body.payload.prNumbers // [] | contains([${PR_NUMBER}]))) and (
        .attributes.\"event.name\" == \"github.pr.merged\" or
        .attributes.\"event.name\" == \"github.check_suite.completed\" or
        (.attributes.\"event.name\" | startswith(\"github.pr_review\")) or
        .attributes.\"event.name\" == \"github.push\"
      )" \
      --timeout 180 2>/dev/null || true)
    # ... run diagnostic checkpoint if empty (see "Manual fallback" section) ...
  fi

  # Authoritative REST check (never gh pr view --json)
  PR_JSON=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" 2>/dev/null || echo '{}')
  PR_MERGED=$(echo "$PR_JSON" | jq -r '.merged // false')
  MERGE_STATE=$(echo "$PR_JSON" | jq -r '.mergeable_state // "unknown"')

  [ "$PR_MERGED" = "true" ] && PR_DONE=true
  # ... handle merge states (clean/blocked/behind/dirty/unknown) per oneshot Phase 5 ...

  [ "$USE_REST" = "true" ] && sleep 300
done
```

## Manual fallback: raw two-phase wait (no broker)

Use this only when the broker daemon is absent (detected by `broker_claim_pr` returning non-zero
above) or when you are not running inside an oneshot worker that has `broker_claim_pr` defined.
This pattern wakes on raw GitHub webhook events and includes a diagnostic checkpoint.

### Phase 1 — Short wait with diagnostic checkpoint (3 minutes)

```bash
PR_NUMBER=342   # set by caller
EVENT=""
_WFG_MATCHED=false
_WFG_USE_PHASE2=false
USE_REST=${USE_REST:-false}

if [ "$USE_REST" != "true" ]; then
  EVENT=$(catalyst-events wait-for \
    --filter ".attributes.\"event.name\" == \"github.pr.merged\" and .attributes.\"vcs.pr.number\" == ${PR_NUMBER}" \
    --timeout 180 2>/dev/null || true)

  if [ -n "$EVENT" ]; then
    _WFG_MATCHED=true
  else
    # Phase 1 timed out — run 3 diagnostics before deciding next step
    echo "Phase 1 timed out after 3 min — running diagnostics..."
    STALLED=false
    FILTER_MISMATCH=false

    # Diagnostic 1: heartbeat check
    _LOG_FILE=~/catalyst/events/$(date -u +%Y-%m).jsonl
    _LOG_LINES=$(wc -l < "$_LOG_FILE" 2>/dev/null | tr -d ' ')
    _SINCE_LINE=$(( ${_LOG_LINES:-0} > 500 ? ${_LOG_LINES:-0} - 500 : 0 ))
    HEARTBEATS=$(catalyst-events tail --since-line "$_SINCE_LINE" 2>/dev/null \
      | jq -c 'select(.attributes."event.name" == "session.heartbeat")' | wc -l | tr -d ' ')
    if [ "${HEARTBEATS:-0}" -eq 0 ]; then
      echo "WARN: No heartbeats in the last 5 min — event log may be stalled"
      STALLED=true
    fi

    # Diagnostic 2: raw event search without the filter
    # Look for the PR by multiple fields to detect filter mismatches
    RAW_HIT=$(catalyst-events tail --since-line "$_SINCE_LINE" 2>/dev/null | jq -c \
      --argjson pr "$PR_NUMBER" \
      'select(
        (.attributes."vcs.pr.number" == $pr) or
        (.body.payload.prNumbers // [] | contains([$pr]))
      )' | head -1)

    if [ -n "$RAW_HIT" ]; then
      echo "WARN: Event arrived but the filter did not match. Raw event:"
      echo "$RAW_HIT" | jq .
      echo "This is a filter mismatch — falling back to REST."
      echo "Consider filing a CTL ticket with the raw event above."
      FILTER_MISMATCH=true
    fi

    # Diagnostic 3: tunnel state re-check
    TUNNEL_STATE=$(catalyst-monitor status --json 2>/dev/null \
      | jq -r '.webhookTunnel.connected // false')
    echo "Tunnel connected: $TUNNEL_STATE"
    if [ "$TUNNEL_STATE" != "true" ]; then
      echo "WARN: Webhook tunnel is not running"
      STALLED=true
    fi

    # Decision
    if [ "$FILTER_MISMATCH" = "true" ] || [ "$STALLED" = "true" ]; then
      echo "Infrastructure issue detected — falling back to REST polling"
      USE_REST=true
    else
      echo "Infrastructure looks healthy — extending to Phase 2 (2-hour wait)"
      _WFG_USE_PHASE2=true
    fi
  fi
fi
```

### Phase 2 — Extended wait (only after diagnostics confirm healthy)

```bash
if [ "$_WFG_USE_PHASE2" = "true" ]; then
  EVENT=$(catalyst-events wait-for \
    --filter ".attributes.\"event.name\" == \"github.pr.merged\" and .attributes.\"vcs.pr.number\" == ${PR_NUMBER}" \
    --timeout 7200 2>/dev/null || true)

  [ -n "$EVENT" ] && _WFG_MATCHED=true
fi
```

## REST fallback — authoritative confirmation and infrastructure fallback

Use REST after any `wait-for` path (matched or timed out) for authoritative confirmation, and
as the sole path when diagnostics detect infrastructure problems. Use `gh api` REST endpoints;
never `gh pr view --json` (GraphQL).

```bash
# One-shot REST check — allowed; it is not a poll loop
MERGED=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merged' 2>/dev/null || echo "false")

if [ "$MERGED" = "true" ]; then
  echo "PR $PR_NUMBER is merged"
elif [ "$USE_REST" = "true" ]; then
  # Infrastructure unavailable — REST poll at low frequency (12 calls/hr, well within budget)
  MAX=24  # 2-hour limit at 5-min intervals
  COUNT=0
  while [ "$MERGED" != "true" ] && [ "$COUNT" -lt "$MAX" ]; do
    sleep 300
    MERGED=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merged' 2>/dev/null || echo "false")
    COUNT=$((COUNT + 1))
  done
fi
```

## Forbidden patterns

Never use these in any skill. They exhaust the GraphQL budget.

| Anti-pattern | Why forbidden | Replacement |
|---|---|---|
| `gh pr view --json` in a poll loop | GraphQL, 2+ pts/call, 120/hr per worker | `catalyst-events wait-for` + one-shot `gh api` after match |
| `gh pr checks --json` in a poll loop | `statusCheckRollup` field, same GraphQL cost | `catalyst-events wait-for --filter '.attributes."event.name" \| startswith("github.check_")'` |
| `--timeout 7200` as Phase 1 | Silent stall on broken filter for up to 2 hours | Two-phase: 3 min → diagnostics → 7200 s if healthy |
| `sleep 30` poll loops | GraphQL and compute waste at scale | Event-driven wait |
| Any field under `statusCheckRollup` | GraphQL-only field, not available in REST | `.attributes."cicd.pipeline.run.conclusion"` on `check_run.completed` events |
| Skipping `broker_claim_pr` when broker is up | Bypasses routing-layer dedup + watchdog | Use broker auto-detect snippet above |

## Known filter pitfalls

| Field | Problem | Fix |
|---|---|---|
| `.attributes."vcs.pr.number"` | Null on GitHub webhook events until CTL-234 ships | Also check `.body.payload.number` or `.body.payload.pull_request.number` |
| `.attributes."catalyst.orchestrator.id"` | Set on github events when head-branch matches an orch prefix (CTL-234) — a bare clause matches ~60-70% of webhooks for that orchestrator | Combine with an event-type guard from [[event-name-allowlist]] (e.g. `.attributes."event.name" == "github.pr.merged" and …`) |
| `.attributes."cicd.pipeline.run.conclusion"` | Only on `check_run.completed`, not `check_suite.completed` | Use `.body.payload.status == "completed"` for suite events |
| `.body.payload.state` on reviews | Casing varies (`APPROVED` vs `approved`) | Pipe through `\| ascii_downcase` before comparing |
| Exact match on `wait-for` | Event may arrive before `wait-for` starts | Always confirm via one-shot `gh api` after match |

## Quick reference

```bash
# PREFERRED: broker auto-detect (use when running inside oneshot worker)
# broker_claim_pr registers a pr_lifecycle interest; wake fires on all PR events
broker_claim_pr "$PR_NUMBER" "$TICKET_ID" "$(git branch --show-current)" "$REPO" "$PR_BASE_BRANCH"
catalyst-events wait-for \
  --filter ".attributes.\"event.name\" == \"filter.wake.${CATALYST_SESSION_ID}\"" \
  --timeout 600

# MANUAL FALLBACK: two-phase raw event wait (when broker is absent)
# Phase 1 (3 min) + diagnostic checkpoint
catalyst-events wait-for \
  --filter ".attributes.\"event.name\" == \"github.pr.merged\" and .attributes.\"vcs.pr.number\" == ${PR_NUMBER}" \
  --timeout 180   # Phase 1; extend to 7200 after diagnostics confirm healthy

# CI suite completed — note: check_suite has no vcs.pr.number; use body.payload.prNumbers
catalyst-events wait-for \
  --filter ".attributes.\"event.name\" == \"github.check_suite.completed\" and (.body.payload.prNumbers // [] | index(${PR_NUMBER}) != null)" \
  --timeout 180

# Review submitted
catalyst-events wait-for \
  --filter "(.attributes.\"event.name\" | startswith(\"github.pr_review.\")) and .attributes.\"vcs.pr.number\" == ${PR_NUMBER}" \
  --timeout 180

# REST: check PR merge state (never in a tight loop)
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merged'

# Probe broker health directly (exits 0 if running, non-zero if not)
catalyst-broker probe; echo "exit=$?"
```

## Related skills

- `monitor-events` — canonical event-driven wait reference, filter cookbook, `Monitor` vs `wait-for`
- `orchestrate` Phase 4 — uses `Monitor` over `catalyst-events tail` for multi-worker fan-out
- `merge-pr` — uses this two-phase pattern for post-merge cleanup
- `create-pr` — uses this pattern for CI gate before arming auto-merge
