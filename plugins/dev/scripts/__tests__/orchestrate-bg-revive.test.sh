#!/usr/bin/env bash
# Shell tests for orchestrate-revive --bg --resume path (CTL-452).
#
# Covers the phase-agent-mode revival shape: claude --bg --resume <sid>
# (no -p), re-emit phase.<name>.dispatched so the broker re-arms its
# phase_lifecycle interest, and capture the new bg_job_id into the
# per-phase signal.
#
# Run: bash plugins/dev/scripts/__tests__/orchestrate-bg-revive.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
REVIVE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-revive"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

DEAD_PID=99999999
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID+1)); done

scratch_setup() {
  SCRATCH="$(mktemp -d)"
  ORCH_DIR="${SCRATCH}/orch"
  mkdir -p "${ORCH_DIR}/workers/output" "${SCRATCH}/bin" "${SCRATCH}/worktrees"

  # Fake state script — logs argv.
  cat > "${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/catalyst-state.sh"
  export STATE_LOG="${SCRATCH}/state.log"
  : > "$STATE_LOG"
  export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"

  # Fake claude — logs argv + env + emits a fake bg_job_id JSON on stdout
  # (simulating `claude --bg --resume` job-id output). Two output shapes
  # to cover both paths:
  #   - `claude --bg --resume`  → stdout has bg_job_id line
  #   - `claude -p --resume`    → stdout is a stream of JSON events (legacy)
  cat > "${SCRATCH}/bin/claude" <<'EOF'
#!/usr/bin/env bash
{
  echo "---"
  echo "args: $*"
  echo "cwd=$(pwd)"
  echo "ORCH_DIR=${CATALYST_ORCHESTRATOR_DIR:-}"
  echo "OTEL=${OTEL_RESOURCE_ATTRIBUTES:-}"
} >> "$CLAUDE_LOG"
# Detect --bg presence
HAS_BG=0
for a in "$@"; do [ "$a" = "--bg" ] && HAS_BG=1; done
if [ "$HAS_BG" = "1" ]; then
  # Synthesize a bg_job_id (use pid for determinism in tests)
  JOB_ID="job-$$"
  echo "{\"id\":\"${JOB_ID}\",\"state\":\"running\"}"
fi
# Keep process alive so kill-0 sees a live PID.
sleep 30 &
disown $! 2>/dev/null || true
EOF
  chmod +x "${SCRATCH}/bin/claude"
  export CLAUDE_LOG="${SCRATCH}/claude.log"
  : > "$CLAUDE_LOG"
  export CATALYST_REVIVE_CLAUDE_BIN="${SCRATCH}/bin/claude"
}

scratch_teardown() {
  pkill -f "sleep 30" 2>/dev/null || true
  rm -rf "$SCRATCH"
  unset SCRATCH ORCH_DIR STATE_LOG CLAUDE_LOG
  unset CATALYST_STATE_SCRIPT CATALYST_REVIVE_CLAUDE_BIN
}

# make_phase_signal TICKET PHASE STATUS BG_JOB_ID PID
# Phase-mode workers carry a top-level signal (workers/<T>.json) that points
# at the active phase, plus the per-phase signal (workers/<T>/phase-<P>.json).
# The revive logic detects phase-mode by .phaseMode = true OR the presence
# of .activePhase + per-phase signal carrying bg_job_id.
make_phase_signal() {
  local ticket="$1" phase="$2" status="$3" bg="$4" pid="${5:-$DEAD_PID}"
  local ts; ts=$(now_iso)
  # Top-level signal — flat workers/<T>.json
  jq -n \
    --arg t "$ticket" --arg s "$status" --arg phase "$phase" --arg pid "$pid" \
    --arg ts "$ts" --arg wt "${SCRATCH}/worktrees/${ticket}" \
    --arg wn "${ticket}-worker" \
    '{ticket:$t, status:$s, phase:$phase, activePhase:$phase, phaseMode:true,
      pid:($pid|tonumber), startedAt:$ts, updatedAt:$ts, lastHeartbeat:$ts,
      worktreePath:$wt, workerName:$wn,
      reviveCount:0}' \
    > "${ORCH_DIR}/workers/${ticket}.json"
  # Per-phase signal — workers/<T>/phase-<P>.json carries bg_job_id
  mkdir -p "${ORCH_DIR}/workers/${ticket}"
  jq -n \
    --arg t "$ticket" --arg p "$phase" --arg s "$status" --arg bg "$bg" --arg ts "$ts" \
    '{ticket:$t, phase:$p, status:$s, bg_job_id:$bg,
      startedAt:$ts, updatedAt:$ts}' \
    > "${ORCH_DIR}/workers/${ticket}/phase-${phase}.json"
  mkdir -p "${SCRATCH}/worktrees/${ticket}"
}

