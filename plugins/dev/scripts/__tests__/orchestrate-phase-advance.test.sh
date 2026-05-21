#!/usr/bin/env bash
# Shell tests for orchestrate-phase-advance (CTL-452).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-phase-advance.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ADVANCE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-phase-advance"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

scratch_setup() {
  SCRATCH="$(mktemp -d)"
  ORCH_DIR="${SCRATCH}/orch"
  mkdir -p "${ORCH_DIR}/workers" "${SCRATCH}/bin"

  # Fake catalyst-state.sh — logs argv for assertions.
  cat > "${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/catalyst-state.sh"
  export STATE_LOG="${SCRATCH}/state.log"
  : > "$STATE_LOG"
  export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"

  # Fake orchestrate-dispatch-next — logs argv + exits 0 with a fake summary.
  cat > "${SCRATCH}/bin/orchestrate-dispatch-next" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$DISPATCH_LOG"
echo '{"running":0,"slotsAfter":1,"dispatched":["fake"]}'
EOF
  chmod +x "${SCRATCH}/bin/orchestrate-dispatch-next"
  export DISPATCH_LOG="${SCRATCH}/dispatch.log"
  : > "$DISPATCH_LOG"
  export CATALYST_DISPATCH_NEXT_BIN="${SCRATCH}/bin/orchestrate-dispatch-next"

  # CTL-567: fake `claude` for the predecessor reap — logs `stop` calls.
  cat > "${SCRATCH}/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$CLAUDE_LOG"
case "$1" in
  stop)   exit 0 ;;
  agents) echo '[]' ;;
esac
EOF
  chmod +x "${SCRATCH}/bin/claude"
  export CLAUDE_LOG="${SCRATCH}/claude.log"
  : > "$CLAUDE_LOG"
  export CATALYST_DISPATCH_CLAUDE_BIN="${SCRATCH}/bin/claude"

  # Idle CPU probe so the safety belt always permits the reap.
  cat > "${SCRATCH}/bin/cpuprobe" <<'EOF'
#!/usr/bin/env bash
echo "0"
EOF
  chmod +x "${SCRATCH}/bin/cpuprobe"
  export CATALYST_EXECUTOR_CPU_PROBE="${SCRATCH}/bin/cpuprobe"

  # CTL-558: fake linear-transition.sh — logs argv, exit code is overridable
  # via LINEAR_TRANSITION_EXIT so a best-effort failure can be exercised.
  cat > "${SCRATCH}/bin/linear-transition.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$LINEAR_TRANSITION_LOG"
exit "${LINEAR_TRANSITION_EXIT:-0}"
EOF
  chmod +x "${SCRATCH}/bin/linear-transition.sh"
  export LINEAR_TRANSITION_LOG="${SCRATCH}/linear-transition.log"
  : > "$LINEAR_TRANSITION_LOG"
  export CATALYST_LINEAR_TRANSITION_BIN="${SCRATCH}/bin/linear-transition.sh"
}

scratch_teardown() {
  rm -rf "$SCRATCH"
  unset SCRATCH ORCH_DIR STATE_LOG DISPATCH_LOG CLAUDE_LOG LINEAR_TRANSITION_LOG
  unset CATALYST_STATE_SCRIPT CATALYST_DISPATCH_NEXT_BIN
  unset CATALYST_DISPATCH_CLAUDE_BIN CATALYST_EXECUTOR_CPU_PROBE
  unset CATALYST_LINEAR_TRANSITION_BIN LINEAR_TRANSITION_EXIT
}

# make_phase_signal TICKET PHASE STATUS [EXTRA_JQ]
make_phase_signal() {
  local t="$1" p="$2" s="$3" extra="${4:-.}"
  mkdir -p "${ORCH_DIR}/workers/${t}"
  jq -n --arg t "$t" --arg p "$p" --arg s "$s" --arg ts "$(now_iso)" \
    '{ticket: $t, phase: $p, status: $s, orchestrator: "demo",
      startedAt: $ts, updatedAt: $ts}' \
    | jq "$extra" > "${ORCH_DIR}/workers/${t}/phase-${p}.json"
}

