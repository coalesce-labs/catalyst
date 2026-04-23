#!/usr/bin/env bash
# Shell tests for orchestrate-dispatch-next (CTL-116).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-dispatch-next.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/orchestrate-dispatch-next"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

scratch_setup() {
  SCRATCH="$(mktemp -d)"
  ORCH_DIR="${SCRATCH}/orch"
  WORKTREE_ROOT="${SCRATCH}/wt"
  mkdir -p "${ORCH_DIR}/workers/output" "${SCRATCH}/bin" "${WORKTREE_ROOT}"

  # Fake catalyst-state.sh — logs argv so tests can assert.
  cat > "${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/catalyst-state.sh"
  export STATE_LOG="${SCRATCH}/state.log"
  : > "$STATE_LOG"
  export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"

  # Fake claude binary — logs argv + env then sleeps so kill-0 sees a live PID.
  cat > "${SCRATCH}/bin/claude" <<'EOF'
#!/usr/bin/env bash
{
  echo "---"
  echo "pid=$$"
  echo "cwd=$(pwd)"
  echo "ORCH_DIR=${CATALYST_ORCHESTRATOR_DIR:-}"
  echo "ORCH_ID=${CATALYST_ORCHESTRATOR_ID:-}"
  echo "COMMS=${CATALYST_COMMS_CHANNEL:-}"
  echo "SESSION=${CATALYST_SESSION_ID:-}"
  echo "args: $*"
} >> "$CLAUDE_LOG"
sleep 30 &
disown $! 2>/dev/null || true
EOF
  chmod +x "${SCRATCH}/bin/claude"
  export CLAUDE_LOG="${SCRATCH}/claude.log"
  : > "$CLAUDE_LOG"
  export CATALYST_DISPATCH_CLAUDE_BIN="${SCRATCH}/bin/claude"

  # Disable the post-dispatch healthcheck in tests (would try to re-read signals
  # and might interfere with assertions). The script honors an empty env var.
  export CATALYST_DISPATCH_HEALTHCHECK=""
}

scratch_teardown() {
  pkill -f "sleep 30" 2>/dev/null || true
  rm -rf "$SCRATCH"
  unset STATE_LOG CLAUDE_LOG CATALYST_STATE_SCRIPT CATALYST_DISPATCH_CLAUDE_BIN
  unset CATALYST_DISPATCH_HEALTHCHECK SCRATCH ORCH_DIR WORKTREE_ROOT
}

# write_state ORCH_ID MAX_PARALLEL JQ_QUEUE
# Writes a minimal state.json into ORCH_DIR with the given orchestrator name,
# maxParallel, and a .queue object supplied as a JSON literal.
write_state() {
  local orch="$1" mp="$2" queue="$3"
  cat > "${ORCH_DIR}/state.json" <<EOF
{
  "orchestrator": "${orch}",
  "startedAt": "$(now_iso)",
  "baseBranch": "main",
  "worktreeBase": "${WORKTREE_ROOT}",
  "maxParallel": ${mp},
  "totalWaves": 3,
  "currentWave": 1,
  "queue": ${queue},
  "workers": {}
}
EOF
}

# make_worktree ORCH_ID TICKET — create an empty directory so the dispatcher's
# worktree existence check passes.
make_worktree() {
  mkdir -p "${WORKTREE_ROOT}/${1}-${2}"
}

# make_running_signal TICKET STATUS — seed a pre-existing signal so the
# running-count logic observes it.
make_running_signal() {
  local t="$1" s="$2"
  jq -n --arg t "$t" --arg s "$s" --arg ts "$(now_iso)" \
    '{ticket: $t, orchestrator: "demo", workerName: ("demo-" + $t),
      label: ("oneshot " + $t), status: $s, phase: 3,
      startedAt: $ts, updatedAt: $ts}' \
    > "${ORCH_DIR}/workers/${t}.json"
}

run_dispatch() {
  "$DISPATCH" --orch-dir "$ORCH_DIR" "$@"
}

# ─── Test cases ───────────────────────────────────────────────────────────────

