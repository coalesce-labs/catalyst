#!/usr/bin/env bash
# Shell tests for orchestrate-revive (CTL-63).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-revive.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
REVIVE="${REPO_ROOT}/plugins/dev/scripts/orchestrate-revive"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# A PID that is guaranteed to be dead.
DEAD_PID=99999999
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID+1)); done

scratch_setup() {
  SCRATCH="$(mktemp -d)"
  ORCH_DIR="${SCRATCH}/orch"
  WORKTREE_ROOT="${SCRATCH}/wt"
  mkdir -p "${ORCH_DIR}/workers/output" "${SCRATCH}/bin" "${WORKTREE_ROOT}"

  # Fake state script: appends argv to state.log so tests can assert.
  cat > "${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/catalyst-state.sh"
  export STATE_LOG="${SCRATCH}/state.log"
  : > "$STATE_LOG"
  export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"

  # Fake claude binary: records argv + env into claude.log and exits 0 quickly,
  # leaving a PID that's alive just long enough to be sampled.
  cat > "${SCRATCH}/bin/claude" <<'EOF'
#!/usr/bin/env bash
{
  echo "pid=$$"
  echo "cwd=$(pwd)"
  echo "ORCH_DIR=${CATALYST_ORCHESTRATOR_DIR:-}"
  echo "ORCH_ID=${CATALYST_ORCHESTRATOR_ID:-}"
  echo "args: $*"
} >> "$CLAUDE_LOG"
# Long-running placeholder so kill-0 succeeds for the test window.
sleep 30 &
disown $! 2>/dev/null || true
EOF
  chmod +x "${SCRATCH}/bin/claude"
  export CLAUDE_LOG="${SCRATCH}/claude.log"
  : > "$CLAUDE_LOG"
  export CATALYST_REVIVE_CLAUDE_BIN="${SCRATCH}/bin/claude"
}

scratch_teardown() {
  # Reap any sleepers the fake claude left behind.
  pkill -f "sleep 30" 2>/dev/null || true
  rm -rf "$SCRATCH"
  unset STATE_LOG CLAUDE_LOG CATALYST_STATE_SCRIPT CATALYST_REVIVE_CLAUDE_BIN
  unset SCRATCH ORCH_DIR WORKTREE_ROOT
}

# make_signal TICKET PID STATUS PHASE [EXTRA_JQ]
make_signal() {
  local ticket="$1" pid="$2" status="$3" phase="$4" extra="${5:-.}"
  local worktree="${WORKTREE_ROOT}/${ticket}"
  mkdir -p "$worktree"
  local updated
  updated=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n \
    --arg t "$ticket" --arg s "$status" --arg u "$updated" \
    --arg wt "$worktree" --arg wn "test-${ticket}" \
    --argjson p "$phase" --argjson pid "$pid" \
    '{ticket:$t, orchestrator:"test", workerName:$wn, status:$s, phase:$p,
      pid:$pid, worktreePath:$wt, startedAt:$u, updatedAt:$u,
      lastHeartbeat:$u}' \
    | jq "$extra" \
    > "${ORCH_DIR}/workers/${ticket}.json"
}

# write_stream_init TICKET SESSION_ID
write_stream_init() {
  local ticket="$1" sid="$2"
  cat > "${ORCH_DIR}/workers/output/${ticket}-stream.jsonl" <<EOF
{"type":"system","subtype":"init","session_id":"${sid}"}
EOF
}

run_revive() {
  "$REVIVE" --orch-dir "$ORCH_DIR" --orch-id "demo" "$@"
}

# ─── Test cases ───────────────────────────────────────────────────────────────

