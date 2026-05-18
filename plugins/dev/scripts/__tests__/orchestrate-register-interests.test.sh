#!/usr/bin/env bash
# Shell tests for orchestrate-register-interests (CTL-491).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-register-interests.test.sh
#
# The helper emits the four broker filter.register events the orchestrator
# needs (pr_lifecycle, ticket_lifecycle, comms_lifecycle, phase_lifecycle)
# and is invoked both at Phase 2.5 (pre-dispatch) and Phase 4 (refresh).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
REGISTER="${REPO_ROOT}/plugins/dev/scripts/orchestrate-register-interests.sh"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# Scratch setup: temp ORCH_DIR + fake catalyst-state.sh that logs argv.
scratch_setup() {
  SCRATCH="$(mktemp -d)"
  ORCH_DIR="${SCRATCH}/orch"
  mkdir -p "${ORCH_DIR}/workers" "${SCRATCH}/bin"

  cat > "${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
# Fake catalyst-state.sh — for `event <json>` calls, append the json to a log.
if [ "${1:-}" = "event" ]; then
  shift
  printf '%s\n' "$@" >> "$STATE_LOG"
fi
EOF
  chmod +x "${SCRATCH}/bin/catalyst-state.sh"
  export STATE_LOG="${SCRATCH}/state.log"
  : > "$STATE_LOG"
  export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"

  # Fake catalyst-broker — claim it is up so the helper proceeds.
  cat > "${SCRATCH}/bin/catalyst-broker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${SCRATCH}/bin/catalyst-broker"
  # Fake gh (used for repo full name lookup)
  cat > "${SCRATCH}/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "owner/repo"
EOF
  chmod +x "${SCRATCH}/bin/gh"
  export PATH="${SCRATCH}/bin:$PATH"

  # Minimal config file (defaults to phase-agents — most tests use this)
  CONFIG_FILE="${SCRATCH}/config.json"
  cat > "$CONFIG_FILE" <<'EOF'
{"catalyst":{"orchestration":{"dispatchMode":"phase-agents"}}}
EOF
}

scratch_teardown() {
  rm -rf "$SCRATCH"
  unset SCRATCH ORCH_DIR STATE_LOG CONFIG_FILE
  unset CATALYST_STATE_SCRIPT
}

# write_worker_signal TICKET [PR_NUMBER]
write_worker_signal() {
  local t="$1" pr="${2:-null}"
  local file="${ORCH_DIR}/workers/${t}.json"
  if [ "$pr" = "null" ]; then
    jq -nc --arg t "$t" '{ticket:$t, status:"running", pr:null}' > "$file"
  else
    jq -nc --arg t "$t" --argjson pr "$pr" '{ticket:$t, status:"running", pr:{number:$pr, baseRefName:"main"}}' > "$file"
  fi
}

run_register() {
  "$REGISTER" --orch-dir "$ORCH_DIR" --orch-id "demo" --config "$CONFIG_FILE" "$@"
}

# Count emitted filter.register events by interest_type.
count_events_of_type() {
  jq -r '.detail.interest_type' "$STATE_LOG" 2>/dev/null \
    | grep -c "^${1}$" || true
}

# ─── Phase 1 tests (1-8) — basic registration semantics ─────────────────────

echo "test 1: phase-agents mode with 2 tickets emits 3 deterministic + 2 phase_lifecycle = 5 events"
scratch_setup
write_worker_signal "CTL-491"
write_worker_signal "CTL-492"
run_register >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0" || fail "exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
TOTAL=$(wc -l < "$STATE_LOG" | tr -d ' ')
[ "$TOTAL" = "5" ] && pass "5 total events" || fail "5 total events" "got $TOTAL events: $(cat "$STATE_LOG")"
PR_COUNT=$(count_events_of_type "pr_lifecycle")
TICKET_COUNT=$(count_events_of_type "ticket_lifecycle")
COMMS_COUNT=$(count_events_of_type "comms_lifecycle")
PHASE_COUNT=$(count_events_of_type "phase_lifecycle")
[ "$PR_COUNT" = "1" ] && pass "1 pr_lifecycle event" || fail "1 pr_lifecycle event" "got $PR_COUNT"
[ "$TICKET_COUNT" = "1" ] && pass "1 ticket_lifecycle event" || fail "1 ticket_lifecycle event" "got $TICKET_COUNT"
[ "$COMMS_COUNT" = "1" ] && pass "1 comms_lifecycle event" || fail "1 comms_lifecycle event" "got $COMMS_COUNT"
[ "$PHASE_COUNT" = "2" ] && pass "2 phase_lifecycle events" || fail "2 phase_lifecycle events" "got $PHASE_COUNT"
scratch_teardown

