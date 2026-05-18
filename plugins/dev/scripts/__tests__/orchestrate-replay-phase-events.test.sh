#!/usr/bin/env bash
# Shell tests for orchestrate-replay-phase-events (CTL-491).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-replay-phase-events.test.sh
#
# The replay helper is invoked on Phase 4 monitor entry. It reads
# state.json.race.startLineCursor + startEventsFile, scans the event log
# between that baseline and current EOF, and routes each
# phase.<name>.{complete,failed,turn-cap-exhausted}.<TICKET> event for
# in-orch tickets through orchestrate-phase-advance (complete) or
# orchestrate-revive (failed | turn-cap-exhausted).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
REPLAY="${REPO_ROOT}/plugins/dev/scripts/orchestrate-replay-phase-events.sh"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# Scratch setup: temp ORCH_DIR + temp events dir + fake advance/revive scripts.
scratch_setup() {
  SCRATCH="$(mktemp -d)"
  ORCH_DIR="${SCRATCH}/orch"
  EVENTS_DIR="${SCRATCH}/events"
  mkdir -p "${ORCH_DIR}/workers" "$EVENTS_DIR" "${SCRATCH}/bin"

  # Fake orchestrate-phase-advance — log argv to a file.
  cat > "${SCRATCH}/bin/orchestrate-phase-advance" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$ADVANCE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/orchestrate-phase-advance"
  export ADVANCE_LOG="${SCRATCH}/advance.log"
  : > "$ADVANCE_LOG"
  export CATALYST_PHASE_ADVANCE_BIN="${SCRATCH}/bin/orchestrate-phase-advance"

  # Fake orchestrate-revive — log argv to a file.
  cat > "${SCRATCH}/bin/orchestrate-revive" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$REVIVE_LOG"
EOF
  chmod +x "${SCRATCH}/bin/orchestrate-revive"
  export REVIVE_LOG="${SCRATCH}/revive.log"
  : > "$REVIVE_LOG"
  export CATALYST_REVIVE_BIN="${SCRATCH}/bin/orchestrate-revive"

  # Initial empty events file.
  CURRENT_MONTH=$(date -u +%Y-%m)
  EVENTS_FILE="${EVENTS_DIR}/${CURRENT_MONTH}.jsonl"
  : > "$EVENTS_FILE"
}

scratch_teardown() {
  rm -rf "$SCRATCH"
  unset SCRATCH ORCH_DIR EVENTS_DIR ADVANCE_LOG REVIVE_LOG EVENTS_FILE CURRENT_MONTH
  unset CATALYST_PHASE_ADVANCE_BIN CATALYST_REVIVE_BIN
}

write_worker() {
  local t="$1"
  jq -nc --arg t "$t" '{ticket:$t, status:"running"}' > "${ORCH_DIR}/workers/${t}.json"
}

# Emit a canonical-shaped event line for phase.<phase>.<status>.<ticket>.
emit_phase_event() {
  local phase="$1" status="$2" ticket="$3"
  local name="phase.${phase}.${status}.${ticket}"
  jq -nc \
    --arg name "$name" \
    --arg ticket "$ticket" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      "@timestamp": $ts,
      attributes: {"event.name": $name, "catalyst.ticket": $ticket}
    }' >> "$EVENTS_FILE"
}

# Write state.json with race baseline at current EOF of EVENTS_FILE.
write_state_with_baseline() {
  local cursor
  cursor=$(wc -l < "$EVENTS_FILE" | tr -d ' ')
  jq -nc \
    --argjson cursor "$cursor" \
    --arg file "$EVENTS_FILE" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{orchestrator:"demo", startedAt:$ts,
      race:{startLineCursor:$cursor, startEventsFile:$file}}' \
    > "${ORCH_DIR}/state.json"
}

run_replay() {
  "$REPLAY" --orch-dir "$ORCH_DIR" --orch-id "demo" "$@"
}

# ─── Test cases ───────────────────────────────────────────────────────────────