echo "test: alive worker with fresh heartbeat is left untouched"
scratch_setup
ALIVE_PID=$$
make_signal "T-1" "$ALIVE_PID" "implementing" 3
write_stream_init "T-1" "sess-alive"
run_revive > "${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/T-1.json")
REVIVE_COUNT=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/T-1.json")
[ "$STATUS" = "implementing" ] && pass "status unchanged" || fail "status unchanged" "got: $STATUS"
[ "$REVIVE_COUNT" = "0" ] && pass "reviveCount unchanged" || fail "reviveCount unchanged" "got: $REVIVE_COUNT"
[ ! -s "$CLAUDE_LOG" ] && pass "claude not invoked" || fail "claude not invoked" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test: dead worker is revived via stream session_id"
scratch_setup
make_signal "T-2" "$DEAD_PID" "pr-created" 5
write_stream_init "T-2" "sess-resume-abc"
run_revive > "${SCRATCH}/out" 2>&1
REVIVE_COUNT=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/T-2.json")
NEW_PID=$(jq -r '.pid' "${ORCH_DIR}/workers/T-2.json")
REVIVED_SID=$(jq -r '.revivedFromSessionId // ""' "${ORCH_DIR}/workers/T-2.json")
[ "$REVIVE_COUNT" = "1" ] && pass "reviveCount bumped" || fail "reviveCount bumped" "got: $REVIVE_COUNT"
[ "$NEW_PID" != "$DEAD_PID" ] && pass "pid replaced" || fail "pid replaced" "got: $NEW_PID"
[ "$REVIVED_SID" = "sess-resume-abc" ] && pass "revived session tracked" || fail "revived session tracked" "got: $REVIVED_SID"
grep -q -- "--resume sess-resume-abc" "$CLAUDE_LOG" && pass "claude launched with --resume" || fail "claude launched with --resume" "log: $(cat "$CLAUDE_LOG")"
grep -q "ORCH_DIR=${ORCH_DIR}" "$CLAUDE_LOG" && pass "CATALYST_ORCHESTRATOR_DIR forwarded" || fail "CATALYST_ORCHESTRATOR_DIR forwarded" "log: $(cat "$CLAUDE_LOG")"
grep -q "ORCH_ID=demo" "$CLAUDE_LOG" && pass "CATALYST_ORCHESTRATOR_ID forwarded" || fail "CATALYST_ORCHESTRATOR_ID forwarded" "log: $(cat "$CLAUDE_LOG")"
grep -q "worker-revived" "$STATE_LOG" && pass "revive event emitted" || fail "revive event emitted" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test: worker in terminal state is skipped"
scratch_setup
for TS in done failed stalled merged; do
  make_signal "TERM-${TS}" "$DEAD_PID" "$TS" 5
  write_stream_init "TERM-${TS}" "sess-${TS}"
done
run_revive > "${SCRATCH}/out" 2>&1
for TS in done failed stalled merged; do
  GOT=$(jq -r '.status' "${ORCH_DIR}/workers/TERM-${TS}.json")
  RC=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/TERM-${TS}.json")
  [ "$GOT" = "$TS" ] && pass "${TS}: status unchanged" || fail "${TS}: status unchanged" "got: $GOT"
  [ "$RC" = "0" ] && pass "${TS}: no revive" || fail "${TS}: no revive" "rc: $RC"
done
[ ! -s "$CLAUDE_LOG" ] && pass "terminal: claude not invoked" || fail "terminal: claude not invoked"
scratch_teardown

echo "test: revive budget exhausted → stalled + attention"
scratch_setup
make_signal "T-3" "$DEAD_PID" "merging" 5 '.reviveCount = 2'
write_stream_init "T-3" "sess-exhausted"
run_revive --max-revives 2 > "${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/T-3.json")
REASON=$(jq -r '.attentionReason // ""' "${ORCH_DIR}/workers/T-3.json")
[ "$STATUS" = "stalled" ] && pass "status → stalled when budget exhausted" || fail "status → stalled" "got: $STATUS"
[ "$REASON" = "revive-budget-exhausted" ] && pass "attentionReason set" || fail "attentionReason set" "got: $REASON"
grep -q "attention demo revive-budget-exhausted T-3" "$STATE_LOG" && pass "attention raised" || fail "attention raised" "log: $(cat "$STATE_LOG")"
[ ! -s "$CLAUDE_LOG" ] && pass "claude not invoked after budget exhausted" || fail "claude not invoked after budget exhausted"
scratch_teardown

echo "test: stale heartbeat on live PID triggers revive"
scratch_setup
ALIVE_PID=$$
make_signal "T-4" "$ALIVE_PID" "implementing" 3
write_stream_init "T-4" "sess-stale"
# Rewrite lastHeartbeat & updatedAt to 30 minutes ago.
OLD_TS=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
jq --arg ts "$OLD_TS" '.updatedAt = $ts | .lastHeartbeat = $ts' \
  "${ORCH_DIR}/workers/T-4.json" > "${ORCH_DIR}/workers/T-4.json.tmp" \
  && mv "${ORCH_DIR}/workers/T-4.json.tmp" "${ORCH_DIR}/workers/T-4.json"
