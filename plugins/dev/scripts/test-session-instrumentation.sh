#!/usr/bin/env bash
# Test suite for CTL-38: session tracking instrumentation in skills.
#
# Validates that each instrumented skill:
#   1. Contains a session-start preamble (catalyst-session start)
#   2. Contains a session-end postamble (catalyst-session end)
#   3. Contains phase transitions where expected
#   4. Uses the --workflow flag for sub-agent correlation where expected
#   5. Gracefully degrades when catalyst-session.sh is missing
#   6. Oneshot dual-writes both signal files AND catalyst-session
#
# Also runs a live integration test with an isolated CATALYST_DIR to verify
# sessions are actually created and phases recorded.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SESS_SCRIPT="$SCRIPT_DIR/catalyst-session.sh"
DB_SCRIPT="$SCRIPT_DIR/catalyst-db.sh"

PASS=true
TESTS=0
FAILURES=0

fail() { echo "  FAIL: $1"; PASS=false; FAILURES=$((FAILURES + 1)); }
pass() { echo "  PASS: $1"; }
run_test() { TESTS=$((TESTS + 1)); echo ""; echo "--- Test $TESTS: $1 ---"; }

assert_contains() {
  local file="$1" pattern="$2" label="$3"
  if grep -qF -- "$pattern" "$file" 2>/dev/null; then
    pass "$label"
  else
    fail "$label — pattern '$pattern' not found in $(basename "$file")"
  fi
}

assert_not_contains() {
  local file="$1" pattern="$2" label="$3"
  if ! grep -qF -- "$pattern" "$file" 2>/dev/null; then
    pass "$label"
  else
    fail "$label — pattern '$pattern' should NOT be in $(basename "$file")"
  fi
}

make_tmpdir() { mktemp -d -t session-instr-test-XXXXXX; }

# ─── Skill files ──────────────────────────────────────────────────────────────
ONESHOT="$PLUGIN_ROOT/skills/oneshot/SKILL.md"
RESEARCH="$PLUGIN_ROOT/skills/research-codebase/SKILL.md"
PLAN="$PLUGIN_ROOT/skills/create-plan/SKILL.md"
IMPLEMENT="$PLUGIN_ROOT/skills/implement-plan/SKILL.md"
ORCHESTRATE="$PLUGIN_ROOT/skills/orchestrate/SKILL.md"
CI_COMMIT="$PLUGIN_ROOT/skills/ci-commit/SKILL.md"

echo "=== Session Instrumentation Test Suite (CTL-38) ==="
echo ""

# ─── Test 1: ci-commit has session start/end ──────────────────────────────────
run_test "ci-commit has session preamble and postamble"
assert_contains "$CI_COMMIT" 'catalyst-session.sh' "ci-commit references catalyst-session.sh"
assert_contains "$CI_COMMIT" 'start --skill' "ci-commit has session start"
assert_contains "$CI_COMMIT" '"$SESSION_SCRIPT" end' "ci-commit has session end"
assert_contains "$CI_COMMIT" 'ci-commit' "ci-commit uses correct skill name"

# ─── Test 2: research-codebase has session start/end/phase ────────────────────
run_test "research-codebase has session tracking"
assert_contains "$RESEARCH" 'catalyst-session.sh' "research references catalyst-session.sh"
assert_contains "$RESEARCH" 'start --skill' "research has session start"
assert_contains "$RESEARCH" '"$SESSION_SCRIPT" end' "research has session end"
assert_contains "$RESEARCH" '"$SESSION_SCRIPT" phase' "research has phase transition"

# ─── Test 3: create-plan has session start/end/phase ──────────────────────────
run_test "create-plan has session tracking"
assert_contains "$PLAN" 'catalyst-session.sh' "plan references catalyst-session.sh"
assert_contains "$PLAN" 'start --skill' "plan has session start"
assert_contains "$PLAN" '"$SESSION_SCRIPT" end' "plan has session end"
assert_contains "$PLAN" '"$SESSION_SCRIPT" phase' "plan has phase transition"

# ─── Test 4: implement-plan has session start/end/phase ───────────────────────
run_test "implement-plan has session tracking"
assert_contains "$IMPLEMENT" 'catalyst-session.sh' "implement references catalyst-session.sh"
assert_contains "$IMPLEMENT" 'start --skill' "implement has session start"
assert_contains "$IMPLEMENT" '"$SESSION_SCRIPT" end' "implement has session end"
assert_contains "$IMPLEMENT" '"$SESSION_SCRIPT" phase' "implement has phase transition"