run_advance() {
  "$ADVANCE" --orch-dir "$ORCH_DIR" --orch-id "demo" "$@"
}

# ─── Test cases ───────────────────────────────────────────────────────────────

echo "test 1: triage → research advances"
scratch_setup
make_phase_signal "T-1" "triage" "done"
OUT=$(run_advance --ticket "T-1" --completed-phase "triage" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0" || fail "exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
echo "$OUT" | jq -e '.advanced == true and .fromPhase == "triage" and .toPhase == "research" and .ticket == "T-1"' >/dev/null \
  && pass "advances triage → research" || fail "advances triage → research" "got: $OUT"
grep -q -- "--phase research" "$DISPATCH_LOG" && pass "dispatch-next called with --phase research" || fail "dispatch-next called with --phase research" "log: $(cat "$DISPATCH_LOG")"
grep -q -- "--ticket T-1" "$DISPATCH_LOG" && pass "dispatch-next called with --ticket T-1" || fail "dispatch-next called with --ticket T-1"
scratch_teardown

echo "test 2: monitor-deploy is terminal (no advance)"
scratch_setup
make_phase_signal "T-1" "monitor-deploy" "done"
OUT=$(run_advance --ticket "T-1" --completed-phase "monitor-deploy" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 on terminal" || fail "exit 0 on terminal"
echo "$OUT" | jq -e '.advanced == false and .toPhase == null and .reason == "terminal"' >/dev/null \
  && pass "terminal phase returns advanced=false" || fail "terminal phase returns advanced=false" "got: $OUT"
[ ! -s "$DISPATCH_LOG" ] && pass "dispatch-next NOT called" || fail "dispatch-next NOT called" "log: $(cat "$DISPATCH_LOG")"
scratch_teardown

echo "test 3: re-call after advance is idempotent (next signal exists)"
scratch_setup
make_phase_signal "T-1" "triage" "done"
make_phase_signal "T-1" "research" "running"
OUT=$(run_advance --ticket "T-1" --completed-phase "triage" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 on idempotent" || fail "exit 0 on idempotent"
echo "$OUT" | jq -e '.advanced == false and .reason == "already-dispatched"' >/dev/null \
  && pass "advanced=false + reason=already-dispatched" || fail "advanced=false + reason=already-dispatched" "got: $OUT"
[ ! -s "$DISPATCH_LOG" ] && pass "dispatch-next NOT called on idempotent" || fail "dispatch-next NOT called on idempotent"
scratch_teardown

echo "test 4: emits worker-phase-advanced event"
scratch_setup
make_phase_signal "T-1" "research" "done"
run_advance --ticket "T-1" --completed-phase "research" >/dev/null 2>"${SCRATCH}/err"
grep -q "worker-phase-advanced" "$STATE_LOG" && pass "event emitted" || fail "event emitted" "log: $(cat "$STATE_LOG")"
grep -q "T-1" "$STATE_LOG" && pass "event mentions T-1" || fail "event mentions T-1"
scratch_teardown

echo "test 5: passes correct flags to dispatch-next"
scratch_setup
make_phase_signal "T-2" "implement" "done"
run_advance --ticket "T-2" --completed-phase "implement" >/dev/null 2>"${SCRATCH}/err"
# Should dispatch phase=verify, ticket=T-2
grep -q -- "--phase verify" "$DISPATCH_LOG" && pass "--phase verify forwarded" || fail "--phase verify forwarded" "log: $(cat "$DISPATCH_LOG")"
grep -q -- "--ticket T-2" "$DISPATCH_LOG" && pass "--ticket T-2 forwarded" || fail "--ticket T-2 forwarded"
grep -q -- "--orch-dir ${ORCH_DIR}" "$DISPATCH_LOG" && pass "--orch-dir forwarded" || fail "--orch-dir forwarded"
grep -q -- "--orch-id demo" "$DISPATCH_LOG" && pass "--orch-id forwarded" || fail "--orch-id forwarded"
scratch_teardown

echo "test 6: --dry-run reports advance but skips dispatch"
scratch_setup
make_phase_signal "T-1" "plan" "done"
OUT=$(run_advance --ticket "T-1" --completed-phase "plan" --dry-run 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 on dry-run" || fail "exit 0 on dry-run"
echo "$OUT" | jq -e '.advanced == true and .fromPhase == "plan" and .toPhase == "implement" and .dryRun == true' >/dev/null \
  && pass "dry-run shows would-advance" || fail "dry-run shows would-advance" "got: $OUT"
[ ! -s "$DISPATCH_LOG" ] && pass "dispatch-next NOT called in dry-run" || fail "dispatch-next NOT called in dry-run"
[ ! -s "$STATE_LOG" ] && pass "state event NOT emitted in dry-run" || fail "state event NOT emitted in dry-run"
scratch_teardown

echo "test 7: unknown phase name → exit 2"
scratch_setup
OUT=$(run_advance --ticket "T-1" --completed-phase "nonsense" 2>&1)
RC=$?
[ "$RC" = "2" ] && pass "exit 2 on unknown phase" || fail "exit 2 on unknown phase" "rc=$RC"
echo "$OUT" | grep -qi "unknown phase\|invalid phase" && pass "stderr explains unknown phase" || fail "stderr explains unknown phase" "got: $OUT"
scratch_teardown

echo "test 8: full 9-phase sequence resolves correctly"
scratch_setup
# Spot-check every transition in the canonical sequence.
declare -a SEQ=(triage:research research:plan plan:implement implement:verify verify:review review:pr pr:monitor-merge monitor-merge:monitor-deploy)
for pair in "${SEQ[@]}"; do
  FROM="${pair%%:*}"
  TO="${pair##*:}"
  : > "$DISPATCH_LOG"
  : > "$STATE_LOG"
  make_phase_signal "TSEQ-${FROM}" "$FROM" "done"
  OUT=$(run_advance --ticket "TSEQ-${FROM}" --completed-phase "$FROM" 2>"${SCRATCH}/err")
  TOPHASE=$(echo "$OUT" | jq -r '.toPhase')
  [ "$TOPHASE" = "$TO" ] && pass "$FROM → $TO" || fail "$FROM → $TO" "got toPhase=$TOPHASE for OUT=$OUT"
done
scratch_teardown

echo "test 9 (CTL-567): predecessor with status=done + bg_job_id is reaped"
scratch_setup
make_phase_signal "T-1" "research" "done" '.bg_job_id = "abc12345"'
OUT=$(run_advance --ticket "T-1" --completed-phase "research" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0" || fail "exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
echo "$OUT" | jq -e '.advanced == true and .reapedPredecessor == true' >/dev/null \
  && pass "reapedPredecessor=true in output" || fail "reapedPredecessor=true in output" "got: $OUT"
grep -q -- "stop abc12345" "$CLAUDE_LOG" \
  && pass "claude stop called on predecessor bg job" || fail "claude stop called on predecessor bg job" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test 10 (CTL-567): predecessor with bg_job_id but status!=done is NOT reaped"
scratch_setup
make_phase_signal "T-1" "research" "running" '.bg_job_id = "abc12345"'
OUT=$(run_advance --ticket "T-1" --completed-phase "research" 2>"${SCRATCH}/err")
echo "$OUT" | jq -e '.advanced == true and .reapedPredecessor == false' >/dev/null \
  && pass "reapedPredecessor=false for non-done predecessor" || fail "reapedPredecessor=false for non-done predecessor" "got: $OUT"
[ ! -s "$CLAUDE_LOG" ] && pass "claude stop NOT called" || fail "claude stop NOT called" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test 11 (CTL-567): predecessor with no bg_job_id — advance still succeeds, no reap"
scratch_setup
make_phase_signal "T-1" "plan" "done"
OUT=$(run_advance --ticket "T-1" --completed-phase "plan" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 with no bg_job_id" || fail "exit 0 with no bg_job_id" "rc=$RC"
echo "$OUT" | jq -e '.advanced == true and .reapedPredecessor == false' >/dev/null \
  && pass "advances, reapedPredecessor=false" || fail "advances, reapedPredecessor=false" "got: $OUT"
[ ! -s "$CLAUDE_LOG" ] && pass "claude stop NOT called" || fail "claude stop NOT called"
scratch_teardown

echo "test 12 (CTL-567): --dry-run never reaps (returns before dispatch)"
scratch_setup
make_phase_signal "T-1" "research" "done" '.bg_job_id = "abc12345"'
OUT=$(run_advance --ticket "T-1" --completed-phase "research" --dry-run 2>"${SCRATCH}/err")
echo "$OUT" | jq -e '.dryRun == true' >/dev/null \
  && pass "dry-run reported" || fail "dry-run reported" "got: $OUT"
[ ! -s "$CLAUDE_LOG" ] && pass "claude stop NOT called in dry-run" || fail "claude stop NOT called in dry-run" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test 13 (CTL-558): advancing to a phase writes the mapped Linear status"
scratch_setup
make_phase_signal "T-1" "research" "done"
run_advance --ticket "T-1" --completed-phase "research" >/dev/null 2>"${SCRATCH}/err"
# research → plan → linear-transition --transition planning
grep -q -- "--transition planning" "$LINEAR_TRANSITION_LOG" \
  && pass "linear-transition --transition planning for research→plan" \
  || fail "linear-transition --transition planning for research→plan" "log: $(cat "$LINEAR_TRANSITION_LOG")"
grep -q -- "--ticket T-1" "$LINEAR_TRANSITION_LOG" \
  && pass "linear-transition --ticket T-1" || fail "linear-transition --ticket T-1" "log: $(cat "$LINEAR_TRANSITION_LOG")"
scratch_teardown

echo "test 14 (CTL-558): each non-terminal advance maps to the right stateMap key"
scratch_setup
declare -a KEYMAP=(triage:research research:planning plan:inProgress implement:verifying verify:reviewing review:inReview pr:inReview monitor-merge:inReview)
for pair in "${KEYMAP[@]}"; do
  FROM="${pair%%:*}"
  KEY="${pair##*:}"
  : > "$LINEAR_TRANSITION_LOG"
  make_phase_signal "TKEY-${FROM}" "$FROM" "done"
  run_advance --ticket "TKEY-${FROM}" --completed-phase "$FROM" >/dev/null 2>"${SCRATCH}/err"
  grep -q -- "--transition ${KEY}" "$LINEAR_TRANSITION_LOG" \
    && pass "completed-phase ${FROM} → --transition ${KEY}" \
    || fail "completed-phase ${FROM} → --transition ${KEY}" "log: $(cat "$LINEAR_TRANSITION_LOG")"
done
scratch_teardown

echo "test 15 (CTL-558): terminal monitor-deploy does NOT call linear-transition"
scratch_setup
make_phase_signal "T-1" "monitor-deploy" "done"
run_advance --ticket "T-1" --completed-phase "monitor-deploy" >/dev/null 2>"${SCRATCH}/err"
# monitor-deploy is terminal — orchestrate-phase-advance returns before any
# write; terminal Done is phase-monitor-merge's job (plan Phase 4 §1).
[ ! -s "$LINEAR_TRANSITION_LOG" ] \
  && pass "no linear-transition call on terminal monitor-deploy" \
  || fail "no linear-transition call on terminal monitor-deploy" "log: $(cat "$LINEAR_TRANSITION_LOG")"
scratch_teardown

echo "test 16 (CTL-558): a failed linear-transition never changes the advance exit code"
scratch_setup
make_phase_signal "T-1" "research" "done"
LINEAR_TRANSITION_EXIT=2 run_advance --ticket "T-1" --completed-phase "research" >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "status write is best-effort (advance exit 0)" || fail "status write is best-effort (advance exit 0)" "rc=$RC"
scratch_teardown

echo "test 17 (CTL-558): --config is forwarded to linear-transition when set"
scratch_setup
make_phase_signal "T-1" "research" "done"
run_advance --ticket "T-1" --completed-phase "research" --config "/tmp/x/.catalyst/config.json" >/dev/null 2>"${SCRATCH}/err"
grep -q -- "--config /tmp/x/.catalyst/config.json" "$LINEAR_TRANSITION_LOG" \
  && pass "--config forwarded to linear-transition" || fail "--config forwarded to linear-transition" "log: $(cat "$LINEAR_TRANSITION_LOG")"
scratch_teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