run_revive --stale-heartbeat-seconds 900 > "${SCRATCH}/out" 2>&1
REVIVE_COUNT=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/T-4.json")
[ "$REVIVE_COUNT" = "1" ] && pass "stale heartbeat triggers revive" || fail "stale heartbeat triggers revive" "got: $REVIVE_COUNT"
grep -q -- "--resume sess-stale" "$CLAUDE_LOG" && pass "claude launched for stale heartbeat" || fail "claude launched for stale heartbeat"
scratch_teardown

echo "test: dry-run makes no state changes"
scratch_setup
make_signal "T-5" "$DEAD_PID" "implementing" 3
write_stream_init "T-5" "sess-dry"
run_revive --dry-run > "${SCRATCH}/out" 2>&1
REVIVE_COUNT=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/T-5.json")
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/T-5.json")
[ "$REVIVE_COUNT" = "0" ] && pass "dry-run: reviveCount unchanged" || fail "dry-run: reviveCount unchanged" "got: $REVIVE_COUNT"
[ "$STATUS" = "implementing" ] && pass "dry-run: status unchanged" || fail "dry-run: status unchanged" "got: $STATUS"
[ ! -s "$CLAUDE_LOG" ] && pass "dry-run: claude not invoked" || fail "dry-run: claude not invoked"
[ ! -s "$STATE_LOG" ] && pass "dry-run: state script not invoked" || fail "dry-run: state script not invoked"
scratch_teardown

echo "test: missing session_id → stalled with attention"
scratch_setup
make_signal "T-6" "$DEAD_PID" "implementing" 3
# No stream file written — no session_id anywhere.
run_revive > "${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/T-6.json")
REASON=$(jq -r '.attentionReason // ""' "${ORCH_DIR}/workers/T-6.json")
[ "$STATUS" = "stalled" ] && pass "no session_id → stalled" || fail "no session_id → stalled" "got: $STATUS"
[ "$REASON" = "no-session-id" ] && pass "attentionReason = no-session-id" || fail "attentionReason = no-session-id" "got: $REASON"
grep -q "attention demo no-session-id T-6" "$STATE_LOG" && pass "no-session-id attention raised" || fail "no-session-id attention raised"
[ ! -s "$CLAUDE_LOG" ] && pass "claude not invoked when session_id missing" || fail "claude not invoked when session_id missing"
scratch_teardown

echo "test: legacy output.json session_id fallback"
scratch_setup
make_signal "T-7" "$DEAD_PID" "merging" 5
# No stream file — only legacy output.json format.
echo '{"session_id":"sess-legacy-xyz"}' > "${ORCH_DIR}/workers/T-7-output.json"
run_revive > "${SCRATCH}/out" 2>&1
REVIVED_SID=$(jq -r '.revivedFromSessionId // ""' "${ORCH_DIR}/workers/T-7.json")
[ "$REVIVED_SID" = "sess-legacy-xyz" ] && pass "legacy output.json session_id used" || fail "legacy output.json session_id used" "got: $REVIVED_SID"
grep -q -- "--resume sess-legacy-xyz" "$CLAUDE_LOG" && pass "claude launched with legacy session_id" || fail "claude launched with legacy session_id"
scratch_teardown

echo "test: summary JSON has expected shape"
scratch_setup
ALIVE_PID=$$
make_signal "S-alive" "$ALIVE_PID" "implementing" 3
make_signal "S-dead" "$DEAD_PID" "implementing" 3
write_stream_init "S-alive" "sess-s-alive"
write_stream_init "S-dead" "sess-s-dead"
OUT=$(run_revive)
CHECKED=$(echo "$OUT" | jq -r '.checked')
REVIVED=$(echo "$OUT" | jq -r '.revived')
[ "$CHECKED" = "2" ] && pass "summary.checked = 2" || fail "summary.checked" "got: $CHECKED"
[ "$REVIVED" = "1" ] && pass "summary.revived = 1" || fail "summary.revived" "got: $REVIVED"
scratch_teardown

# ─── CTL-62: API stream idle timeout detection ───────────────────────────────

# write_stream_api_error TICKET SESSION_ID ERROR_UUID [MESSAGE]
# Appends an init event, one assistant turn, and a final `result` event with
# is_error=true + an api_error_status that mentions a stream idle timeout.
write_stream_api_error() {
  local ticket="$1" sid="$2" err_uuid="$3"
  local msg="${4:-API Error: Stream idle timeout - partial response received}"
  local stream="${ORCH_DIR}/workers/output/${ticket}-stream.jsonl"
  mkdir -p "$(dirname "$stream")"
  {
    printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$sid"
    printf '{"type":"assistant","session_id":"%s","uuid":"turn-1"}\n' "$sid"
    printf '{"type":"result","subtype":"error","is_error":true,"api_error_status":"%s","session_id":"%s","uuid":"%s"}\n' \
      "$msg" "$sid" "$err_uuid"
  } > "$stream"
}

