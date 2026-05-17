#!/usr/bin/env bash
# Tests for phase-agent comms contract (CTL-448 Initiative 1 Phase 2).
#
# Exercises the wire protocol over catalyst-comms:
#   - Outbound from phase agent: info, attention, done, question (new for phase agents)
#   - Inbound to phase agent: directive, pause, abort (all new for phase agents)
#
# Strategy: redirect $CATALYST_DIR to a scratch tmpdir so a fresh channel is
# created per test, then drive catalyst-comms as the phase agent and the
# orchestrator alternately. Assertions read from the JSONL channel file
# directly so we never depend on poll's --wait semantics.
#
# Run: bash plugins/dev/scripts/__tests__/phase-agent-comms.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
COMMS="${REPO_ROOT}/plugins/dev/scripts/catalyst-comms"
STATE="${REPO_ROOT}/plugins/dev/scripts/catalyst-state.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-agent-comms-test-XXXXXX)"
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

if [[ ! -x "$COMMS" ]]; then
  echo "FATAL: $COMMS not found or not executable" >&2
  exit 1
fi

# Fresh per-test fixture. We isolate $CATALYST_DIR so each test gets its own
# comms/state file tree.
fresh_env() {
  local tag="$1"
  TEST_DIR="${SCRATCH}/${tag}"
  mkdir -p "${TEST_DIR}/catalyst/comms/channels"
  export CATALYST_DIR="${TEST_DIR}/catalyst"
  export CHANNEL="orch-${tag}"
  CHANNEL_FILE="${CATALYST_DIR}/comms/channels/${CHANNEL}.jsonl"
}

# All phase agents join the same channel on entry.
join_as() {
  local who="$1"
  "$COMMS" join "$CHANNEL" --as "$who" --capabilities "phase-agent: ${who}" \
    --orch orch-test --parent orchestrator --ttl 3600 >/dev/null 2>&1
}

# Read messages from the channel file filtered by --type field.
# (We read the file directly rather than `poll` to keep the test deterministic.)
messages_of_type() {
  local type="$1"
  [[ -f "$CHANNEL_FILE" ]] || { echo ""; return; }
  jq -c "select(.type == \"${type}\")" "$CHANNEL_FILE" 2>/dev/null
}

# ─── Test 1: phase agent posts `attention` on scope-conflict trigger
echo "Test 1: phase agent posts attention on scope-conflict trigger"
fresh_env t1
join_as CTL-100
# Simulating the scope-conflict trigger — the phase agent posts an attention
# message instructing the orchestrator that scope is wrong.
"$COMMS" send "$CHANNEL" \
  "scope conflict: ticket asks for X but plan requires unrelated Y; halting" \
  --as CTL-100 --type attention --orch orch-test >/dev/null 2>&1
ATTN_LINES=$(messages_of_type attention)
ATTN_COUNT=$(echo "$ATTN_LINES" | grep -c '"type":"attention"' || echo 0)
ATTN_FROM=$(echo "$ATTN_LINES" | jq -r '.from' | head -1)
ATTN_BODY=$(echo "$ATTN_LINES" | jq -r '.body' | head -1)
assert_eq "1" "$ATTN_COUNT" "exactly one attention message posted"
assert_eq "CTL-100" "$ATTN_FROM" "attention.from = phase-agent ticket"
case "$ATTN_BODY" in
  *"scope conflict"*) pass "attention body preserves full scope-conflict text" ;;
  *) fail "attention body preserves full scope-conflict text — got '$ATTN_BODY'" ;;
esac

# ─── Test 2: phase agent posts `question` with correlatable question_id
echo ""
echo "Test 2: phase agent posts question whose msg_id is the correlation key"
fresh_env t2
join_as CTL-200
# The msg_id printed to stdout is the correlation key the orchestrator will
# echo back via --re on its directive reply.
QID=$("$COMMS" send "$CHANNEL" \
  "plan refs helper X but I cannot find it; create or revise plan?" \
  --as CTL-200 --type question --orch orch-test 2>/dev/null)
QID_TRIMMED="${QID//$'\n'/}"
QUESTION_LINES=$(messages_of_type question)
QUESTION_COUNT=$(echo "$QUESTION_LINES" | grep -c '"type":"question"' || echo 0)
QUESTION_ID=$(echo "$QUESTION_LINES" | jq -r '.id' | head -1)
QUESTION_FROM=$(echo "$QUESTION_LINES" | jq -r '.from' | head -1)
assert_eq "1" "$QUESTION_COUNT" "exactly one question message posted"
assert_eq "$QID_TRIMMED" "$QUESTION_ID" "stdout msg_id matches channel record id"
assert_eq "CTL-200" "$QUESTION_FROM" "question.from = phase-agent ticket"

# ─── Test 3: phase agent receives `directive` correlated by question_id
echo ""
echo "Test 3: orchestrator directive correlates to question via --re"
fresh_env t3
join_as CTL-300
join_as orchestrator
QID=$("$COMMS" send "$CHANNEL" "ambiguous spec — should X be flag or attribute?" \
  --as CTL-300 --type question --orch orch-test 2>/dev/null)