echo "test 1: empty queue reports queueEmpty and exits 0"
scratch_setup
write_state "demo" 4 '{"wave1Pending": [], "wave2Pending": []}'
OUT=$(run_dispatch 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0" || fail "exit 0" "got rc=$RC stderr=$(cat "${SCRATCH}/err")"
echo "$OUT" | jq -e '.queueEmpty == true' >/dev/null && pass "queueEmpty=true" || fail "queueEmpty=true" "got: $OUT"
echo "$OUT" | jq -e '.dispatched == []' >/dev/null && pass "dispatched empty" || fail "dispatched empty" "got: $OUT"
[ ! -s "$CLAUDE_LOG" ] && pass "claude not invoked" || fail "claude not invoked"
scratch_teardown

echo "test 2: single wave — dispatches all up to maxParallel"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1", "T-2"]}'
make_worktree "demo" "T-1"
make_worktree "demo" "T-2"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1,T-2" ] && pass "dispatched T-1,T-2 in order" || fail "dispatched in order" "got: $DISPATCHED"
[ -f "${ORCH_DIR}/workers/T-1.json" ] && pass "signal T-1 created" || fail "signal T-1 created"
[ -f "${ORCH_DIR}/workers/T-2.json" ] && pass "signal T-2 created" || fail "signal T-2 created"
grep -q "oneshot" "$CLAUDE_LOG" && pass "claude invoked" || fail "claude invoked"
# Verify queue was drained
REMAINING=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
[ "$REMAINING" = "0" ] && pass "wave1Pending drained" || fail "wave1Pending drained" "remaining: $REMAINING"
# Verify signal carries expected fields
S1_STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/T-1.json")
S1_PHASE=$(jq -r '.phase' "${ORCH_DIR}/workers/T-1.json")
S1_LABEL=$(jq -r '.label' "${ORCH_DIR}/workers/T-1.json")
S1_WT=$(jq -r '.worktreePath' "${ORCH_DIR}/workers/T-1.json")
[ "$S1_STATUS" = "dispatched" ] && pass "T-1.status=dispatched" || fail "T-1.status=dispatched" "got: $S1_STATUS"
[ "$S1_PHASE" = "0" ] && pass "T-1.phase=0" || fail "T-1.phase=0" "got: $S1_PHASE"
[ "$S1_LABEL" = "oneshot T-1" ] && pass "T-1.label" || fail "T-1.label" "got: $S1_LABEL"
[ "$S1_WT" = "${WORKTREE_ROOT}/demo-T-1" ] && pass "T-1.worktreePath" || fail "T-1.worktreePath" "got: $S1_WT"
# Verify catalyst-state was called for dispatch
grep -q "worker demo T-1" "$STATE_LOG" && pass "state worker T-1 emitted" || fail "state worker T-1 emitted"
grep -q "event" "$STATE_LOG" && pass "state event emitted" || fail "state event emitted"
scratch_teardown

echo "test 3: three waves drain in numeric order (1 → 2 → 3)"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["A"], "wave2Pending": ["B"], "wave3Pending": ["C", "D"]}'
for T in A B C D; do make_worktree "demo" "$T"; done
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "A,B,C,D" ] && pass "drains waves in order" || fail "drains waves in order" "got: $DISPATCHED"
for T in A B C D; do
  [ -f "${ORCH_DIR}/workers/${T}.json" ] && pass "$T signal created" || fail "$T signal created"
done
scratch_teardown

echo "test 4: dynamic waveN enumeration — wave5, wave10 also drain"
scratch_setup
write_state "demo" 4 '{"wave1Pending": [], "wave5Pending": ["X-5"], "wave10Pending": ["X-10"]}'
make_worktree "demo" "X-5"
make_worktree "demo" "X-10"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
# Wave 5 before wave 10 (numeric sort, not lexicographic)
[ "$DISPATCHED" = "X-5,X-10" ] && pass "wave5 before wave10 (numeric order)" || fail "wave5 before wave10" "got: $DISPATCHED"
[ -f "${ORCH_DIR}/workers/X-5.json" ] && pass "X-5 dispatched" || fail "X-5 dispatched"
[ -f "${ORCH_DIR}/workers/X-10.json" ] && pass "X-10 dispatched" || fail "X-10 dispatched"
scratch_teardown

echo "test 5: respects maxParallel across waves"
scratch_setup
write_state "demo" 2 '{"wave1Pending": ["A", "B"], "wave2Pending": ["C"], "wave3Pending": ["D"]}'
for T in A B C D; do make_worktree "demo" "$T"; done
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "A,B" ] && pass "only 2 dispatched" || fail "only 2 dispatched" "got: $DISPATCHED"
REMAINING_1=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
REMAINING_2=$(jq -r '.queue.wave2Pending | length' "${ORCH_DIR}/state.json")
REMAINING_3=$(jq -r '.queue.wave3Pending | length' "${ORCH_DIR}/state.json")
[ "$REMAINING_1" = "0" ] && pass "wave1 drained" || fail "wave1 drained" "$REMAINING_1"
[ "$REMAINING_2" = "1" ] && pass "wave2 untouched" || fail "wave2 untouched" "$REMAINING_2"
[ "$REMAINING_3" = "1" ] && pass "wave3 untouched" || fail "wave3 untouched" "$REMAINING_3"
scratch_teardown

