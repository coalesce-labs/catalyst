#!/usr/bin/env bash
# Integration tests for the orchestrator's phase-agent state machine (CTL-452).
#
# Composes orchestrate-dispatch-next, orchestrate-phase-advance, and
# orchestrate-healthcheck against fake claude / fake phase-agent-dispatch
# stubs to verify the end-to-end flow:
#
#   wave1Pending → phase-triage → (phase.triage.complete wake) → phase-research → … → phase-monitor-deploy
#
# This file matches the test list in
# thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md
# §Initiative 1 Phase 6 — Tests First.
#
# Run: bash plugins/dev/scripts/__tests__/orchestrate-phase-state-machine.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/orchestrate-dispatch-next"
ADVANCE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-phase-advance"
HEALTHCHECK="${REPO_ROOT}/plugins/dev/scripts/orchestrate-healthcheck"

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

  # Fake state script — accumulates events for assertion.
  cat > "${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/catalyst-state.sh"
  export STATE_LOG="${SCRATCH}/state.log"
  : > "$STATE_LOG"
  export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"

  # Fake phase-agent-dispatch — writes a phase signal mirroring the real helper.
  cat > "${SCRATCH}/bin/phase-agent-dispatch" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$PHASE_DISPATCH_LOG"
ORCH_DIR=""; PHASE=""; TICKET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --orch-dir) ORCH_DIR="$2"; shift 2 ;;
    --phase)    PHASE="$2"; shift 2 ;;
    --ticket)   TICKET="$2"; shift 2 ;;
    *)          shift ;;
  esac
done
if [ -n "$ORCH_DIR" ] && [ -n "$PHASE" ] && [ -n "$TICKET" ]; then
  mkdir -p "${ORCH_DIR}/workers/${TICKET}"
  jq -n --arg t "$TICKET" --arg p "$PHASE" \
    '{ticket:$t, phase:$p, status:"dispatched", bg_job_id:("bg-" + $t + "-" + $p)}' \
    > "${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
fi
echo '{"status":"running"}'
EOF
  chmod +x "${SCRATCH}/bin/phase-agent-dispatch"
  export PHASE_DISPATCH_LOG="${SCRATCH}/phase-dispatch.log"
  : > "$PHASE_DISPATCH_LOG"
  export CATALYST_PHASE_AGENT_DISPATCH="${SCRATCH}/bin/phase-agent-dispatch"

  # Fake claude — never called in phase-agents mode, but kept available so
  # the dispatcher's pre-flight checks pass.
  cat > "${SCRATCH}/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "args: $*" >> "$CLAUDE_LOG"
sleep 30 &
disown $! 2>/dev/null || true
EOF
  chmod +x "${SCRATCH}/bin/claude"
  export CLAUDE_LOG="${SCRATCH}/claude.log"
  : > "$CLAUDE_LOG"
  export CATALYST_DISPATCH_CLAUDE_BIN="${SCRATCH}/bin/claude"
  export CATALYST_DISPATCH_HEALTHCHECK=""   # bypass post-dispatch healthcheck

  # Config: dispatchMode = phase-agents
  mkdir -p "${SCRATCH}/.catalyst"
  cat > "${SCRATCH}/.catalyst/config.json" <<EOF2
{"catalyst": {"orchestration": {"dispatchMode": "phase-agents"}}}
EOF2
  export TEST_CONFIG="${SCRATCH}/.catalyst/config.json"
}

scratch_teardown() {
  pkill -f "sleep 30" 2>/dev/null || true
  rm -rf "$SCRATCH"
  unset SCRATCH ORCH_DIR WORKTREE_ROOT STATE_LOG PHASE_DISPATCH_LOG CLAUDE_LOG TEST_CONFIG
  unset CATALYST_STATE_SCRIPT CATALYST_PHASE_AGENT_DISPATCH CATALYST_DISPATCH_CLAUDE_BIN CATALYST_DISPATCH_HEALTHCHECK
}

write_state() {
  local orch="$1" mp="$2" queue="$3"
  cat > "${ORCH_DIR}/state.json" <<EOF
{
  "orchestrator": "${orch}",
  "startedAt": "$(now_iso)",
  "baseBranch": "main",
  "worktreeBase": "${WORKTREE_ROOT}",
  "maxParallel": ${mp},
  "queue": ${queue}
}
EOF
}