QID="${QID//$'\n'/}"
# Orchestrator answers with a directive that references the question id.
"$COMMS" send "$CHANNEL" \
  "use the attribute form — drop X from plan and add to schema instead" \
  --as orchestrator --type directive --to CTL-300 --re "$QID" \
  --orch orch-test >/dev/null 2>&1
DIRECTIVE_LINES=$(messages_of_type directive)
DIRECTIVE_COUNT=$(echo "$DIRECTIVE_LINES" | grep -c '"type":"directive"' || echo 0)
DIRECTIVE_RE=$(echo "$DIRECTIVE_LINES" | jq -r '.re' | head -1)
DIRECTIVE_TO=$(echo "$DIRECTIVE_LINES" | jq -r '.to' | head -1)
assert_eq "1" "$DIRECTIVE_COUNT" "exactly one directive message posted"
assert_eq "$QID" "$DIRECTIVE_RE" "directive.re = question id (correlation)"
assert_eq "CTL-300" "$DIRECTIVE_TO" "directive.to = phase-agent ticket"

# ─── Test 4: phase agent receives `abort` and cleans up correctly
echo ""
echo "Test 4: abort message routes to the right phase-agent ticket"
fresh_env t4
join_as CTL-400
join_as orchestrator
"$COMMS" send "$CHANNEL" "abort: parent orchestrator was killed" \
  --as orchestrator --type abort --to CTL-400 --orch orch-test >/dev/null 2>&1
ABORT_LINES=$(messages_of_type abort)
ABORT_COUNT=$(echo "$ABORT_LINES" | grep -c '"type":"abort"' || echo 0)
ABORT_TO=$(echo "$ABORT_LINES" | jq -r '.to' | head -1)
ABORT_BODY=$(echo "$ABORT_LINES" | jq -r '.body' | head -1)
assert_eq "1" "$ABORT_COUNT" "exactly one abort message posted"
assert_eq "CTL-400" "$ABORT_TO" "abort.to = phase-agent ticket"
case "$ABORT_BODY" in
  *"parent orchestrator"*) pass "abort body preserves orchestrator reason" ;;
  *) fail "abort body preserves orchestrator reason — got '$ABORT_BODY'" ;;
esac

# Verify that all three orchestrator-→agent types are accepted.
"$COMMS" send "$CHANNEL" "pause for human review" \
  --as orchestrator --type pause --to CTL-400 --orch orch-test >/dev/null 2>&1
PAUSE_COUNT=$(messages_of_type pause | grep -c '"type":"pause"' || echo 0)
assert_eq "1" "$PAUSE_COUNT" "pause type accepted by send"

# ─── Test 5: orchestrator surfaces unanswerable questions via state.json `attention`
echo ""
echo "Test 5: orchestrator records needsAttention in global state for unanswerable question"
fresh_env t5
join_as CTL-500
QID=$("$COMMS" send "$CHANNEL" "unanswerable: legal review required before X" \
  --as CTL-500 --type question --orch orch-test 2>/dev/null)
QID="${QID//$'\n'/}"
# The orchestrator's monitor (real implementation in orch-monitor) writes an
# attention record into ~/catalyst/state.json when it cannot resolve a question
# locally. We simulate that write here using the same helper the monitor uses.
if [[ -x "$STATE" ]]; then
  # The orchestrator must exist before attention can be flagged on it.
  "$STATE" init >/dev/null 2>&1 || true
  "$STATE" register orch-test '{"orchId":"orch-test","status":"running","workers":{"CTL-500":{"ticket":"CTL-500","status":"researching","phase":1}}}' \
    >/dev/null 2>&1 || true
  "$STATE" attention orch-test "needs-clarification" "CTL-500" \
    "unanswerable question (qid=${QID})" >/dev/null 2>&1 || true
  GLOBAL_STATE="${CATALYST_DIR}/state.json"
  if [[ -f "$GLOBAL_STATE" ]]; then
    # Schema (catalyst-state.sh cmd_attention):
    #   .orchestrators[$oid].attention[0].{type,ticketId,message,since}
    #   .orchestrators[$oid].workers[$tid].needsAttention = true
    ATTN_TYPE=$(jq -r '.orchestrators."orch-test".attention[0].type // empty' \
      "$GLOBAL_STATE" 2>/dev/null)
    ATTN_WORKER=$(jq -r '.orchestrators."orch-test".attention[0].ticketId // empty' \
      "$GLOBAL_STATE" 2>/dev/null)
    NEEDS=$(jq -r '.orchestrators."orch-test".workers."CTL-500".needsAttention // false' \
      "$GLOBAL_STATE" 2>/dev/null)
    assert_eq "needs-clarification" "$ATTN_TYPE" "global state records attention type"
    assert_eq "CTL-500" "$ATTN_WORKER" "global state records correct worker ticket"
    assert_eq "true" "$NEEDS" "worker.needsAttention flag set"
  else
    fail "global state.json was not written"
  fi
else
  echo "  SKIP: catalyst-state.sh not executable — test 5 needs the helper to demonstrate the contract"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "phase-agent-comms: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