echo "test 6: respects already-running workers"
scratch_setup
write_state "demo" 3 '{"wave1Pending": ["A", "B"]}'
make_running_signal "RUN-1" "implementing"
make_running_signal "RUN-2" "pr-created"
make_worktree "demo" "A"
make_worktree "demo" "B"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
RUNNING=$(echo "$OUT" | jq -r '.running')
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$RUNNING" = "2" ] && pass "running=2 counted" || fail "running=2 counted" "got: $RUNNING"
[ "$DISPATCHED" = "A" ] && pass "only 1 new dispatched (maxParallel=3)" || fail "only 1 new dispatched" "got: $DISPATCHED"
scratch_teardown

echo "test 7: terminal workers don't count toward running"
scratch_setup
write_state "demo" 2 '{"wave1Pending": ["A", "B"]}'
make_running_signal "DONE-1" "done"
make_running_signal "FAIL-1" "failed"
make_running_signal "STALL-1" "stalled"
make_worktree "demo" "A"
make_worktree "demo" "B"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "A,B" ] && pass "both dispatched — terminals ignored" || fail "both dispatched" "got: $DISPATCHED"
scratch_teardown

echo "test 8: skips tickets whose worktree is missing"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["A", "MISSING", "B"]}'
make_worktree "demo" "A"
make_worktree "demo" "B"
# MISSING deliberately has no worktree
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "A,B" ] && pass "A and B dispatched, MISSING skipped" || fail "A and B dispatched, MISSING skipped" "got: $DISPATCHED"
grep -qi "MISSING" "${SCRATCH}/err" && pass "stderr mentions missing worktree" || fail "stderr mentions missing" "stderr: $(cat "${SCRATCH}/err")"
# MISSING stays in wave1Pending
jq -e '.queue.wave1Pending | contains(["MISSING"])' "${ORCH_DIR}/state.json" >/dev/null \
  && pass "MISSING left in queue" || fail "MISSING left in queue"
scratch_teardown

echo "test 9: idempotent — skips tickets that already have a signal"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["PRE-1", "NEW-1"]}'
make_running_signal "PRE-1" "researching"
make_worktree "demo" "PRE-1"
make_worktree "demo" "NEW-1"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "NEW-1" ] && pass "only NEW-1 dispatched" || fail "only NEW-1 dispatched" "got: $DISPATCHED"
# PRE-1 signal's status is preserved
PRE_STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PRE-1.json")
[ "$PRE_STATUS" = "researching" ] && pass "PRE-1 signal untouched" || fail "PRE-1 signal untouched" "got: $PRE_STATUS"
scratch_teardown