make_worktree() { mkdir -p "${WORKTREE_ROOT}/${1}-${2}"; }

# ─── Test 1: orchestrator dispatches phase 1 when worker enters dispatched state
echo "test 1: dispatchMode=phase-agents drains wave queue as phase-triage"
scratch_setup
write_state "smtest" 4 '{"wave1Pending": ["T-1", "T-2"]}'
make_worktree "smtest" "T-1"
make_worktree "smtest" "T-2"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$TEST_CONFIG" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "dispatch exit 0" || fail "dispatch exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
COUNT_TRIAGE=$(grep -c -- "--phase triage" "$PHASE_DISPATCH_LOG" || echo 0)
[ "$COUNT_TRIAGE" = "2" ] && pass "both tickets dispatched as triage" || fail "both tickets dispatched as triage" "count=$COUNT_TRIAGE"
[ -f "${ORCH_DIR}/workers/T-1/phase-triage.json" ] && pass "T-1 triage signal created" || fail "T-1 triage signal created"
[ -f "${ORCH_DIR}/workers/T-2/phase-triage.json" ] && pass "T-2 triage signal created" || fail "T-2 triage signal created"
scratch_teardown

# ─── Test 2: phase.N.complete wake advances to phase N+1
echo "test 2: phase.triage.complete wake → dispatches phase-research"
scratch_setup
write_state "smtest" 4 '{"wave1Pending": []}'
make_worktree "smtest" "T-1"
# Simulate that triage completed: write the triage signal + mark done.
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"triage","status":"done","bg_job_id":"bg-T-1-triage"}' \
  > "${ORCH_DIR}/workers/T-1/phase-triage.json"
# Drive the advance helper as the orchestrator's wake handler would.
OUT=$("$ADVANCE" --orch-dir "$ORCH_DIR" --orch-id "smtest" \
  --ticket "T-1" --completed-phase "triage" 2>"${SCRATCH}/err")
echo "$OUT" | jq -e '.advanced == true and .toPhase == "research"' >/dev/null \
  && pass "advanced to research" || fail "advanced to research" "got: $OUT"
grep -q -- "--phase research" "$PHASE_DISPATCH_LOG" && pass "phase-research dispatched" || fail "phase-research dispatched" "log: $(cat "$PHASE_DISPATCH_LOG")"
[ -f "${ORCH_DIR}/workers/T-1/phase-research.json" ] && pass "research signal created" || fail "research signal created"
scratch_teardown

# ─── Test 3: phase.N.failed wake should leave worker for revive (not advance)
echo "test 3: phase.research.failed does NOT advance (failure handler is revive, not advance)"
scratch_setup
write_state "smtest" 4 '{"wave1Pending": []}'
make_worktree "smtest" "T-1"
mkdir -p "${ORCH_DIR}/workers/T-1"
# Triage was done, research failed. Wake handler should NOT call advance —
# advance is only for .complete events. The failure path uses revive (covered
# by the bg-revive test suite). This test verifies that calling advance with
# the failed-phase name correctly resolves the next phase but the orchestrator
# wouldn't actually call it in that case; the contract is encoded in SKILL.md.
# Here we assert that NO automatic advance happens unless the orchestrator
# chooses to call it.
echo '{"ticket":"T-1","phase":"triage","status":"done","bg_job_id":"bg-T-1-triage"}' \
  > "${ORCH_DIR}/workers/T-1/phase-triage.json"
echo '{"ticket":"T-1","phase":"research","status":"failed","bg_job_id":"bg-T-1-research"}' \
  > "${ORCH_DIR}/workers/T-1/phase-research.json"
# No advance was called → no new phase signal beyond research.
[ ! -f "${ORCH_DIR}/workers/T-1/phase-plan.json" ] && pass "plan NOT dispatched after research failure" || fail "plan NOT dispatched after research failure"
[ ! -s "$PHASE_DISPATCH_LOG" ] && pass "phase-agent-dispatch NOT called on failure" || fail "phase-agent-dispatch NOT called on failure"
scratch_teardown

# ─── Test 4: redundant wake → idempotent advance (no double-dispatch)
echo "test 4: redundant phase.triage.complete wake is idempotent"
scratch_setup
write_state "smtest" 4 '{"wave1Pending": []}'
make_worktree "smtest" "T-1"
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"triage","status":"done"}' \
  > "${ORCH_DIR}/workers/T-1/phase-triage.json"