# write_stream_init TICKET SID — seed a workers/output/<T>-stream.jsonl so the
# revive script can resolve a session_id.
write_stream_init() {
  local ticket="$1" sid="$2"
  echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"${sid}\"}" \
    > "${ORCH_DIR}/workers/output/${ticket}-stream.jsonl"
}

# ─── Test 1: revive uses --bg --resume on phase-mode worker ────────────────
echo "test 1 (CTL-452): revive uses --bg --resume on stalled phase-mode worker"
scratch_setup
make_phase_signal "T-1" "implement" "implementing" "bg-old" "$DEAD_PID"
write_stream_init "T-1" "sess-1-abc"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 0 \
  > "${SCRATCH}/out" 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0" || fail "exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
grep -q -- "--bg" "$CLAUDE_LOG" && pass "claude invoked with --bg" || fail "claude invoked with --bg" "log: $(cat "$CLAUDE_LOG")"
grep -q -- "--resume sess-1-abc" "$CLAUDE_LOG" && pass "claude invoked with --resume <sid>" || fail "claude invoked with --resume <sid>"
grep -q -- "-p " "$CLAUDE_LOG" && fail "claude invoked WITHOUT -p (got -p in argv)" || pass "claude invoked WITHOUT -p"
scratch_teardown

# ─── Test 2: revive emits phase.<name>.dispatched event ────────────────────
echo "test 2 (CTL-452): revive emits phase.<name>.dispatched event"
scratch_setup
make_phase_signal "T-2" "verify" "verifying" "bg-old-2" "$DEAD_PID"
write_stream_init "T-2" "sess-2-abc"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 0 \
  > "${SCRATCH}/out" 2>"${SCRATCH}/err"
grep -q "phase.verify.dispatched" "$STATE_LOG" && pass "phase.verify.dispatched event emitted" || fail "phase.verify.dispatched event emitted" "log: $(cat "$STATE_LOG")"
grep -q "T-2" "$STATE_LOG" && pass "event mentions T-2" || fail "event mentions T-2"
scratch_teardown

# ─── Test 3: revive respects MAX_REVIVES (one-retry-then-escalate) ─────────
echo "test 3 (CTL-452): revive respects --max-revives budget"
scratch_setup
make_phase_signal "T-3" "plan" "planning" "bg-old-3" "$DEAD_PID"
write_stream_init "T-3" "sess-3-abc"
# Set reviveCount = 1, max-revives = 1 → second revive escalates to stalled.
jq '.reviveCount = 1' "${ORCH_DIR}/workers/T-3.json" > "${ORCH_DIR}/workers/T-3.json.tmp" \
  && mv "${ORCH_DIR}/workers/T-3.json.tmp" "${ORCH_DIR}/workers/T-3.json"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 0 \
  --max-revives 1 > "${SCRATCH}/out" 2>"${SCRATCH}/err"
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/T-3.json")
[ "$STATUS" = "stalled" ] && pass "exhausted budget → stalled" || fail "exhausted budget → stalled" "got: $STATUS"
ATTN=$(jq -r '.attentionReason' "${ORCH_DIR}/workers/T-3.json")
[ "$ATTN" = "revive-budget-exhausted" ] && pass "attentionReason=revive-budget-exhausted" || fail "attentionReason=revive-budget-exhausted" "got: $ATTN"
scratch_teardown

