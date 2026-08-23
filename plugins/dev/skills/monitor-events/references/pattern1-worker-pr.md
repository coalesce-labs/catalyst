# Pattern 1 — Worker waits for its PR to merge

_Read this when a short-lived `claude -p` worker needs to block until its PR merges and then do
post-merge work._

A `claude -p` worker that just opened PR #342 needs to block until the PR merges, then
do post-merge work.

**Preferred (when `catalyst-filter` is running, CTL-269):** register a single semantic
interest covering every concern the worker cares about (CI, comms, reviews, BEHIND,
Linear), then wait on `filter.wake.${CATALYST_SESSION_ID}`. The Groq-backed daemon
classifies raw events against the natural-language prompt and emits one wake per
match. See [[catalyst-filter]] for the full registration recipe and the daemon-restart
contract. The two-phase pattern below is the **fallback** for environments where the
daemon is not running.

Use the two-phase pattern from [[wait-for-github]]: a 3-minute Phase 1
with a diagnostic checkpoint before committing to the full 2-hour wait.

```bash
# Two-phase pattern — see [[wait-for-github]] for full reference.
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
EVENT=""
_WFG_MATCHED=false

# Phase 1: short wait with diagnostic checkpoint (3 minutes).
EVENT=$(catalyst-events wait-for \
  --filter ".attributes.\"event.name\" == \"github.pr.merged\" and .attributes.\"vcs.pr.number\" == ${PR_NUMBER}" \
  --timeout 180 2>/dev/null || true)

if [ -n "$EVENT" ]; then
  _WFG_MATCHED=true
else
  # Phase 1 timed out — run diagnostics before extending to Phase 2.
  echo "Phase 1 timed out after 3 min — running diagnostics..."
  STALLED=false
  FILTER_MISMATCH=false

  _LOG_FILE=~/catalyst/events/$(date -u +%Y-%m).jsonl
  _LOG_LINES=$(wc -l < "$_LOG_FILE" 2>/dev/null | tr -d ' ')
  _SINCE_LINE=$(( ${_LOG_LINES:-0} > 500 ? ${_LOG_LINES:-0} - 500 : 0 ))
  HEARTBEATS=$(catalyst-events tail --since-line "$_SINCE_LINE" 2>/dev/null \
    | jq -c 'select(.attributes."event.name" == "session.heartbeat")' | wc -l | tr -d ' ')
  [ "${HEARTBEATS:-0}" -eq 0 ] && { echo "WARN: No heartbeats — event log may be stalled"; STALLED=true; }

  RAW_HIT=$(catalyst-events tail --since-line "$_SINCE_LINE" 2>/dev/null | jq -c \
    --argjson pr "$PR_NUMBER" \
    'select((.attributes."vcs.pr.number" == $pr) or (.body.payload.prNumbers // [] | contains([$pr])))' | head -1)
  if [ -n "$RAW_HIT" ]; then
    echo "WARN: Event arrived but filter did not match. Raw event:"; echo "$RAW_HIT" | jq .
    FILTER_MISMATCH=true
  fi

  # The smee→monitor webhook tunnel is the GitHub-event ingestion path and is NOT yet
  # retired (Linear smee retires first; GitHub smee is gated on CTC-134). A dead tunnel
  # produces zero events while the monitor keeps heartbeating — so without this check a
  # worker would treat infra as healthy and enter the 2-hour Phase 2 wait. Tunnel down →
  # skip the extension and rely on the authoritative REST confirmation below.
  TUNNEL_STATE=$(catalyst-monitor status --json 2>/dev/null | jq -r '.webhookTunnel.connected // false')
  [ "$TUNNEL_STATE" != "true" ] && { echo "WARN: Webhook tunnel not running"; STALLED=true; }

  if [ "$FILTER_MISMATCH" = "false" ] && [ "$STALLED" = "false" ]; then
    # Infrastructure healthy — extend to Phase 2.
    EVENT=$(catalyst-events wait-for \
      --filter ".attributes.\"event.name\" == \"github.pr.merged\" and .attributes.\"vcs.pr.number\" == ${PR_NUMBER}" \
      --timeout 7200 2>/dev/null || true)
    [ -n "$EVENT" ] && _WFG_MATCHED=true
  fi
fi

# Authoritative REST confirmation — always follows any wait-for path.
MERGED=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merged' 2>/dev/null || echo "false")
if [ "$MERGED" = "true" ]; then
  # Proceed with post-merge work
fi
```

**Non-negotiable:** every `wait-for` is paired with an authoritative REST check. Reasons:

- The orch-monitor daemon may be down. No daemon → no webhook events → `wait-for`
  blocks until timeout. The `gh api` call after timeout is the safety net.
- Transient state can race the event. The webhook may arrive while the worker is doing
  setup before reaching `wait-for`. The fallback covers that gap too.
- Filters may not match exactly. `wait-for` returns the first matching line; `gh api`
  returns canonical truth. Use `gh api` (REST), never `gh pr view --json` (GraphQL).