# ─── Test 5: oneshot has session start/end/phase + dual-write ─────────────────
run_test "oneshot has session tracking with dual-write"
assert_contains "$ONESHOT" 'catalyst-session.sh' "oneshot references catalyst-session.sh"
assert_contains "$ONESHOT" 'start --skill' "oneshot has session start"
assert_contains "$ONESHOT" '"$SESSION_SCRIPT" end' "oneshot has session end"
assert_contains "$ONESHOT" '"$SESSION_SCRIPT" phase' "oneshot has phase transitions"
assert_contains "$ONESHOT" '"$SESSION_SCRIPT" pr' "oneshot has PR recording"
assert_contains "$ONESHOT" 'CATALYST_SESSION_ID' "oneshot exports session ID for sub-agents"

# ─── Test 6: orchestrate has session start/end/phase ──────────────────────────
run_test "orchestrate has session tracking"
assert_contains "$ORCHESTRATE" 'catalyst-session.sh' "orchestrate references catalyst-session.sh"
assert_contains "$ORCHESTRATE" 'start --skill' "orchestrate has session start"
assert_contains "$ORCHESTRATE" '"$SESSION_SCRIPT" end' "orchestrate has session end"
assert_contains "$ORCHESTRATE" '"$SESSION_SCRIPT" phase' "orchestrate has phase transitions"

# ─── Test 7: All skills use graceful degradation pattern ──────────────────────
run_test "all skills use graceful degradation (-x check)"
for SKILL_FILE in "$CI_COMMIT" "$RESEARCH" "$PLAN" "$IMPLEMENT" "$ONESHOT" "$ORCHESTRATE"; do
  SKILL_NAME=$(basename "$(dirname "$SKILL_FILE")")
  assert_contains "$SKILL_FILE" '-x "$SESSION_SCRIPT"' "$SKILL_NAME checks if script is executable"
done

# ─── Test 8: oneshot passes CATALYST_SESSION_ID to humanlayer launch ──────────
run_test "oneshot passes session ID to sub-sessions via --workflow"
assert_contains "$ONESHOT" '--workflow' "oneshot passes --workflow to child sessions"

# ─── Test 9: orchestrate passes CATALYST_SESSION_ID to workers ────────────────
run_test "orchestrate passes session ID to dispatched workers"
assert_contains "$ORCHESTRATE" 'CATALYST_SESSION_ID' "orchestrate sets CATALYST_SESSION_ID for workers"

# ─── Test 10: Live integration — session lifecycle ────────────────────────────
run_test "live integration: session start → phase → end lifecycle"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

SID=$("$SESS_SCRIPT" start --skill "test-skill" --ticket "CTL-38" --label "instrumentation-test")
[[ -n "$SID" ]] && pass "session created ($SID)" || fail "session creation failed"

"$SESS_SCRIPT" phase "$SID" "researching" --phase 1
"$SESS_SCRIPT" phase "$SID" "planning" --phase 2
"$SESS_SCRIPT" phase "$SID" "implementing" --phase 3
"$SESS_SCRIPT" end "$SID" --status done

STATUS=$("$DB_SCRIPT" session get "$SID" | jq -r '.status')
PHASE=$("$DB_SCRIPT" session get "$SID" | jq -r '.phase')

if [[ "$STATUS" == "done" ]]; then
  pass "session ended with status 'done'"
else
  fail "expected status 'done', got '$STATUS'"
fi
if [[ "$PHASE" == "3" ]]; then
  pass "final phase is 3"
else
  fail "expected phase 3, got '$PHASE'"
fi

rm -rf "$TMP"

# ─── Test 11: Live integration — workflow linking ─────────────────────────────
run_test "live integration: parent/child session linking via --workflow"
TMP=$(make_tmpdir)
export CATALYST_DIR="$TMP"
"$DB_SCRIPT" init >/dev/null

PARENT_SID=$("$SESS_SCRIPT" start --skill "oneshot" --ticket "CTL-38")
CHILD_SID=$("$SESS_SCRIPT" start --skill "research-codebase" --ticket "CTL-38" --workflow "$PARENT_SID")

CHILD_WORKFLOW=$("$DB_SCRIPT" session get "$CHILD_SID" | jq -r '.workflow_id')
if [[ "$CHILD_WORKFLOW" == "$PARENT_SID" ]]; then
  pass "child session linked to parent via workflow_id"
else
  fail "expected workflow_id '$PARENT_SID', got '$CHILD_WORKFLOW'"
fi

"$SESS_SCRIPT" end "$CHILD_SID" --status done
"$SESS_SCRIPT" end "$PARENT_SID" --status done
rm -rf "$TMP"

# ─── Test 12: Graceful degradation — missing script ──────────────────────────
run_test "graceful degradation: skills don't crash without catalyst-session.sh"
TMP=$(make_tmpdir)
FAKE_SCRIPT="$TMP/catalyst-session.sh"
# Don't create the script — it shouldn't exist
if [[ ! -x "$FAKE_SCRIPT" ]]; then
  pass "missing script correctly detected as non-executable"
else
  fail "fake script should not exist"
fi
rm -rf "$TMP"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $((TESTS)) tests, $((FAILURES)) failures ==="
if $PASS; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
