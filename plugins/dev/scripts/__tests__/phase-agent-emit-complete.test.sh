#!/usr/bin/env bash
# Tests for phase-agent-emit-complete (CTL-448 Initiative 1 Phase 2).
#
# Approach: redirect $CATALYST_DIR to a scratch tmpdir, run the script, then
# parse the emitted JSONL line from <tmp>/events/YYYY-MM.jsonl. The script
# emits the broker-routable phase.<name>.{complete,failed}.<ticket> canonical
# event (CTL-300 shape).
#
# Run: bash plugins/dev/scripts/__tests__/phase-agent-emit-complete.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EMIT_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-agent-emit-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
}
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}

assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then
		pass "$label"
	else
		fail "$label — expected '$expected', got '$actual'"
	fi
}

if [[ ! -x $EMIT_SCRIPT ]]; then
	echo "FATAL: $EMIT_SCRIPT not found or not executable" >&2
	exit 1
fi

# Each test gets a fresh CATALYST_DIR and ORCH_DIR. The emit script writes to
# $CATALYST_DIR/events/YYYY-MM.jsonl (canonical_jsonl_append uses CATALYST_DIR
# transitively via the EVENTS_DIR derivation inside the script).
fresh_env() {
	local tag="$1"
	TEST_DIR="${SCRATCH}/${tag}"
	mkdir -p "${TEST_DIR}/catalyst/events"
	mkdir -p "${TEST_DIR}/orch/workers/CTL-100"
	export CATALYST_DIR="${TEST_DIR}/catalyst"
	export CATALYST_ORCHESTRATOR_DIR="${TEST_DIR}/orch"
	export CATALYST_ORCHESTRATOR_ID="orch-test"
	export CATALYST_SESSION_ID="sess_test_${tag}"
}

# Read the phase event line from this test's event log. catalyst-session.sh end
# (which the emit script also invokes) appends session.ended + agent.checkout
# lines after, so we grep for the phase event prefix instead of tailing.
read_event_line() {
	local month
	month=$(date -u +%Y-%m)
	local logfile="${CATALYST_DIR}/events/${month}.jsonl"
	[[ -f $logfile ]] || {
		echo ""
		return 1
	}
	grep -F '"event.name":"phase.' "$logfile" | tail -n 1
}

echo "Test 1: phase-complete emitter writes the canonical event shape"
fresh_env t1
"$EMIT_SCRIPT" --phase research --ticket CTL-100 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
	fail "Test 1: no event line emitted"
else
	EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
	assert_eq "phase.research.complete.CTL-100" "$EVENT_NAME" "event.name matches phase.<name>.complete.<ticket>"
	HAS_ATTRS=$(echo "$LINE" | jq -r 'has("attributes")')
	assert_eq "true" "$HAS_ATTRS" "canonical shape — attributes present"
	HAS_BODY=$(echo "$LINE" | jq -r 'has("body")')
	assert_eq "true" "$HAS_BODY" "canonical shape — body present"
	SEVERITY=$(echo "$LINE" | jq -r '.severityText')
	assert_eq "INFO" "$SEVERITY" "complete → INFO severity"
fi

echo ""
echo "Test 2: phase-complete includes session.id, orchestrator, ticket, phase"
fresh_env t2
"$EMIT_SCRIPT" --phase implement --ticket CTL-200 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
SESS=$(echo "$LINE" | jq -r '.attributes."catalyst.session.id"')
ORCH=$(echo "$LINE" | jq -r '.attributes."catalyst.orchestrator.id"')
WORKER=$(echo "$LINE" | jq -r '.attributes."catalyst.worker.ticket"')
LINEAR=$(echo "$LINE" | jq -r '.attributes."linear.issue.identifier"')
PAYLOAD_PHASE=$(echo "$LINE" | jq -r '.body.payload.phase')
assert_eq "sess_test_t2" "$SESS" "catalyst.session.id propagated from env"
assert_eq "orch-test" "$ORCH" "catalyst.orchestrator.id propagated from env"
assert_eq "CTL-200" "$WORKER" "catalyst.worker.ticket = ticket"
assert_eq "CTL-200" "$LINEAR" "linear.issue.identifier = ticket"
assert_eq "implement" "$PAYLOAD_PHASE" "body.payload.phase = phase name"

