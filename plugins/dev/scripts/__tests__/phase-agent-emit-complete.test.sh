#!/usr/bin/env bash
# Tests for phase-agent-emit-complete (CTL-448 Initiative 1 Phase 2).
#
# Approach: redirect $CATALYST_DIR to a scratch tmpdir, run the script, then
# parse the emitted JSONL line from <tmp>/events/YYYY-MM.jsonl. The script
# emits the broker-routable phase.<name>.{complete,failed}.<ticket> canonical
# event (CTL-300 shape).
#
# Run: bash plugins/dev/scripts/__tests__/phase-agent-emit-complete.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EMIT_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-agent-emit-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

if [[ ! -x "$EMIT_SCRIPT" ]]; then
  echo "FATAL: $EMIT_SCRIPT not found or not executable" >&2
  exit 1
fi

# Each test gets a fresh CATALYST_DIR and ORCH_DIR. The emit script writes to
# $CATALYST_DIR/events/YYYY-MM.jsonl (canonical_jsonl_append uses CATALYST_DIR
# transitively via the EVENTS_DIR derivation inside the script).
fresh_env() {
  local tag="$1"
  TEST_DIR="${SCRATCH}/${tag}"
  mkdir -p "${TEST_DIR}/catalyst/events"
  mkdir -p "${TEST_DIR}/orch/workers/CTL-100"
  export CATALYST_DIR="${TEST_DIR}/catalyst"
  export CATALYST_ORCHESTRATOR_DIR="${TEST_DIR}/orch"
  export CATALYST_ORCHESTRATOR_ID="orch-test"
  export CATALYST_SESSION_ID="sess_test_${tag}"
}

# Read the phase event line from this test's event log. catalyst-session.sh end
# (which the emit script also invokes) appends session.ended + agent.checkout
# lines after, so we grep for the phase event prefix instead of tailing.
read_event_line() {
  local month
  month=$(date -u +%Y-%m)
  local logfile="${CATALYST_DIR}/events/${month}.jsonl"
  [[ -f "$logfile" ]] || { echo ""; return 1; }
  grep -F '"event.name":"phase.' "$logfile" | tail -n 1
}

echo "Test 1: phase-complete emitter writes the canonical event shape"
fresh_env t1
"$EMIT_SCRIPT" --phase research --ticket CTL-100 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z "$LINE" ]]; then
  fail "Test 1: no event line emitted"
else
  EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
  assert_eq "phase.research.complete.CTL-100" "$EVENT_NAME" "event.name matches phase.<name>.complete.<ticket>"
  HAS_ATTRS=$(echo "$LINE" | jq -r 'has("attributes")')
  assert_eq "true" "$HAS_ATTRS" "canonical shape — attributes present"
  HAS_BODY=$(echo "$LINE" | jq -r 'has("body")')
  assert_eq "true" "$HAS_BODY" "canonical shape — body present"
  SEVERITY=$(echo "$LINE" | jq -r '.severityText')
  assert_eq "INFO" "$SEVERITY" "complete → INFO severity"
fi

echo ""
echo "Test 2: phase-complete includes session.id, orchestrator, ticket, phase"
fresh_env t2
"$EMIT_SCRIPT" --phase implement --ticket CTL-200 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
SESS=$(echo "$LINE" | jq -r '.attributes."catalyst.session.id"')
ORCH=$(echo "$LINE" | jq -r '.attributes."catalyst.orchestrator.id"')
WORKER=$(echo "$LINE" | jq -r '.attributes."catalyst.worker.ticket"')
LINEAR=$(echo "$LINE" | jq -r '.attributes."linear.issue.identifier"')
PAYLOAD_PHASE=$(echo "$LINE" | jq -r '.body.payload.phase')
assert_eq "sess_test_t2" "$SESS" "catalyst.session.id propagated from env"
assert_eq "orch-test"    "$ORCH" "catalyst.orchestrator.id propagated from env"
assert_eq "CTL-200"      "$WORKER" "catalyst.worker.ticket = ticket"
assert_eq "CTL-200"      "$LINEAR" "linear.issue.identifier = ticket"
assert_eq "implement"    "$PAYLOAD_PHASE" "body.payload.phase = phase name"

echo ""
echo "Test 3: failure variant uses .failed suffix and includes failure_reason"
fresh_env t3
"$EMIT_SCRIPT" --phase verify --ticket CTL-300 --status failed --reason "tests red after 3 attempts" >/dev/null 2>&1
LINE=$(read_event_line)
EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
SEVERITY=$(echo "$LINE" | jq -r '.severityText')
REASON_FIELD=$(echo "$LINE" | jq -r '.body.payload.failure_reason')
PAYLOAD_STATUS=$(echo "$LINE" | jq -r '.body.payload.status')
assert_eq "phase.verify.failed.CTL-300" "$EVENT_NAME" "failure event uses .failed suffix"
assert_eq "WARN" "$SEVERITY" "failed → WARN severity"
assert_eq "tests red after 3 attempts" "$REASON_FIELD" "body.payload.failure_reason carries reason"
assert_eq "failed" "$PAYLOAD_STATUS" "body.payload.status = failed"

# Bonus assertions covering the signal file update path on success.
echo ""
echo "Test 4 (bonus): signal file is updated to status=done on complete"
fresh_env t4
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-research.json"
echo '{"status":"in-progress","ticket":"CTL-100","phase":"research"}' > "$SIGNAL"
"$EMIT_SCRIPT" --phase research --ticket CTL-100 --status complete >/dev/null 2>&1
NEW_STATUS=$(jq -r '.status' "$SIGNAL")
HAS_COMPLETED=$(jq -r 'has("completedAt")' "$SIGNAL")
assert_eq "done" "$NEW_STATUS" "signal file status updated to done"
assert_eq "true" "$HAS_COMPLETED" "signal file gained completedAt timestamp"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-agent-emit-complete: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
