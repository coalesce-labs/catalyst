#!/usr/bin/env bash
# Shell tests for orchestrate-healthcheck (CTL-87).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-healthcheck.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HEALTHCHECK="${REPO_ROOT}/plugins/dev/scripts/orchestrate-healthcheck"

FAILURES=0
PASSES=0

scratch_setup() {
  SCRATCH="$(mktemp -d)"
  ORCH_DIR="${SCRATCH}/orch"
  mkdir -p "${ORCH_DIR}/workers" "${SCRATCH}/bin"

  # Fake state script: appends argv to state.log so tests can assert.
  cat > "${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/catalyst-state.sh"
  export STATE_LOG="${SCRATCH}/state.log"
  : > "$STATE_LOG"
  export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"
}

scratch_teardown() {
  rm -rf "$SCRATCH"
  unset STATE_LOG CATALYST_STATE_SCRIPT SCRATCH ORCH_DIR
}

make_signal() {
  # Usage: make_signal TICKET PID STATUS PHASE
  local ticket="$1" pid="$2" status="$3" phase="$4"
  jq -n \
    --arg t "$ticket" --arg s "$status" \
    --argjson p "$phase" \
    --argjson pid "$pid" \
    '{ticket:$t, status:$s, phase:$p, pid:$pid, updatedAt:"2026-04-16T00:00:00Z"}' \
    > "${ORCH_DIR}/workers/${ticket}.json"
}

make_signal_no_pid() {
  local ticket="$1" status="$2" phase="$3"
  jq -n \
    --arg t "$ticket" --arg s "$status" --argjson p "$phase" \
    '{ticket:$t, status:$s, phase:$p, pid:null, updatedAt:"2026-04-16T00:00:00Z"}' \
    > "${ORCH_DIR}/workers/${ticket}.json"
}

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# A PID guaranteed to be dead.
DEAD_PID=99999999
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID+1)); done

# ---

echo "test: alive worker is left untouched"
scratch_setup
ALIVE_PID=$$   # this test process itself
make_signal "PROJ-1" "$ALIVE_PID" "dispatched" 0
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 > "${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-1.json")
[ "$STATUS" = "dispatched" ] && pass "status unchanged" || fail "status unchanged" "got: $STATUS"
[ ! -s "$STATE_LOG" ] && pass "no state-script calls" || fail "no state-script calls" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test: dead worker is flagged"
scratch_setup
make_signal "PROJ-2" "$DEAD_PID" "dispatched" 0
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 > "${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-2.json")
REASON=$(jq -r '.failureReason' "${ORCH_DIR}/workers/PROJ-2.json")
[ "$STATUS" = "failed" ] && pass "status transitioned to failed" || fail "status transitioned to failed" "got: $STATUS"
[ "$REASON" = "launch-failure" ] && pass "failureReason set" || fail "failureReason set" "got: $REASON"
grep -q "attention demo launch-failure PROJ-2" "$STATE_LOG" \
  && pass "attention raised" || fail "attention raised" "log: $(cat "$STATE_LOG")"
grep -q "worker-launch-failed" "$STATE_LOG" \
  && pass "launch-failed event emitted" || fail "launch-failed event emitted" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test: worker past phase 0 is skipped"
scratch_setup
make_signal "PROJ-3" "$DEAD_PID" "implementing" 3
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 > "${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-3.json")
[ "$STATUS" = "implementing" ] && pass "advanced worker untouched" || fail "advanced worker untouched" "got: $STATUS"
[ ! -s "$STATE_LOG" ] && pass "no state-script calls for advanced worker" || fail "no state-script calls for advanced worker"
scratch_teardown

echo "test: worker with null pid is skipped safely"
scratch_setup
make_signal_no_pid "PROJ-4" "dispatched" 0
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 > "${SCRATCH}/out" 2>&1
RC=$?
[ $RC -eq 0 ] && pass "null pid exits zero" || fail "null pid exits zero" "rc=$RC"
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-4.json")
[ "$STATUS" = "dispatched" ] && pass "null-pid worker untouched" || fail "null-pid worker untouched" "got: $STATUS"
scratch_teardown

echo "test: mixed wave — 2 alive + 1 dead, only dead one is flagged"
scratch_setup
make_signal "PROJ-A" "$$" "dispatched" 0
make_signal "PROJ-B" "$DEAD_PID" "dispatched" 0
make_signal "PROJ-C" "$$" "dispatched" 0
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 > "${SCRATCH}/out" 2>&1
SA=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-A.json")
SB=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-B.json")
SC=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-C.json")
[ "$SA" = "dispatched" ] && [ "$SC" = "dispatched" ] && pass "alive workers untouched" \
  || fail "alive workers untouched" "A=$SA C=$SC"
[ "$SB" = "failed" ] && pass "dead worker flagged" || fail "dead worker flagged" "B=$SB"
DEAD_COUNT=$(grep -c "attention demo launch-failure" "$STATE_LOG" || true)
[ "$DEAD_COUNT" = "1" ] && pass "exactly one attention call" || fail "exactly one attention call" "count=$DEAD_COUNT"
scratch_teardown

echo "test: --dry-run detects but does not mutate"
scratch_setup
make_signal "PROJ-5" "$DEAD_PID" "dispatched" 0
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 --dry-run > "${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-5.json")
[ "$STATUS" = "dispatched" ] && pass "dry-run leaves signal unchanged" || fail "dry-run leaves signal unchanged" "got: $STATUS"
[ ! -s "$STATE_LOG" ] && pass "dry-run makes no state-script calls" || fail "dry-run makes no state-script calls" "log: $(cat "$STATE_LOG")"
grep -q "PROJ-5" "${SCRATCH}/out" && pass "dry-run reports the dead worker" || fail "dry-run reports the dead worker" "out: $(cat "${SCRATCH}/out")"
scratch_teardown

echo "test: non-worker JSON files are ignored"
scratch_setup
make_signal "PROJ-6" "$DEAD_PID" "dispatched" 0
# Drop a non-signal JSON file shaped like something that could appear in workers/.
echo '{"somethingElse": true}' > "${ORCH_DIR}/workers/not-a-signal.json"
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 > "${SCRATCH}/out" 2>&1
RC=$?
[ $RC -eq 0 ] && pass "non-worker JSON does not crash" || fail "non-worker JSON does not crash" "rc=$RC; out: $(cat "${SCRATCH}/out")"
# Still flags the real dead worker.
SB=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-6.json")
[ "$SB" = "failed" ] && pass "real dead worker still flagged despite junk file" || fail "real dead worker still flagged despite junk file" "got: $SB"
scratch_teardown

echo "test: summary JSON on stdout"
scratch_setup
make_signal "PROJ-7" "$$" "dispatched" 0
make_signal "PROJ-8" "$DEAD_PID" "dispatched" 0
OUT=$("$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 2>/dev/null)
CHECKED=$(echo "$OUT" | jq -r '.checked' 2>/dev/null || echo "")
DEAD=$(echo "$OUT" | jq -r '.dead' 2>/dev/null || echo "")
[ "$CHECKED" = "2" ] && pass "summary.checked=2" || fail "summary.checked=2" "got: $CHECKED; out: $OUT"
[ "$DEAD" = "1" ] && pass "summary.dead=1" || fail "summary.dead=1" "got: $DEAD; out: $OUT"
scratch_teardown

echo
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