echo "test 2: oneshot-legacy mode emits 3 deterministic interests, no phase_lifecycle"
scratch_setup
cat > "$CONFIG_FILE" <<'EOF'
{"catalyst":{"orchestration":{"dispatchMode":"oneshot-legacy"}}}
EOF
write_worker_signal "CTL-491"
write_worker_signal "CTL-492"
run_register >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0 in oneshot-legacy" || fail "exit 0 in oneshot-legacy" "rc=$RC"
TOTAL=$(wc -l < "$STATE_LOG" | tr -d ' ')
[ "$TOTAL" = "3" ] && pass "3 total events (no phase_lifecycle)" || fail "3 total events (no phase_lifecycle)" "got $TOTAL events: $(cat "$STATE_LOG")"
PHASE_COUNT=$(count_events_of_type "phase_lifecycle")
[ "$PHASE_COUNT" = "0" ] && pass "0 phase_lifecycle events" || fail "0 phase_lifecycle events" "got $PHASE_COUNT"
scratch_teardown

echo "test 3: each phase_lifecycle event carries the 9 canonical phase names"
scratch_setup
write_worker_signal "CTL-491"
run_register >/dev/null 2>"${SCRATCH}/err"
PHASE_NAMES_JSON=$(jq -c 'select(.detail.interest_type == "phase_lifecycle") | .detail.phase_names' "$STATE_LOG")
EXPECTED='["triage","research","plan","implement","verify","review","pr","monitor-merge","monitor-deploy"]'
[ "$PHASE_NAMES_JSON" = "$EXPECTED" ] && pass "9 canonical phase names" || fail "9 canonical phase names" "got $PHASE_NAMES_JSON"
scratch_teardown

echo "test 4: each event carries notify_event = filter.wake.<ORCH_NAME>"
scratch_setup
write_worker_signal "CTL-491"
run_register >/dev/null 2>"${SCRATCH}/err"
ALL_NOTIFY=$(jq -r '.detail.notify_event' "$STATE_LOG" | sort -u)
[ "$ALL_NOTIFY" = "filter.wake.demo" ] && pass "all events carry filter.wake.demo" || fail "all events carry filter.wake.demo" "got: $ALL_NOTIFY"
scratch_teardown

echo "test 5: --refresh without prior .last-registration.json re-emits all interests"
# (When the baseline file is missing, --refresh has nothing to diff against and
# falls back to initial-style registration. This is the Phase 1 contract; the
# Phase 3 diff semantics kick in only when the baseline exists.)
scratch_setup
write_worker_signal "CTL-491"
# Note: no initial run, so .last-registration.json doesn't exist yet.
run_register --refresh >/dev/null 2>"${SCRATCH}/err"
TOTAL=$(wc -l < "$STATE_LOG" | tr -d ' ')
[ "$TOTAL" = "4" ] && pass "refresh w/o baseline emits all 4 (3 + 1 phase_lifecycle)" \
  || fail "refresh w/o baseline emits all 4" "got $TOTAL events: $(cat "$STATE_LOG")"
scratch_teardown

echo "test 6: missing --orch-id exits non-zero with clear error"
scratch_setup
OUT=$("$REGISTER" --orch-dir "$ORCH_DIR" --config "$CONFIG_FILE" 2>&1 >/dev/null)
RC=$?
[ "$RC" != "0" ] && pass "non-zero exit on missing --orch-id" || fail "non-zero exit on missing --orch-id" "rc=$RC"
echo "$OUT" | grep -qi "orch-id" && pass "stderr mentions orch-id" || fail "stderr mentions orch-id" "got: $OUT"
scratch_teardown

echo "test 7: empty workers/ dir → 0 phase_lifecycle events but emits 3 deterministic"
scratch_setup
# No worker signals written.
run_register >/dev/null 2>"${SCRATCH}/err"
RC=$?
[ "$RC" = "0" ] && pass "exit 0 with empty workers" || fail "exit 0 with empty workers" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
TOTAL=$(wc -l < "$STATE_LOG" | tr -d ' ')
[ "$TOTAL" = "3" ] && pass "3 deterministic events when workers/ empty" || fail "3 deterministic events when workers/ empty" "got $TOTAL"
PHASE_COUNT=$(count_events_of_type "phase_lifecycle")
[ "$PHASE_COUNT" = "0" ] && pass "0 phase_lifecycle when workers/ empty" || fail "0 phase_lifecycle when workers/ empty" "got $PHASE_COUNT"
scratch_teardown

