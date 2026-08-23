# Prerequisites and Prelude

## Prerequisites

- `CATALYST_ORCHESTRATOR_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_PHASE=monitor-merge`,
  `CATALYST_TICKET` set by [[phase-agent-dispatch]].
- The prior phase's signal file `${ORCH_DIR}/workers/<TICKET>/phase-pr.json` exists with
  `status=done` AND `.pr.number` populated by [[phase-pr]].
- `gh` CLI authenticated; broker daemon optionally running (the loop falls back to direct
  `catalyst-events wait-for` filtering when it is not — see [[wait-for-github]]).

## Prelude

```bash
set -euo pipefail

: "${CATALYST_ORCHESTRATOR_DIR:?required}"
: "${CATALYST_ORCHESTRATOR_ID:?required}"
: "${CATALYST_PHASE:?required}"
: "${CATALYST_TICKET:?required}"

ORCH_DIR="$CATALYST_ORCHESTRATOR_DIR"
ORCH_ID="$CATALYST_ORCHESTRATOR_ID"
PHASE="$CATALYST_PHASE"
TICKET="$CATALYST_TICKET"
CHANNEL="${ORCH_ID}"
SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  RUNTIME_ROOT_LIB=""
  if [[ -f "./plugins/dev/scripts/lib/catalyst-runtime-root.sh" ]]; then
    RUNTIME_ROOT_LIB="./plugins/dev/scripts/lib/catalyst-runtime-root.sh"
  else
    __rr_mkt="$( ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/dev/scripts/lib/catalyst-runtime-root.sh 2>/dev/null | sort -V | tail -1 || true )"
    [[ -n "$__rr_mkt" && -f "$__rr_mkt" ]] && RUNTIME_ROOT_LIB="$__rr_mkt" || {
      __rr_cache="$( ls -d "$HOME"/.claude/plugins/cache/*/catalyst-dev/*/scripts/lib/catalyst-runtime-root.sh 2>/dev/null | sort -V | tail -1 || true )"
      [[ -n "$__rr_cache" && -f "$__rr_cache" ]] && RUNTIME_ROOT_LIB="$__rr_cache"
      unset __rr_cache
    }
    unset __rr_mkt
  fi
  DEV_SCRIPTS=""
  if [[ -n "$RUNTIME_ROOT_LIB" ]]; then
    . "$RUNTIME_ROOT_LIB"
    catalyst_dev_scripts >/dev/null 2>&1 || true
    DEV_SCRIPTS="${CATALYST_DEV_SCRIPTS:-}"
  fi
  [[ -n "$DEV_SCRIPTS" ]] || { echo "phase-${PHASE}: FATAL — CLAUDE_PLUGIN_ROOT unset and probe missed" >&2; exit 1; }
  PLUGIN_ROOT="$(dirname "$DEV_SCRIPTS")"
fi

# CTL-1998: assign EMIT here (prelude) so every emit site in the skill body
# can safely reference $EMIT without an unbound-variable abort under set -u.
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"

YIELD_CHECK="${PLUGIN_ROOT}/scripts/phase-agent-yield-check.sh"
if [[ -x "$YIELD_CHECK" ]] && bash "$YIELD_CHECK" \
     --signal "$SIGNAL_FILE" --phase "$PHASE" \
     --worker-dir "$(dirname "$SIGNAL_FILE")"; then
  echo "phase-${PHASE}: yielding to canonical worker (CTL-615)" >&2; exit 0
fi

COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" && -x "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-monitor-merge: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 86400 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-monitor-merge started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-monitor-merge" --ticket "$TICKET" --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PR_JSON="${ORCH_DIR}/workers/${TICKET}/phase-pr.json"
PR_NUMBER=$(jq -r '.pr.number // empty' "$PR_JSON" 2>/dev/null || true)
[[ -n "$PR_NUMBER" ]] || { echo "phase-monitor-merge: phase-pr.json has no .pr.number" >&2; exit 1; }
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
[[ -n "$REPO" ]] || { echo "phase-monitor-merge: could not resolve repo" >&2; exit 1; }
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --argjson pr "$PR_NUMBER" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | .pr = {number: $pr}
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"
```