echo "test: API stream idle timeout on live PID triggers revive"
scratch_setup
ALIVE_PID=$$
make_signal "IDLE-1" "$ALIVE_PID" "implementing" 3
write_stream_api_error "IDLE-1" "sess-idle-1" "err-uuid-1"
run_revive > "${SCRATCH}/out" 2>&1
REVIVE_COUNT=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/IDLE-1.json")
REASON=$(jq -r '.lastReviveReason // ""' "${ORCH_DIR}/workers/IDLE-1.json")
RECORDED_UUID=$(jq -r '.lastApiErrorUuid // ""' "${ORCH_DIR}/workers/IDLE-1.json")
[ "$REVIVE_COUNT" = "1" ] && pass "api-idle: revived despite live PID + fresh heartbeat" \
  || fail "api-idle: revived despite live PID + fresh heartbeat" "rc: $REVIVE_COUNT"
[ "$REASON" = "api-stream-idle-timeout" ] && pass "api-idle: lastReviveReason recorded" \
  || fail "api-idle: lastReviveReason recorded" "got: $REASON"
[ "$RECORDED_UUID" = "err-uuid-1" ] && pass "api-idle: lastApiErrorUuid recorded" \
  || fail "api-idle: lastApiErrorUuid recorded" "got: $RECORDED_UUID"
grep -q "worker-revived" "$STATE_LOG" && pass "api-idle: revive event emitted" \
  || fail "api-idle: revive event emitted" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test: same API error uuid is NOT re-revived on a second pass"
scratch_setup
ALIVE_PID=$$
make_signal "IDLE-2" "$ALIVE_PID" "implementing" 3
write_stream_api_error "IDLE-2" "sess-idle-2" "err-uuid-2"
# Simulate post-first-revive state directly: live PID + fresh heartbeat +
# lastApiErrorUuid already recorded for this error event. Running revive now
# must NOT trigger another revive, because the error has already been handled.
jq --arg uuid "err-uuid-2" \
   --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '.lastApiErrorUuid = $uuid
    | .reviveCount = 1
    | .lastReviveReason = "api-stream-idle-timeout"
    | .lastHeartbeat = $ts
    | .updatedAt = $ts' \
  "${ORCH_DIR}/workers/IDLE-2.json" > "${ORCH_DIR}/workers/IDLE-2.json.tmp" \
  && mv "${ORCH_DIR}/workers/IDLE-2.json.tmp" "${ORCH_DIR}/workers/IDLE-2.json"
run_revive > "${SCRATCH}/out" 2>&1
SECOND_RC=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/IDLE-2.json")
[ "$SECOND_RC" = "1" ] && pass "api-idle-dedup: same uuid not re-revived" \
  || fail "api-idle-dedup: same uuid not re-revived" "rc: $SECOND_RC"
[ ! -s "$CLAUDE_LOG" ] && pass "api-idle-dedup: claude not invoked" \
  || fail "api-idle-dedup: claude not invoked" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test: new API error uuid after dedup state DOES trigger revive"
scratch_setup
ALIVE_PID=$$
make_signal "IDLE-3" "$ALIVE_PID" "implementing" 3
# Signal already saw err-uuid-old, but the stream now shows a NEW error event.
write_stream_api_error "IDLE-3" "sess-idle-3" "err-uuid-new"
jq --arg uuid "err-uuid-old" \
   --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '.lastApiErrorUuid = $uuid
    | .reviveCount = 1
    | .lastHeartbeat = $ts
    | .updatedAt = $ts' \
  "${ORCH_DIR}/workers/IDLE-3.json" > "${ORCH_DIR}/workers/IDLE-3.json.tmp" \
  && mv "${ORCH_DIR}/workers/IDLE-3.json.tmp" "${ORCH_DIR}/workers/IDLE-3.json"
run_revive > "${SCRATCH}/out" 2>&1
RC=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/IDLE-3.json")
RECORDED_UUID=$(jq -r '.lastApiErrorUuid // ""' "${ORCH_DIR}/workers/IDLE-3.json")
[ "$RC" = "2" ] && pass "api-idle-new-uuid: fresh error re-triggers revive" \
  || fail "api-idle-new-uuid: fresh error re-triggers revive" "rc: $RC"