echo "test 10: --dry-run makes no state changes"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$(run_dispatch --dry-run 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "dispatched list reports T-1" || fail "dispatched list reports T-1" "got: $DISPATCHED"
[ ! -f "${ORCH_DIR}/workers/T-1.json" ] && pass "no signal file created" || fail "no signal file created"
[ ! -s "$CLAUDE_LOG" ] && pass "claude not invoked" || fail "claude not invoked"
REMAINING=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
[ "$REMAINING" = "1" ] && pass "queue untouched" || fail "queue untouched" "remaining: $REMAINING"
scratch_teardown

echo "test 11: no slots available → exits 0 with slots=0, no dispatches"
scratch_setup
write_state "demo" 2 '{"wave1Pending": ["A"]}'
make_running_signal "R1" "implementing"
make_running_signal "R2" "validating"
make_worktree "demo" "A"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 when full" || fail "exit 0 when full"
echo "$OUT" | jq -e '.slotsAfter == 0 and .dispatched == []' >/dev/null \
  && pass "slotsAfter=0 dispatched=[]" || fail "slotsAfter=0 dispatched=[]" "got: $OUT"
[ ! -f "${ORCH_DIR}/workers/A.json" ] && pass "A not dispatched" || fail "A not dispatched"
scratch_teardown

echo "test 12: ticket removed only from the wave it came from (not from others)"
scratch_setup
# Put a ticket "DUP" only in wave3Pending; verify wave1/wave2 untouched.
write_state "demo" 4 '{"wave1Pending": ["W1"], "wave2Pending": ["W2"], "wave3Pending": ["DUP"]}'
make_worktree "demo" "W1"
make_worktree "demo" "W2"
make_worktree "demo" "DUP"
run_dispatch 2>"${SCRATCH}/err" >/dev/null
W1_LEN=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
W2_LEN=$(jq -r '.queue.wave2Pending | length' "${ORCH_DIR}/state.json")
W3_LEN=$(jq -r '.queue.wave3Pending | length' "${ORCH_DIR}/state.json")
[ "$W1_LEN" = "0" ] && pass "wave1 drained to 0" || fail "wave1 drained" "$W1_LEN"
[ "$W2_LEN" = "0" ] && pass "wave2 drained to 0" || fail "wave2 drained" "$W2_LEN"
[ "$W3_LEN" = "0" ] && pass "wave3 drained to 0" || fail "wave3 drained" "$W3_LEN"
scratch_teardown

echo "test 13: env/args forwarded to claude"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
run_dispatch --session-id "sess-abc" --worker-command "/catalyst-dev:oneshot" \
  --worker-args "--auto-merge --extra" 2>"${SCRATCH}/err" >/dev/null
grep -q "ORCH_ID=demo" "$CLAUDE_LOG" && pass "ORCH_ID forwarded" || fail "ORCH_ID forwarded" "log: $(cat "$CLAUDE_LOG")"
grep -q "ORCH_DIR=${ORCH_DIR}" "$CLAUDE_LOG" && pass "ORCH_DIR forwarded" || fail "ORCH_DIR forwarded"
grep -q "SESSION=sess-abc" "$CLAUDE_LOG" && pass "SESSION_ID forwarded" || fail "SESSION_ID forwarded"
grep -q "COMMS=orch-demo" "$CLAUDE_LOG" && pass "COMMS channel forwarded (default orch-<id>)" || fail "COMMS channel forwarded"
grep -q -- "T-1 --auto-merge --extra" "$CLAUDE_LOG" && pass "worker args forwarded" || fail "worker args forwarded" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test 14: --orch-id override takes precedence over state.json"
scratch_setup
write_state "stateorch" 4 '{"wave1Pending": ["T-1"]}'
mkdir -p "${WORKTREE_ROOT}/cliorch-T-1"
run_dispatch --orch-id "cliorch" 2>"${SCRATCH}/err" >/dev/null
[ -f "${ORCH_DIR}/workers/T-1.json" ] && pass "signal created with override" || fail "signal created with override"
SIGNAL_ORCH=$(jq -r '.orchestrator' "${ORCH_DIR}/workers/T-1.json")
[ "$SIGNAL_ORCH" = "cliorch" ] && pass "signal.orchestrator=cliorch" || fail "signal.orchestrator=cliorch" "got: $SIGNAL_ORCH"
SIGNAL_WT=$(jq -r '.worktreePath' "${ORCH_DIR}/workers/T-1.json")
[ "$SIGNAL_WT" = "${WORKTREE_ROOT}/cliorch-T-1" ] && pass "worktreePath uses cli orch-id" || fail "worktreePath uses cli orch-id" "got: $SIGNAL_WT"
scratch_teardown

echo "test 15: missing --orch-dir fails with non-zero exit"
OUT=$("$DISPATCH" 2>&1)
RC=$?
[ "$RC" != "0" ] && pass "exits non-zero without --orch-dir" || fail "exits non-zero" "got rc=$RC"

echo "test 15b: --help prints the full usage block (concurrency note present)"
OUT=$("$DISPATCH" --help 2>&1)
echo "$OUT" | grep -q "Concurrency:" && pass "help shows concurrency note" || fail "help shows concurrency note" "got: $OUT"
echo "$OUT" | grep -q "CATALYST_DISPATCH_HEALTHCHECK" && pass "help shows env overrides" || fail "help shows env overrides"

echo "test 16: missing state.json fails"
scratch_setup
# No state.json
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" 2>&1)
RC=$?
[ "$RC" != "0" ] && pass "exits non-zero when state.json missing" || fail "exits non-zero when state.json missing"
scratch_teardown

echo "test 17: no .queue key → treated as empty queue"
scratch_setup
cat > "${ORCH_DIR}/state.json" <<EOF
{"orchestrator": "demo", "worktreeBase": "${WORKTREE_ROOT}", "maxParallel": 2}
EOF
OUT=$(run_dispatch 2>"${SCRATCH}/err")
echo "$OUT" | jq -e '.queueEmpty == true' >/dev/null \
  && pass "queueEmpty when .queue missing" || fail "queueEmpty when .queue missing" "got: $OUT"
scratch_teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