echo "test 1: empty race window (cursor == EOF) → exits 0 with no invocations"
scratch_setup
write_worker "CTL-491"
write_state_with_baseline  # cursor = 0, file empty
OUT=$(run_replay 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 on empty window" || fail "exit 0 on empty window" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
[ ! -s "$ADVANCE_LOG" ] && pass "phase-advance NOT invoked" || fail "phase-advance NOT invoked" "log: $(cat "$ADVANCE_LOG")"
[ ! -s "$REVIVE_LOG" ] && pass "revive NOT invoked" || fail "revive NOT invoked"
scratch_teardown

echo "test 2: phase.triage.complete.CTL-491 in window → invokes orchestrate-phase-advance once"
scratch_setup
write_worker "CTL-491"
write_state_with_baseline
emit_phase_event "triage" "complete" "CTL-491"
run_replay >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0" || fail "exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
INVOCATION_COUNT=$(wc -l < "$ADVANCE_LOG" | tr -d ' ')
[ "$INVOCATION_COUNT" = "1" ] && pass "phase-advance invoked once" || fail "phase-advance invoked once" "log: $(cat "$ADVANCE_LOG")"
grep -q -- "--completed-phase triage" "$ADVANCE_LOG" && pass "--completed-phase triage forwarded" || fail "--completed-phase triage" "log: $(cat "$ADVANCE_LOG")"
grep -q -- "--ticket CTL-491" "$ADVANCE_LOG" && pass "--ticket CTL-491 forwarded" || fail "--ticket CTL-491" "log: $(cat "$ADVANCE_LOG")"
[ ! -s "$REVIVE_LOG" ] && pass "revive NOT invoked for complete" || fail "revive NOT invoked for complete"
scratch_teardown

echo "test 3: phase.research.failed.CTL-492 in window → invokes orchestrate-revive once"
scratch_setup
write_worker "CTL-492"
write_state_with_baseline
emit_phase_event "research" "failed" "CTL-492"
run_replay >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0 for failed event" || fail "exit 0 for failed event" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
INVOCATION_COUNT=$(wc -l < "$REVIVE_LOG" | tr -d ' ')
[ "$INVOCATION_COUNT" = "1" ] && pass "revive invoked once" || fail "revive invoked once" "log: $(cat "$REVIVE_LOG")"
[ ! -s "$ADVANCE_LOG" ] && pass "phase-advance NOT invoked for failed" || fail "phase-advance NOT invoked for failed"
scratch_teardown

echo "test 4: phase.implement.turn-cap-exhausted.CTL-493 in window → invokes orchestrate-revive once"
scratch_setup
write_worker "CTL-493"
write_state_with_baseline
emit_phase_event "implement" "turn-cap-exhausted" "CTL-493"
run_replay >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0 for turn-cap-exhausted" || fail "exit 0 for turn-cap-exhausted" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
INVOCATION_COUNT=$(wc -l < "$REVIVE_LOG" | tr -d ' ')
[ "$INVOCATION_COUNT" = "1" ] && pass "revive invoked once (continuation path)" || fail "revive invoked once" "log: $(cat "$REVIVE_LOG")"
scratch_teardown

echo "test 5: phase.triage.complete.OUT-OF-ORCH-99 ticket not in workers/ → IGNORED"
scratch_setup
write_worker "CTL-491"
write_state_with_baseline
emit_phase_event "triage" "complete" "OUT-99"  # not in workers/
run_replay >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0 with cross-orchestrator event" || fail "exit 0 with cross-orchestrator event" "rc=$RC"
[ ! -s "$ADVANCE_LOG" ] && pass "phase-advance NOT invoked for foreign ticket" || fail "phase-advance NOT invoked for foreign ticket" "log: $(cat "$ADVANCE_LOG")"
scratch_teardown

echo "test 6: multiple events same ticket (complete then failed) replay in order"
scratch_setup
write_worker "CTL-491"
write_state_with_baseline
emit_phase_event "triage" "complete" "CTL-491"
emit_phase_event "research" "failed" "CTL-491"
run_replay >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0 multi-event" || fail "exit 0 multi-event" "rc=$RC"
ADV_COUNT=$(wc -l < "$ADVANCE_LOG" | tr -d ' ')
REV_COUNT=$(wc -l < "$REVIVE_LOG" | tr -d ' ')
[ "$ADV_COUNT" = "1" ] && pass "phase-advance invoked once (for complete)" || fail "phase-advance invoked once" "log: $(cat "$ADVANCE_LOG")"
[ "$REV_COUNT" = "1" ] && pass "revive invoked once (for failed)" || fail "revive invoked once" "log: $(cat "$REVIVE_LOG")"
scratch_teardown

echo "test 7: malformed JSON line in event log → skipped with warning, replay continues"
scratch_setup
write_worker "CTL-491"
write_state_with_baseline
echo "not valid json {" >> "$EVENTS_FILE"
emit_phase_event "triage" "complete" "CTL-491"
run_replay >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0 despite malformed line" || fail "exit 0 despite malformed line" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
ADV_COUNT=$(wc -l < "$ADVANCE_LOG" | tr -d ' ')
[ "$ADV_COUNT" = "1" ] && pass "valid event still processed" || fail "valid event still processed" "log: $(cat "$ADVANCE_LOG")"
scratch_teardown

echo "test 8: race.startLineCursor missing from state.json → exits non-zero with baseline-missing"
scratch_setup
write_worker "CTL-491"
# state.json without .race
jq -nc '{orchestrator:"demo"}' > "${ORCH_DIR}/state.json"
OUT=$(run_replay 2>&1)
RC=$?
[ "$RC" != "0" ] && pass "non-zero exit on missing baseline" || fail "non-zero exit on missing baseline" "rc=$RC out=$OUT"
echo "$OUT" | grep -qi "baseline" && pass "stderr mentions baseline" || fail "stderr mentions baseline" "got: $OUT"
scratch_teardown

echo "test 9: month rollover — baseline points to last month, current EOF is in new month"
scratch_setup
write_worker "CTL-491"
# Old month events file with 2 lines
OLD_FILE="${EVENTS_DIR}/2026-04.jsonl"
echo "noise" > "$OLD_FILE"
echo "noise2" >> "$OLD_FILE"
# Baseline at line 2 of old file (no events past it in old file)
jq -nc --arg file "$OLD_FILE" \
  '{orchestrator:"demo", race:{startLineCursor:2, startEventsFile:$file}}' \
  > "${ORCH_DIR}/state.json"
# Current month file with one new phase event
emit_phase_event "triage" "complete" "CTL-491"
# Override CATALYST_EVENTS_DIR so the helper resolves current-month correctly.
CATALYST_EVENTS_DIR="$EVENTS_DIR" run_replay >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0 across month rollover" || fail "exit 0 across month rollover" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
ADV_COUNT=$(wc -l < "$ADVANCE_LOG" | tr -d ' ')
[ "$ADV_COUNT" = "1" ] && pass "current month event processed" || fail "current month event processed" "log: $(cat "$ADVANCE_LOG")"
scratch_teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