[ "$RECORDED_UUID" = "err-uuid-new" ] && pass "api-idle-new-uuid: lastApiErrorUuid updated" \
  || fail "api-idle-new-uuid: lastApiErrorUuid updated" "got: $RECORDED_UUID"
scratch_teardown

echo "test: lastReviveReason = pid-dead for dead-PID revives"
scratch_setup
make_signal "REASON-DEAD" "$DEAD_PID" "implementing" 3
write_stream_init "REASON-DEAD" "sess-reason-dead"
run_revive > "${SCRATCH}/out" 2>&1
REASON=$(jq -r '.lastReviveReason // ""' "${ORCH_DIR}/workers/REASON-DEAD.json")
[ "$REASON" = "pid-dead" ] && pass "reason: pid-dead recorded" \
  || fail "reason: pid-dead recorded" "got: $REASON"
scratch_teardown

echo "test: lastReviveReason = heartbeat-stale for stale-heartbeat revives"
scratch_setup
ALIVE_PID=$$
make_signal "REASON-STALE" "$ALIVE_PID" "implementing" 3
write_stream_init "REASON-STALE" "sess-reason-stale"
OLD_TS=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
jq --arg ts "$OLD_TS" '.updatedAt = $ts | .lastHeartbeat = $ts' \
  "${ORCH_DIR}/workers/REASON-STALE.json" > "${ORCH_DIR}/workers/REASON-STALE.json.tmp" \
  && mv "${ORCH_DIR}/workers/REASON-STALE.json.tmp" "${ORCH_DIR}/workers/REASON-STALE.json"
run_revive --stale-heartbeat-seconds 900 > "${SCRATCH}/out" 2>&1
REASON=$(jq -r '.lastReviveReason // ""' "${ORCH_DIR}/workers/REASON-STALE.json")
[ "$REASON" = "heartbeat-stale" ] && pass "reason: heartbeat-stale recorded" \
  || fail "reason: heartbeat-stale recorded" "got: $REASON"
scratch_teardown

echo "test: dry-run with API error detection does not mutate signal"
scratch_setup
ALIVE_PID=$$
make_signal "IDLE-DRY" "$ALIVE_PID" "implementing" 3
write_stream_api_error "IDLE-DRY" "sess-idle-dry" "err-uuid-dry"
run_revive --dry-run > "${SCRATCH}/out" 2>&1
RC=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/IDLE-DRY.json")
UUID_RECORDED=$(jq -r '.lastApiErrorUuid // ""' "${ORCH_DIR}/workers/IDLE-DRY.json")
[ "$RC" = "0" ] && pass "api-idle-dry: reviveCount unchanged" \
  || fail "api-idle-dry: reviveCount unchanged" "rc: $RC"
[ "$UUID_RECORDED" = "" ] && pass "api-idle-dry: lastApiErrorUuid not written" \
  || fail "api-idle-dry: lastApiErrorUuid not written" "got: $UUID_RECORDED"
[ ! -s "$CLAUDE_LOG" ] && pass "api-idle-dry: claude not invoked" \
  || fail "api-idle-dry: claude not invoked"
scratch_teardown

echo "test: non-API is_error=true (e.g. tool error) does NOT trigger revive"
scratch_setup
ALIVE_PID=$$
make_signal "TOOL-ERR" "$ALIVE_PID" "implementing" 3
# Write a result event that is_error=true but has NO api_error_status and no
# stream-idle-timeout marker — e.g. a test failure that ended the run cleanly.
stream="${ORCH_DIR}/workers/output/TOOL-ERR-stream.jsonl"
mkdir -p "$(dirname "$stream")"
{
  printf '{"type":"system","subtype":"init","session_id":"sess-tool-err"}\n'
  printf '{"type":"result","subtype":"error","is_error":true,"api_error_status":null,"result":"Tests failed","session_id":"sess-tool-err","uuid":"tool-err-uuid"}\n'
} > "$stream"
run_revive > "${SCRATCH}/out" 2>&1
RC=$(jq -r '.reviveCount // 0' "${ORCH_DIR}/workers/TOOL-ERR.json")
[ "$RC" = "0" ] && pass "tool-error: non-API is_error does not revive" \
  || fail "tool-error: non-API is_error does not revive" "rc: $RC"
scratch_teardown

# ─── Results ──────────────────────────────────────────────────────────────────

echo ""
echo "Passes: $PASSES  Failures: $FAILURES"
[ $FAILURES -eq 0 ] && exit 0 || exit 1
