#!/usr/bin/env bash
# Shell tests for catalyst-state.sh attention --actionable flag (CTL-493 Phase 1).
#
# The new flag lets `orchestrate-revive`'s phase-agent recovery branch emit
# unrecoverable failures with detail.actionable=false so HUD/monitor can render
# them distinctly from operator-actionable attentions.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-state-attention.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STATE_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-state.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t catalyst-state-attention-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# Each test gets its own CATALYST_DIR so events files don't bleed across cases.
mk_dir() {
  local d="$SCRATCH/$1"
  mkdir -p "$d"
  echo "$d"
}

# Find this test run's most recent event line from the events dir.
last_event_line() {
  local events_dir="$1/events"
  local f
  f=$(ls -t "$events_dir"/*.jsonl 2>/dev/null | head -1)
  [ -z "$f" ] && return 1
  tail -n 1 "$f"
}

# Register a minimal orchestrator so cmd_attention has a target to mutate.
register_orch() {
  local orch_id="$1"
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  "$STATE_SCRIPT" register "$orch_id" "$(jq -nc \
    --arg id "$orch_id" --arg ts "$ts" \
    '{id:$id,projectKey:"k",repository:"r",baseBranch:"main",
      status:"active",startedAt:$ts,lastHeartbeat:$ts,
      worktreeDir:"/tmp",stateFile:"/tmp/x.json",progress:{},usage:{},
      workers:{"T-x":{ticket:"T-x"}},attention:[]}')" >/dev/null
}

# ─── Test 1: --actionable false → detail.actionable == false ─────────────────
echo "--- Test 1: --actionable false stamps actionable=false ---"
export CATALYST_DIR="$(mk_dir cat1)"
"$STATE_SCRIPT" init >/dev/null
register_orch "orch-1"
"$STATE_SCRIPT" attention "orch-1" "phase-failed-unrecoverable" "T-x" "msg" \
  --actionable false >/dev/null
LINE=$(last_event_line "$CATALYST_DIR" || echo "")
if [ -z "$LINE" ]; then
  fail "no event line written"
else
  # Note: `//` treats boolean `false` as absent, so use a presence-aware path
  # that walks all known shapes and prints "" when the field is missing.
  ACT=$(echo "$LINE" | jq -r '
    if (.body.payload // null) | type == "object" and has("actionable") then
      .body.payload.actionable | tostring
    elif (.body // null) | type == "object" and has("actionable") then
      .body.actionable | tostring
    elif (.body.detail // null) | type == "object" and has("actionable") then
      .body.detail.actionable | tostring
    elif (.attributes // null) | type == "object" and has("event.actionable") then
      .attributes."event.actionable" | tostring
    else
      ""
    end')
  if [ "$ACT" = "false" ]; then
    pass "actionable=false stamped on event"
  else
    fail "actionable=false expected, got: '$ACT'" "line: $LINE"
  fi
fi

# ─── Test 2: default (no flag) → actionable == true ──────────────────────────
echo "--- Test 2: default flag-less invocation stamps actionable=true ---"
export CATALYST_DIR="$(mk_dir cat2)"
"$STATE_SCRIPT" init >/dev/null
register_orch "orch-2"
"$STATE_SCRIPT" attention "orch-2" "state-json-stale" "T-x" "stalled msg" >/dev/null
LINE=$(last_event_line "$CATALYST_DIR" || echo "")
if [ -z "$LINE" ]; then
  fail "no event line written"
else
  # Note: `//` treats boolean `false` as absent, so use a presence-aware path
  # that walks all known shapes and prints "" when the field is missing.
  ACT=$(echo "$LINE" | jq -r '
    if (.body.payload // null) | type == "object" and has("actionable") then
      .body.payload.actionable | tostring
    elif (.body // null) | type == "object" and has("actionable") then
      .body.actionable | tostring
    elif (.body.detail // null) | type == "object" and has("actionable") then
      .body.detail.actionable | tostring
    elif (.attributes // null) | type == "object" and has("event.actionable") then
      .attributes."event.actionable" | tostring
    else
      ""
    end')
  if [ "$ACT" = "true" ]; then
    pass "default actionable=true stamped on event"
  else
    fail "actionable=true expected by default, got: '$ACT'" "line: $LINE"
  fi
fi

# ─── Test 3: invalid --actionable value rejected with non-zero exit ──────────
echo "--- Test 3: invalid --actionable value rejected ---"
export CATALYST_DIR="$(mk_dir cat3)"
"$STATE_SCRIPT" init >/dev/null
register_orch "orch-3"
set +e
"$STATE_SCRIPT" attention "orch-3" "phase-failed-unrecoverable" "T-x" "msg" \
  --actionable maybe >/dev/null 2>&1
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  pass "invalid --actionable value exits non-zero"
else
  fail "invalid --actionable value should exit non-zero, got rc=$RC"
fi

# ─── Test 4: --actionable true explicit → actionable == true ─────────────────
echo "--- Test 4: --actionable true (explicit) stamps actionable=true ---"
export CATALYST_DIR="$(mk_dir cat4)"
"$STATE_SCRIPT" init >/dev/null
register_orch "orch-4"
"$STATE_SCRIPT" attention "orch-4" "state-json-stale" "T-x" "msg" \
  --actionable true >/dev/null
LINE=$(last_event_line "$CATALYST_DIR" || echo "")
if [ -z "$LINE" ]; then
  fail "no event line written"
else
  # Note: `//` treats boolean `false` as absent, so use a presence-aware path
  # that walks all known shapes and prints "" when the field is missing.
  ACT=$(echo "$LINE" | jq -r '
    if (.body.payload // null) | type == "object" and has("actionable") then
      .body.payload.actionable | tostring
    elif (.body // null) | type == "object" and has("actionable") then
      .body.actionable | tostring
    elif (.body.detail // null) | type == "object" and has("actionable") then
      .body.detail.actionable | tostring
    elif (.attributes // null) | type == "object" and has("event.actionable") then
      .attributes."event.actionable" | tostring
    else
      ""
    end')
  if [ "$ACT" = "true" ]; then
    pass "explicit --actionable true stamped"
  else
    fail "explicit --actionable true expected, got: '$ACT'" "line: $LINE"
  fi
fi

echo ""
echo "──────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "──────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
