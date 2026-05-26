#!/usr/bin/env bash
# Shell tests for orchestrate-revive socket-death / bg-idle resume handling (CTL-604).
#
# Covers the legacy-bash misclassification fixed in CTL-604:
#   1. detect_api_error_in_stream must also match a socket-connection-closed /
#      "running as a background agent" stream result (previously fell through to
#      pid-dead, masking the real cause).
#   2. spawn_revive_bg must classify the resume stderr: an "already running as a
#      background agent (bg)" message means the agent is ALIVE — the resume was a
#      no-op, NOT a fresh revive — so the caller must NOT bump reviveCount or
#      record lastReviveReason="pid-dead". A hard resume error must surface a
#      failure sentinel so the caller records revive-spawn-failed, not a false
#      successful revive.
#
# Run: bash plugins/dev/scripts/__tests__/orchestrate-revive-socket-death.test.sh

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

# scratch_setup [CLAUDE_STDERR] — optional stderr text the fake claude emits to
# its stderr file (simulating a bg-idle / resume error). Default: empty (clean
# resume that materializes a fresh bg_job_id on stdout).
scratch_setup() {
  local claude_stderr="${1:-}"
  SCRATCH="$(mktemp -d)"
  ORCH_DIR="${SCRATCH}/orch"
  mkdir -p "${ORCH_DIR}/workers/output" "${SCRATCH}/bin" "${SCRATCH}/worktrees"

  cat > "${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/catalyst-state.sh"
  export STATE_LOG="${SCRATCH}/state.log"
  : > "$STATE_LOG"
  export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"

  # Fake claude — emits CLAUDE_FAKE_STDERR to its own stderr (the resume stderr
  # the spawn captures), and a bg_job_id JSON to stdout only when no stderr was
  # configured (a clean resume).
  export CLAUDE_FAKE_STDERR="$claude_stderr"
  cat > "${SCRATCH}/bin/claude" <<'EOF'
#!/usr/bin/env bash
{
  echo "---"
  echo "args: $*"
} >> "$CLAUDE_LOG"
if [ -n "${CLAUDE_FAKE_STDERR:-}" ]; then
  echo "$CLAUDE_FAKE_STDERR" >&2
else
  HAS_BG=0
  for a in "$@"; do [ "$a" = "--bg" ] && HAS_BG=1; done
  if [ "$HAS_BG" = "1" ]; then
    echo "{\"id\":\"job-$$\",\"state\":\"running\"}"
  fi
fi
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
  unset SCRATCH ORCH_DIR STATE_LOG CLAUDE_LOG CLAUDE_FAKE_STDERR
  unset CATALYST_STATE_SCRIPT CATALYST_REVIVE_CLAUDE_BIN
}

# make_phase_signal TICKET PHASE STATUS BG PID
make_phase_signal() {
  local ticket="$1" phase="$2" status="$3" bg="$4" pid="${5:-$DEAD_PID}"
  local ts; ts=$(now_iso)
  jq -n \
    --arg t "$ticket" --arg s "$status" --arg phase "$phase" --arg pid "$pid" \
    --arg ts "$ts" --arg wt "${SCRATCH}/worktrees/${ticket}" \
    --arg wn "${ticket}-worker" \
    '{ticket:$t, status:$s, phase:$phase, activePhase:$phase, phaseMode:true,
      pid:($pid|tonumber), startedAt:$ts, updatedAt:$ts, lastHeartbeat:$ts,
      worktreePath:$wt, workerName:$wn, reviveCount:0}' \
    > "${ORCH_DIR}/workers/${ticket}.json"
  mkdir -p "${ORCH_DIR}/workers/${ticket}"
  jq -n \
    --arg t "$ticket" --arg p "$phase" --arg s "$status" --arg bg "$bg" --arg ts "$ts" \
    '{ticket:$t, phase:$p, status:$s, bg_job_id:$bg, startedAt:$ts, updatedAt:$ts}' \
    > "${ORCH_DIR}/workers/${ticket}/phase-${phase}.json"
  mkdir -p "${SCRATCH}/worktrees/${ticket}"
}

write_stream_init() {
  local ticket="$1" sid="$2"
  echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"${sid}\"}" \
    > "${ORCH_DIR}/workers/output/${ticket}-stream.jsonl"
}

# write_stream_result TICKET RESULT_TEXT — append a result event with the given
# api_error_status text so detect_api_error_in_stream can scan it.
write_stream_result() {
  local ticket="$1" text="$2"
  jq -nc --arg t "$text" --arg u "uuid-$RANDOM" \
    '{type:"result", is_error:true, api_error_status:$t, uuid:$u}' \
    >> "${ORCH_DIR}/workers/output/${ticket}-stream.jsonl"
}

# ─── Test 1: socket-connection-closed stream is detected as an API error ───────
echo "test 1 (CTL-604): 'socket connection was closed' stream → api-stream error reason"
scratch_setup
# Use a LIVE pid so pid-dead does NOT fire — only the stream error should trigger.
LIVE_PID=$$
make_phase_signal "T-SOCK" "research" "researching" "bg-old" "$LIVE_PID"
write_stream_init "T-SOCK" "sess-sock"
write_stream_result "T-SOCK" "API Error: The socket connection was closed unexpectedly"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 999999 \
  > "${SCRATCH}/out" 2>"${SCRATCH}/err"
REASON=$(jq -r '.lastReviveReason // ""' "${ORCH_DIR}/workers/T-SOCK.json")
[ "$REASON" = "api-stream-idle-timeout" ] && pass "socket-closed → api-stream reason (not pid-dead)" || fail "socket-closed → api-stream reason" "got: $REASON"
scratch_teardown

# ─── Test 2: 'running as a background agent' stream is detected too ────────────
echo "test 2 (CTL-604): 'running as a background agent' stream → api-stream error reason"
scratch_setup
LIVE_PID=$$
make_phase_signal "T-BG" "plan" "planning" "bg-old" "$LIVE_PID"
write_stream_init "T-BG" "sess-bg"
write_stream_result "T-BG" "this session is currently running as a background agent"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 999999 \
  > "${SCRATCH}/out" 2>"${SCRATCH}/err"
REASON=$(jq -r '.lastReviveReason // ""' "${ORCH_DIR}/workers/T-BG.json")
[ "$REASON" = "api-stream-idle-timeout" ] && pass "bg-agent stream → api-stream reason" || fail "bg-agent stream → api-stream reason" "got: $REASON"
scratch_teardown

# ─── Test 3: bg-idle resume failure is NOT recorded as a successful pid-dead revive ─
echo "test 3 (CTL-604): resume stderr 'currently running as a background agent (bg)' → no false revive"
scratch_setup "Error: this session is currently running as a background agent (bg) and cannot be resumed"
make_phase_signal "T-ALIVE" "research" "researching" "bg-old" "$DEAD_PID"
write_stream_init "T-ALIVE" "sess-alive"
"$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" --stale-heartbeat-seconds 0 \
  > "${SCRATCH}/out" 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0" || fail "exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
RC_COUNT=$(jq -r '.reviveCount' "${ORCH_DIR}/workers/T-ALIVE.json")
[ "$RC_COUNT" = "0" ] && pass "reviveCount NOT incremented (agent still alive)" || fail "reviveCount NOT incremented" "got: $RC_COUNT (expected 0)"
REASON=$(jq -r '.lastReviveReason // "none"' "${ORCH_DIR}/workers/T-ALIVE.json")
[ "$REASON" = "none" ] && pass "lastReviveReason NOT set to pid-dead" || fail "lastReviveReason NOT set" "got: $REASON"
scratch_teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