echo "test 8: stamps .last-registration.json with tickets + timestamp"
scratch_setup
write_worker_signal "CTL-491"
write_worker_signal "CTL-492"
run_register >/dev/null 2>"${SCRATCH}/err"
LAST_FILE="${ORCH_DIR}/.last-registration.json"
[ -f "$LAST_FILE" ] && pass ".last-registration.json exists" || fail ".last-registration.json exists" "missing"
TICKETS=$(jq -c '.tickets | sort' "$LAST_FILE" 2>/dev/null || echo '[]')
[ "$TICKETS" = '["CTL-491","CTL-492"]' ] && pass "tickets recorded sorted" || fail "tickets recorded sorted" "got: $TICKETS"
REG_AT=$(jq -r '.registeredAt // ""' "$LAST_FILE" 2>/dev/null || echo "")
[ -n "$REG_AT" ] && pass "registeredAt non-empty" || fail "registeredAt non-empty" "got: '$REG_AT'"
scratch_teardown

# ─── Phase 3 tests (12-15) — --refresh diff semantics ─────────────────────
# These tests exercise the --refresh path's diff logic: emit nothing if
# nothing changed; emit only new phase_lifecycles when wave 2 dispatches new
# tickets; respect the dispatchMode gate.

echo "test 12: --refresh with [CTL-491] → [CTL-491, CTL-494] re-emits 3 deterministic + 1 phase_lifecycle for CTL-494 only"
scratch_setup
write_worker_signal "CTL-491"
run_register >/dev/null 2>"${SCRATCH}/err"  # initial: 4 events (3 + 1 phase_lifecycle CTL-491)
: > "$STATE_LOG"
write_worker_signal "CTL-494"  # add wave 2 ticket
run_register --refresh >/dev/null 2>"${SCRATCH}/err"
TOTAL=$(wc -l < "$STATE_LOG" | tr -d ' ')
[ "$TOTAL" = "4" ] && pass "refresh emits 4 events (3 deterministic + 1 new phase_lifecycle)" \
  || fail "refresh emits 4 events" "got $TOTAL events: $(cat "$STATE_LOG")"
NEW_PHASE_TICKET=$(jq -r 'select(.detail.interest_type == "phase_lifecycle") | .detail.ticket' "$STATE_LOG" | sort -u)
[ "$NEW_PHASE_TICKET" = "CTL-494" ] && pass "only new ticket CTL-494 gets phase_lifecycle" \
  || fail "only new ticket CTL-494 gets phase_lifecycle" "got: $NEW_PHASE_TICKET"
scratch_teardown

echo "test 13: --refresh with no change in PR set or ticket set → 0 events (no-op)"
scratch_setup
write_worker_signal "CTL-491" 100
run_register >/dev/null 2>"${SCRATCH}/err"  # initial registration
: > "$STATE_LOG"
run_register --refresh >/dev/null 2>"${SCRATCH}/err"
TOTAL=$(wc -l < "$STATE_LOG" | tr -d ' ')
[ "$TOTAL" = "0" ] && pass "no-op refresh emits 0 events" \
  || fail "no-op refresh emits 0 events" "got $TOTAL events: $(cat "$STATE_LOG")"
scratch_teardown

echo "test 14: --refresh after wave 2 dispatch updates .last-registration.json"
scratch_setup
write_worker_signal "CTL-491"
run_register >/dev/null 2>"${SCRATCH}/err"
write_worker_signal "CTL-494"
run_register --refresh >/dev/null 2>"${SCRATCH}/err"
LAST_FILE="${ORCH_DIR}/.last-registration.json"
TICKETS=$(jq -c '.tickets | sort' "$LAST_FILE" 2>/dev/null || echo '[]')
[ "$TICKETS" = '["CTL-491","CTL-494"]' ] && pass "post-refresh baseline has both tickets" \
  || fail "post-refresh baseline has both tickets" "got: $TICKETS"
scratch_teardown

echo "test 15: --refresh in oneshot-legacy mode never emits phase_lifecycle (mode gate)"
scratch_setup
cat > "$CONFIG_FILE" <<'EOF'
{"catalyst":{"orchestration":{"dispatchMode":"oneshot-legacy"}}}
EOF
write_worker_signal "CTL-491"
run_register >/dev/null 2>"${SCRATCH}/err"
: > "$STATE_LOG"
write_worker_signal "CTL-494"
run_register --refresh >/dev/null 2>"${SCRATCH}/err"
PHASE_COUNT=$(count_events_of_type "phase_lifecycle")
[ "$PHASE_COUNT" = "0" ] && pass "oneshot-legacy refresh emits 0 phase_lifecycle" \
  || fail "oneshot-legacy refresh emits 0 phase_lifecycle" "got $PHASE_COUNT events: $(cat "$STATE_LOG")"
scratch_teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
