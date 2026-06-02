#!/usr/bin/env bash
# Tests for workflow-substep-emit (CTL-753).
# Run: bash plugins/dev/scripts/__tests__/workflow-substep-emit.test.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EMIT_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/workflow-substep-emit"
FAILURES=0; PASSES=0
SCRATCH="$(mktemp -d -t workflow-substep-emit-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES+1));   echo "  PASS: $1"; }
assert_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 — expected '$1', got '$2'"; }

fresh_env() {
  local tag="$1"
  TEST_DIR="${SCRATCH}/${tag}"
  mkdir -p "${TEST_DIR}/catalyst/events"
  export CATALYST_DIR="${TEST_DIR}/catalyst"
}

read_event_line() {
  local month; month=$(date -u +%Y-%m)
  local logfile="${CATALYST_DIR}/events/${month}.jsonl"
  [[ -f $logfile ]] || { echo ""; return 1; }
  grep -F '"workflow.substep.' "$logfile" | tail -n 1
}

# Test 1: emits started event with correct event name
echo "Test 1: emits workflow.substep.started.<TICKET> event"
fresh_env t1
"$EMIT_SCRIPT" --ticket CTL-100 --workflow-name research \
  --step-label "Phase 1" --step-index 0 --status started >/dev/null 2>&1
LINE=$(read_event_line)
[[ -z $LINE ]] && fail "Test 1: no event line emitted" || {
  NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
  assert_eq "workflow.substep.started.CTL-100" "$NAME" "Test 1: event name"
}

# Test 2: emits complete event
echo "Test 2: emits workflow.substep.complete.<TICKET> event"
fresh_env t2
"$EMIT_SCRIPT" --ticket CTL-100 --workflow-name research \
  --step-label "Phase 1" --step-index 0 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
[[ -z $LINE ]] && fail "Test 2: no event line emitted" || {
  NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
  assert_eq "workflow.substep.complete.CTL-100" "$NAME" "Test 2: event name"
}

# Test 3: payload includes workflowName, stepLabel, stepIndex
echo "Test 3: payload carries workflowName, stepLabel, stepIndex"
fresh_env t3
"$EMIT_SCRIPT" --ticket CTL-100 --workflow-name "my-wf" \
  --step-label "Gather" --step-index 2 --status started >/dev/null 2>&1
LINE=$(read_event_line)
[[ -z $LINE ]] && fail "Test 3: no event line" || {
  WN=$(echo "$LINE" | jq -r '.body.payload.workflowName')
  SL=$(echo "$LINE" | jq -r '.body.payload.stepLabel')
  SI=$(echo "$LINE" | jq -r '.body.payload.stepIndex')
  assert_eq "my-wf"  "$WN" "Test 3: workflowName"
  assert_eq "Gather" "$SL" "Test 3: stepLabel"
  assert_eq "2"      "$SI" "Test 3: stepIndex"
}

# Test 4: service is catalyst.workflow
echo "Test 4: service name is catalyst.workflow"
fresh_env t4
"$EMIT_SCRIPT" --ticket CTL-100 --workflow-name wf \
  --step-label L --step-index 0 --status started >/dev/null 2>&1
LINE=$(read_event_line)
[[ -z $LINE ]] && fail "Test 4: no event line" || {
  SVC=$(echo "$LINE" | jq -r '.resource."service.name"')
  assert_eq "catalyst.workflow" "$SVC" "Test 4: service name"
}

# Test 5: missing --ticket causes non-zero exit
echo "Test 5: missing --ticket → non-zero exit"
fresh_env t5
"$EMIT_SCRIPT" --workflow-name wf --step-label L --step-index 0 --status started \
  >/dev/null 2>&1 && fail "Test 5: should have exited non-zero" || pass "Test 5: non-zero exit on missing --ticket"

# Test 6: invalid ticket pattern causes non-zero exit
echo "Test 6: invalid ticket pattern → non-zero exit"
fresh_env t6
"$EMIT_SCRIPT" --ticket "not-a-ticket" --workflow-name wf \
  --step-label L --step-index 0 --status started \
  >/dev/null 2>&1 && fail "Test 6: should have exited non-zero" || pass "Test 6: non-zero on bad ticket"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