echo ""
echo "Test 3: failure variant uses .failed suffix and includes failure_reason"
fresh_env t3
"$EMIT_SCRIPT" --phase verify --ticket CTL-300 --status failed --reason "tests red after 3 attempts" >/dev/null 2>&1
LINE=$(read_event_line)
EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
SEVERITY=$(echo "$LINE" | jq -r '.severityText')
REASON_FIELD=$(echo "$LINE" | jq -r '.body.payload.failure_reason')
PAYLOAD_STATUS=$(echo "$LINE" | jq -r '.body.payload.status')
assert_eq "phase.verify.failed.CTL-300" "$EVENT_NAME" "failure event uses .failed suffix"
assert_eq "WARN" "$SEVERITY" "failed → WARN severity"
assert_eq "tests red after 3 attempts" "$REASON_FIELD" "body.payload.failure_reason carries reason"
assert_eq "failed" "$PAYLOAD_STATUS" "body.payload.status = failed"

# Bonus assertions covering the signal file update path on success.
echo ""
echo "Test 4 (bonus): signal file is updated to status=done on complete"
fresh_env t4
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-research.json"
echo '{"status":"in-progress","ticket":"CTL-100","phase":"research"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase research --ticket CTL-100 --status complete >/dev/null 2>&1
NEW_STATUS=$(jq -r '.status' "$SIGNAL")
HAS_COMPLETED=$(jq -r 'has("completedAt")' "$SIGNAL")
assert_eq "done" "$NEW_STATUS" "signal file status updated to done"
assert_eq "true" "$HAS_COMPLETED" "signal file gained completedAt timestamp"

# CTL-484: turn-cap-exhausted is a distinct status the broker can route on,
# and --handoff-path is the orchestrator's mechanism for orienting the resumed
# continuation worker.
echo ""
echo "Test 5 (CTL-484): --status turn-cap-exhausted is accepted and emits a distinct event"
fresh_env t5
"$EMIT_SCRIPT" --phase implement --ticket CTL-400 --status turn-cap-exhausted \
	--reason "turn cap hit (75)" \
	--handoff-path "thoughts/shared/handoffs/CTL-400/2026-05-17_00-00-00_turn-cap-continuation.md" \
	>/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
	fail "Test 5: no event line emitted"
else
	EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
	PAYLOAD_STATUS=$(echo "$LINE" | jq -r '.body.payload.status')
	PAYLOAD_HANDOFF=$(echo "$LINE" | jq -r '.body.payload.handoff_path')
	PAYLOAD_REASON=$(echo "$LINE" | jq -r '.body.payload.failure_reason')
	SEVERITY=$(echo "$LINE" | jq -r '.severityText')
	assert_eq "phase.implement.turn-cap-exhausted.CTL-400" "$EVENT_NAME" "event.name uses .turn-cap-exhausted suffix"
	assert_eq "turn-cap-exhausted" "$PAYLOAD_STATUS" "body.payload.status = turn-cap-exhausted"
	assert_eq "thoughts/shared/handoffs/CTL-400/2026-05-17_00-00-00_turn-cap-continuation.md" "$PAYLOAD_HANDOFF" "body.payload.handoff_path propagated"
	assert_eq "turn cap hit (75)" "$PAYLOAD_REASON" "body.payload.failure_reason still carried"
	assert_eq "WARN" "$SEVERITY" "turn-cap-exhausted → WARN severity"
fi

echo ""
echo "Test 6 (CTL-484): signal file is updated to status=turn-cap-exhausted and gains handoffPath"
fresh_env t6
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"status":"running","ticket":"CTL-100","phase":"implement"}' >"$SIGNAL"
HANDOFF="thoughts/shared/handoffs/CTL-100/2026-05-17_01-23-45_turn-cap-continuation.md"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status turn-cap-exhausted \
	--reason "turn cap hit (75)" --handoff-path "$HANDOFF" >/dev/null 2>&1
NEW_STATUS=$(jq -r '.status' "$SIGNAL")
HANDOFF_FIELD=$(jq -r '.handoffPath' "$SIGNAL")
REASON_FIELD=$(jq -r '.failureReason' "$SIGNAL")
assert_eq "turn-cap-exhausted" "$NEW_STATUS" "signal file status updated to turn-cap-exhausted (not done, not failed)"
assert_eq "$HANDOFF" "$HANDOFF_FIELD" ".handoffPath set on signal file"
assert_eq "turn cap hit (75)" "$REASON_FIELD" ".failureReason still recorded"