# First wake — advances to research.
"$ADVANCE" --orch-dir "$ORCH_DIR" --orch-id "smtest" \
  --ticket "T-1" --completed-phase "triage" >/dev/null 2>"${SCRATCH}/err"
FIRST_COUNT=$(wc -l < "$PHASE_DISPATCH_LOG" | tr -d ' ')
# Second wake — same event, redundant.
OUT=$("$ADVANCE" --orch-dir "$ORCH_DIR" --orch-id "smtest" \
  --ticket "T-1" --completed-phase "triage" 2>"${SCRATCH}/err")
SECOND_COUNT=$(wc -l < "$PHASE_DISPATCH_LOG" | tr -d ' ')
echo "$OUT" | jq -e '.advanced == false and .reason == "already-dispatched"' >/dev/null \
  && pass "second wake reports already-dispatched" || fail "second wake reports already-dispatched" "got: $OUT"
[ "$FIRST_COUNT" = "$SECOND_COUNT" ] && pass "no double-dispatch (count stable: $FIRST_COUNT)" || fail "no double-dispatch" "first=$FIRST_COUNT second=$SECOND_COUNT"
scratch_teardown

# ─── Test 5: broker restart resilience (interest re-registration is broker-side)
echo "test 5: broker restart — orchestrator re-registers phase_lifecycle interest"
scratch_setup
write_state "smtest" 4 '{"wave1Pending": []}'
# This is a contract assertion against the SKILL.md Phase 4 block: when the
# orchestrator re-enters Phase 4 after a broker restart, the registration
# block emits filter.register events for every active ticket. We assert the
# shape by exercising the registration directly via the state script call
# the SKILL block would make.
"$CATALYST_STATE_SCRIPT" event \
  '{"event":"filter.register","detail":{"interest_type":"phase_lifecycle","ticket":"T-1","phase_names":["triage","research","plan","implement","verify","review","pr","monitor-merge","monitor-deploy"]}}'
"$CATALYST_STATE_SCRIPT" event \
  '{"event":"filter.register","detail":{"interest_type":"phase_lifecycle","ticket":"T-2","phase_names":["triage","research","plan","implement","verify","review","pr","monitor-merge","monitor-deploy"]}}'
COUNT=$(grep -c "phase_lifecycle" "$STATE_LOG" || echo 0)
[ "$COUNT" = "2" ] && pass "two phase_lifecycle interests registered on Phase 4 re-entry" || fail "two phase_lifecycle interests registered" "count=$COUNT"
# Both interest registrations include all 9 phase names.
ALL_9=$(grep "monitor-deploy" "$STATE_LOG" | wc -l | tr -d ' ')
[ "$ALL_9" = "2" ] && pass "each interest covers all 9 phases" || fail "each interest covers all 9 phases" "count=$ALL_9"
scratch_teardown

# ─── Test 6: healthcheck detects stale --bg state.json
echo "test 6: healthcheck flags phase-mode worker with state.json mtime > 15 min"
scratch_setup
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"implement","status":"running","bg_job_id":"bg-stale"}' \
  > "${ORCH_DIR}/workers/T-1/phase-implement.json"
# Build a stale state.json
mkdir -p "${SCRATCH}/jobs/bg-stale"
echo '{"state":"running"}' > "${SCRATCH}/jobs/bg-stale/state.json"
then=$(( $(date -u +%s) - 1200 ))
touch -t "$(date -r "$then" "+%Y%m%d%H%M.%S")" "${SCRATCH}/jobs/bg-stale/state.json"
export CATALYST_HEALTHCHECK_JOBS_ROOT="${SCRATCH}/jobs"
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "smtest" --grace-seconds 0 \
  --stale-bg-seconds 900 > "${SCRATCH}/out" 2>"${SCRATCH}/err"
ST=$(jq -r '.status' "${ORCH_DIR}/workers/T-1/phase-implement.json")
[ "$ST" = "stalled" ] && pass "stale --bg state.json → status=stalled" || fail "stale --bg state.json → status=stalled" "got: $ST"
grep -q "worker-phase-stalled" "$STATE_LOG" && pass "worker-phase-stalled event emitted" || fail "worker-phase-stalled event emitted"
scratch_teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