# ─── Test 4: revive of legacy oneshot worker (no bg_job_id) keeps -p path ─
echo "test 4 (CTL-452): legacy oneshot revive keeps -p --resume (backward compat)"
scratch_setup
# Legacy signal — top-level only, NO per-phase dir, NO bg_job_id.
ts=$(now_iso)
jq -n \
  --arg t "T-LEGACY" --arg pid "$DEAD_PID" --arg ts "$ts" \
  --arg wt "${SCRATCH}/worktrees/T-LEGACY" --arg wn "T-LEGACY-worker" \
  '{ticket:$t, status:"implementing", phase:3,
    pid:($pid|tonumber), startedAt:$ts, updatedAt:$ts, lastHeartbeat:$ts,
    worktreePath:$wt, workerName:$wn, reviveCount:0}' \
  > "${ORCH_DIR}/workers/T-LEGACY.json"
mkdir -p "${SCRATCH}/worktrees/T-LEGACY"
write_stream_init "T-LEGACY" "sess-legacy"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 0 \
  > "${SCRATCH}/out" 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0 for legacy revive" || fail "exit 0 for legacy revive" "rc=$RC"
grep -q -- "-p " "$CLAUDE_LOG" && pass "claude invoked WITH -p (legacy path)" || fail "claude invoked WITH -p (legacy path)" "log: $(cat "$CLAUDE_LOG")"
grep -q -- "--resume sess-legacy" "$CLAUDE_LOG" && pass "claude invoked with --resume sess-legacy" || fail "claude invoked with --resume sess-legacy"
grep -q -- "--bg" "$CLAUDE_LOG" && fail "claude should NOT use --bg in legacy mode" || pass "claude does NOT use --bg in legacy mode"
scratch_teardown

# ─── Test 5: revive captures new bg_job_id into per-phase signal ──────────
echo "test 5 (CTL-452): revive captures new bg_job_id into per-phase signal"
scratch_setup
make_phase_signal "T-5" "research" "researching" "bg-OLD" "$DEAD_PID"
write_stream_init "T-5" "sess-5-abc"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 0 \
  > "${SCRATCH}/out" 2>"${SCRATCH}/err"
NEW_BG=$(jq -r '.bg_job_id' "${ORCH_DIR}/workers/T-5/phase-research.json")
[ -n "$NEW_BG" ] && [ "$NEW_BG" != "bg-OLD" ] && pass "per-phase bg_job_id updated to new id" || fail "per-phase bg_job_id updated to new id" "got: $NEW_BG (was bg-OLD)"
scratch_teardown

# ─── Test 6 (CTL-495): revived session inherits task.type=phase-<phase> OTEL
echo "test 6 (CTL-495): revived claude --bg inherits task.type=phase-<phase>"
scratch_setup
make_phase_signal "T-6" "implement" "implementing" "bg-old-6" "$DEAD_PID"
write_stream_init "T-6" "sess-6-abc"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 0 \
  > "${SCRATCH}/out" 2>"${SCRATCH}/err"
grep -q "OTEL=.*task.type=phase-implement" "$CLAUDE_LOG" \
  && pass "claude inherits task.type=phase-implement (revive path)" \
  || fail "claude OTEL has task.type=phase-implement" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

# ─── Test 7 (CTL-495): each revive iteration tags with its own active phase
echo "test 7 (CTL-495): per-worker active phase determines task.type"
scratch_setup
make_phase_signal "T-7a" "research" "researching" "bg-old-7a" "$DEAD_PID"
make_phase_signal "T-7b" "verify"   "verifying"   "bg-old-7b" "$DEAD_PID"
write_stream_init "T-7a" "sess-7a"
write_stream_init "T-7b" "sess-7b"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 0 \
  > "${SCRATCH}/out" 2>"${SCRATCH}/err"
LOG=$(cat "$CLAUDE_LOG")
# Both task.types should appear at least once (one per worker iteration).
echo "$LOG" | grep -q "task.type=phase-research" \
  && pass "research worker tagged task.type=phase-research" \
  || fail "research worker tagged task.type=phase-research"
echo "$LOG" | grep -q "task.type=phase-verify" \
  && pass "verify worker tagged task.type=phase-verify" \
  || fail "verify worker tagged task.type=phase-verify"
scratch_teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