echo ""
echo "Test 7 (CTL-484 parity): lib/phase-emit-complete.sh accepts --status turn-cap-exhausted"
# phase-triage and phase-monitor-deploy source this lib instead of calling the
# standalone script. The CTL-484 addition has to ride both surfaces — assert
# the lib emits the same canonical event shape so phase-triage / phase-monitor
# can opt into the cap-exit pattern without code changes.
fresh_env t7
LIB_HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/phase-emit-complete.sh"
if [[ ! -f $LIB_HELPER ]]; then
	fail "Test 7: lib helper missing — expected at $LIB_HELPER"
else
	# Override CATALYST_EVENTS_FILE so the lib writes to a known file.
	EVENTS_T7="${TEST_DIR}/lib-emit.jsonl"
	CATALYST_EVENTS_FILE="$EVENTS_T7" bash -c "
    set -e
    . '$LIB_HELPER'
    emit_phase_complete --phase triage --ticket CTL-500 \
      --status turn-cap-exhausted --reason 'turn cap hit (10)'
  " 2>/dev/null
	if [[ -s $EVENTS_T7 ]]; then
		EVENT_NAME=$(jq -r '.attributes."event.name"' "$EVENTS_T7" | tail -n 1)
		SEVERITY=$(jq -r '.severityText' "$EVENTS_T7" | tail -n 1)
		MSG=$(jq -r '.body.message' "$EVENTS_T7" | tail -n 1)
		assert_eq "phase.triage.turn-cap-exhausted.CTL-500" "$EVENT_NAME" "lib emits .turn-cap-exhausted suffix"
		assert_eq "WARN" "$SEVERITY" "lib uses WARN severity for turn-cap-exhausted"
		# The lib uses --reason as the message when supplied, so the default-message
		# branch only fires when --reason is empty. Verify the message echoes the reason.
		assert_eq "turn cap hit (10)" "$MSG" "lib message echoes --reason"
	else
		fail "Test 7: lib emitted no event line"
	fi
fi

# ─── CTL-511: --no-signal-update event-only mode ────────────────────────────
# Phases 2 and 3 of CTL-511 need to wake the orchestrator with a
# phase.<name>.failed event WITHOUT mutating the signal file — the signal must
# stay at status:"stalled" (no failureReason) so orchestrate-revive Loop 2
# redispatches it. --no-signal-update is that shared primitive.
echo ""
echo "Test 8 (CTL-511): --no-signal-update emits the event but leaves the signal file untouched"
fresh_env t8
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-plan.json"
# Pre-seed the signal as orchestrate-healthcheck / the launch-failure path
# would leave it: status:"stalled", no failureReason.
echo '{"ticket":"CTL-100","phase":"plan","status":"stalled"}' >"$SIGNAL"
BEFORE=$(cat "$SIGNAL")
"$EMIT_SCRIPT" --phase plan --ticket CTL-100 --status failed \
	--reason launch-failed --no-signal-update >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
	fail "Test 8: --no-signal-update emitted no event line"
else
	EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
	assert_eq "phase.plan.failed.CTL-100" "$EVENT_NAME" "--no-signal-update still emits phase.<name>.failed event"
fi
assert_eq "$BEFORE" "$(cat "$SIGNAL")" "--no-signal-update leaves the signal file byte-identical"
assert_eq "stalled" "$(jq -r '.status' "$SIGNAL")" "--no-signal-update keeps signal status at stalled"
assert_eq "false" "$(jq -r 'has("failureReason")' "$SIGNAL")" "--no-signal-update does not write failureReason"

echo ""
echo "Test 9 (CTL-511 regression): default mode (no flag) still mutates the signal file"
fresh_env t9
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-plan.json"
echo '{"ticket":"CTL-100","phase":"plan","status":"running"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase plan --ticket CTL-100 --status failed >/dev/null 2>&1
assert_eq "failed" "$(jq -r '.status' "$SIGNAL")" "default mode still flips signal status to failed"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-agent-emit-complete: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
