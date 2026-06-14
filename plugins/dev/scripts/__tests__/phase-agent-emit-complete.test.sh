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
echo "Test 10 (CTL-512): --status skipped is accepted and emits a distinct event"
fresh_env t10
"$EMIT_SCRIPT" --phase monitor-deploy --ticket CTL-512 --status skipped \
	--reason "no deployment_status event for SHA on env within 1800s" \
	>/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
	fail "Test 10: no event line emitted"
else
	EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
	PAYLOAD_STATUS=$(echo "$LINE" | jq -r '.body.payload.status')
	PAYLOAD_REASON=$(echo "$LINE" | jq -r '.body.payload.failure_reason')
	SEVERITY=$(echo "$LINE" | jq -r '.severityText')
	assert_eq "phase.monitor-deploy.skipped.CTL-512" "$EVENT_NAME" "event.name uses .skipped suffix"
	assert_eq "skipped" "$PAYLOAD_STATUS" "body.payload.status = skipped"
	assert_eq "no deployment_status event for SHA on env within 1800s" "$PAYLOAD_REASON" "body.payload.failure_reason carries reason"
	assert_eq "INFO" "$SEVERITY" "skipped → INFO severity (successful terminal, not an error)"
fi

echo ""
echo "Test 11 (CTL-512): signal file is updated to status=skipped, completedAt set, bg_job_id preserved"
fresh_env t11
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-monitor-deploy.json"
echo '{"ticket":"CTL-100","phase":"monitor-deploy","status":"running","bg_job_id":"abc"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase monitor-deploy --ticket CTL-100 --status skipped \
	--reason "no deployment_status event" >/dev/null 2>&1
NEW_STATUS=$(jq -r '.status' "$SIGNAL")
HAS_COMPLETED=$(jq -r 'has("completedAt")' "$SIGNAL")
BG=$(jq -r '.bg_job_id' "$SIGNAL")
assert_eq "skipped" "$NEW_STATUS" "signal file status updated to skipped"
assert_eq "true" "$HAS_COMPLETED" "skipped is terminal → completedAt set"
assert_eq "abc" "$BG" "bg_job_id preserved (memory: project_phase_monitor_deploy_signal_overwrite)"

# ─── CTL-736 Phase 1: fencing check (stale generation bows out) ──────────────

echo ""
echo "Test 12 (CTL-736): stale generation (mine < signal) bows out — no event, no signal write"
fresh_env t12
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"ticket":"CTL-100","phase":"implement","status":"running","generation":3}' >"$SIGNAL"
CATALYST_GENERATION=2 "$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
RC=$?
assert_eq "0" "$RC" "stale-generation emit exits 0 (clean bow-out)"
assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "stale-generation emit does NOT flip the signal (still running)"
LINE=$(read_event_line)
assert_eq "" "$LINE" "stale-generation emit writes no phase event"

echo ""
echo "Test 13 (CTL-736): current generation (mine == signal) proceeds normally"
fresh_env t13
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"ticket":"CTL-100","phase":"implement","status":"running","generation":2}' >"$SIGNAL"
CATALYST_GENERATION=2 "$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
assert_eq "done" "$(jq -r '.status' "$SIGNAL")" "current-generation emit flips the signal to done"
EVENT_NAME=$(read_event_line | jq -r '.attributes."event.name"')
assert_eq "phase.implement.complete.CTL-100" "$EVENT_NAME" "current-generation emit writes the complete event"

echo ""
echo "Test 14 (CTL-736): a higher generation than the signal proceeds (never a false bow-out)"
fresh_env t14
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"ticket":"CTL-100","phase":"implement","status":"running","generation":2}' >"$SIGNAL"
CATALYST_GENERATION=3 "$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
assert_eq "done" "$(jq -r '.status' "$SIGNAL")" "mine > signal still emits (fences only on mine < signal)"

echo ""
echo "Test 15 (CTL-736): no CATALYST_GENERATION (legacy worker) proceeds — fail-open"
fresh_env t15
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"ticket":"CTL-100","phase":"implement","status":"running","generation":5}' >"$SIGNAL"
unset CATALYST_GENERATION
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
assert_eq "done" "$(jq -r '.status' "$SIGNAL")" "unfenced worker (no CATALYST_GENERATION) still emits"

echo ""
echo "Test 16 (CTL-736): legacy signal without a generation field proceeds — fail-open"
fresh_env t16
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"ticket":"CTL-100","phase":"implement","status":"running"}' >"$SIGNAL"
CATALYST_GENERATION=2 "$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
assert_eq "done" "$(jq -r '.status' "$SIGNAL")" "signal without generation field still emits (no fence data)"

# ─── CTL-549: park status ───────────────────────────────────────────────────

echo ""
echo "Test 17 (CTL-549): --status park is accepted (exit 0)"
fresh_env t17
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 \
	--status park --handoff-path /tmp/handoff.md \
	>/dev/null 2>&1
assert_eq "0" "$?" "park: script exits 0"

echo ""
echo "Test 18 (CTL-549): signal file gets status=needs-input and parkedFrom=implement"
fresh_env t18
mkdir -p "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100"
echo '{"status":"running","ticket":"CTL-100","phase":"implement"}' \
	>"${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 \
	--status park --handoff-path /tmp/handoff.md >/dev/null 2>&1
SIG="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
STATUS=$(jq -r '.status' "$SIG")
PARKED_FROM=$(jq -r '.parkedFrom' "$SIG")
HANDOFF=$(jq -r '.handoffPath' "$SIG")
assert_eq "needs-input" "$STATUS" "park: signal status=needs-input"
assert_eq "implement" "$PARKED_FROM" "park: signal parkedFrom=implement"
assert_eq "/tmp/handoff.md" "$HANDOFF" "park: signal handoffPath set"

echo ""
echo "Test 19 (CTL-549): completedAt is NOT set on park (non-terminal)"
fresh_env t19
mkdir -p "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100"
echo '{"status":"running","ticket":"CTL-100","phase":"implement"}' \
	>"${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status park >/dev/null 2>&1
SIG="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
COMPLETED_AT=$(jq -r '.completedAt // "absent"' "$SIG")
assert_eq "absent" "$COMPLETED_AT" "park: completedAt not set"

echo ""
echo "Test 20 (CTL-549): event name is phase.implement.park.CTL-100"
fresh_env t20
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status park >/dev/null 2>&1
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
	fail "Test 20: no event line emitted for park"
else
	EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"')
	assert_eq "phase.implement.park.CTL-100" "$EVENT_NAME" "park: event name is phase.implement.park.CTL-100"
fi

echo ""
echo "Test 21 (CTL-549): unknown status 'parked' still rejected (exit 1)"
fresh_env t21
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status parked 2>/dev/null
assert_eq "1" "$?" "invalid status parked: exits 1"

# ─── CTL-760: canonical resource block (project / linear.key / catalyst.orchestration)
# build_canonical_line supports a resource block (lib/canonical-event.sh) but the
# emit call previously only passed --linear-ticket, leaving the resource block's
# project / linear.key / catalyst.orchestration unset on the worker's terminal
# event. CTL-760 threads --project / --linear-key / --catalyst-orchestration so the
# completion event carries the same orchestration context the worker's metrics do,
# plus a duration_seconds payload field when the signal has both startedAt and
# completedAt.

echo ""
echo "Test 22 (CTL-760): completion event carries the resource block (project / linear.key / catalyst.orchestration)"
fresh_env t22
# Provide a .catalyst/config.json with a projectKey the script can resolve, and
# run from that directory so the ancestor-config lookup finds it.
PROJ_DIR="${TEST_DIR}/proj"
mkdir -p "${PROJ_DIR}/.catalyst"
cat >"${PROJ_DIR}/.catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-triage.json"
echo '{"status":"running","ticket":"CTL-100","phase":"triage"}' >"$SIGNAL"
(cd "$PROJ_DIR" &&
	CATALYST_ORCHESTRATOR_ID=CTL-100 "$EMIT_SCRIPT" --phase triage --ticket CTL-100 \
		--status complete --orch-id CTL-100 >/dev/null 2>&1)
LINE=$(read_event_line)
if [[ -z $LINE ]]; then
	fail "Test 22: no event line emitted"
else
	RES_PROJECT=$(echo "$LINE" | jq -r '.resource["project"] // empty')
	RES_LINEAR=$(echo "$LINE" | jq -r '.resource["linear.key"] // empty')
	RES_ORCH=$(echo "$LINE" | jq -r '.resource["catalyst.orchestration"] // empty')
	assert_eq "test-proj" "$RES_PROJECT" "resource.project resolved from config projectKey"
	assert_eq "CTL-100" "$RES_LINEAR" "resource[\"linear.key\"] = ticket"
	assert_eq "CTL-100" "$RES_ORCH" "resource[\"catalyst.orchestration\"] = orch id"
fi

echo ""
echo "Test 23 (CTL-760): duration_seconds payload computed from startedAt/completedAt"
fresh_env t23
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
# startedAt 90s before completedAt → duration_seconds should be 90.
echo '{"status":"running","ticket":"CTL-100","phase":"implement","startedAt":"2026-06-04T00:00:00Z","completedAt":"2026-06-04T00:01:30Z"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
DURATION=$(echo "$LINE" | jq -r '.body.payload.duration_seconds // empty')
assert_eq "90" "$DURATION" "body.payload.duration_seconds = 90 (completedAt - startedAt)"

echo ""
echo "Test 24 (CTL-760): duration_seconds omitted when signal lacks timestamps"
fresh_env t24
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"status":"running","ticket":"CTL-100","phase":"implement"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
HAS_DURATION=$(echo "$LINE" | jq -r '.body.payload | has("duration_seconds")')
assert_eq "false" "$HAS_DURATION" "duration_seconds omitted when startedAt/completedAt absent"

echo ""
echo "Test 25 (CTL-761): phase.attempt / phase.revive_count attributes from signal"
fresh_env t25
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"status":"running","ticket":"CTL-100","phase":"implement","attempt":3}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
ATT=$(echo "$LINE" | jq -r '.attributes["catalyst.phase.attempt"] // empty')
RC=$(echo "$LINE" | jq -r '.attributes["catalyst.phase.revive_count"] // empty')
assert_eq "3" "$ATT" "attributes[\"catalyst.phase.attempt\"] = 3 from signal"
assert_eq "2" "$RC" "attributes[\"catalyst.phase.revive_count\"] = attempt-1 = 2"

echo ""
echo "Test 26 (CTL-761): cold dispatch attempt=1 → revive_count=0"
fresh_env t26
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-triage.json"
echo '{"status":"running","ticket":"CTL-100","phase":"triage","attempt":1}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase triage --ticket CTL-100 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
assert_eq "1" "$(echo "$LINE" | jq -r '.attributes["catalyst.phase.attempt"]')" "attempt=1"
assert_eq "0" "$(echo "$LINE" | jq -r '.attributes["catalyst.phase.revive_count"]')" "revive_count clamped to 0"

echo ""
echo "Test 27 (CTL-761): attributes omitted when signal lacks attempt"
fresh_env t27
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"status":"running","ticket":"CTL-100","phase":"implement"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
assert_eq "false" "$(echo "$LINE" | jq -r '.attributes | has("catalyst.phase.attempt")')" "catalyst.phase.attempt omitted"
assert_eq "false" "$(echo "$LINE" | jq -r '.attributes | has("catalyst.phase.revive_count")')" "catalyst.phase.revive_count omitted"

echo ""
echo "Test 28 (CTL-761): failed status also carries attempt/revive_count"
fresh_env t28
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"status":"running","ticket":"CTL-100","phase":"implement","attempt":2}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status failed --reason "test_reason" >/dev/null 2>&1
LINE=$(read_event_line)
assert_eq "2" "$(echo "$LINE" | jq -r '.attributes["catalyst.phase.attempt"]')" "failed path: catalyst.phase.attempt=2"
assert_eq "1" "$(echo "$LINE" | jq -r '.attributes["catalyst.phase.revive_count"]')" "failed path: catalyst.phase.revive_count=1"

# ─── CTL-777: signal flip fires from --orch-dir even when the env var is dropped ─
# `claude --bg` drops the plain env prefix, so a worker can run with
# CATALYST_ORCHESTRATOR_DIR unset. The dispatch-side fix re-supplies ORCH_DIR via
# settings.env, but emit-complete also already prefers an explicit --orch-dir over
# the env var (belt-and-braces). These tests pin both halves: --orch-dir alone
# flips the signal, and the unfixed failure mode (no env AND no --orch-dir) leaves
# the signal untouched.

echo ""
echo "Test 29 (CTL-777): --orch-dir flips the signal to done even with env var unset"
fresh_env t29
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-research.json"
echo '{"status":"running","ticket":"CTL-100","phase":"research"}' >"$SIGNAL"
# Drop the env var to reproduce the dropped-prefix bg worker; supply --orch-dir.
env -u CATALYST_ORCHESTRATOR_DIR "$EMIT_SCRIPT" \
	--phase research --ticket CTL-100 --status complete \
	--orch-dir "${TEST_DIR}/orch" >/dev/null 2>&1
NEW_STATUS=$(jq -r '.status' "$SIGNAL" 2>/dev/null)
HAS_COMPLETED=$(jq -r 'has("completedAt")' "$SIGNAL" 2>/dev/null)
assert_eq "done" "$NEW_STATUS" "--orch-dir flips signal to done with env unset"
assert_eq "true" "$HAS_COMPLETED" "--orch-dir path still stamps completedAt"

echo ""
echo "Test 30 (CTL-777): documents the fixed failure mode — no env AND no --orch-dir leaves signal running"
fresh_env t30
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-research.json"
echo '{"status":"running","ticket":"CTL-100","phase":"research"}' >"$SIGNAL"
# Neither the env var nor --orch-dir → ORCH_DIR empty → step-2 gate skips (the bug).
env -u CATALYST_ORCHESTRATOR_DIR "$EMIT_SCRIPT" \
	--phase research --ticket CTL-100 --status complete >/dev/null 2>&1
STILL_RUNNING=$(jq -r '.status' "$SIGNAL" 2>/dev/null)
assert_eq "running" "$STILL_RUNNING" "no env + no --orch-dir → signal NOT flipped (the wedge this fix avoids)"

# ─── CTL-700 (Item D): failureReason null on --status complete ────────────────
# Gate both signal .failureReason and event failure_reason on --status not being
# "complete". A stale .failureReason from a prior failed attempt must also be
# cleared to null when the phase later completes successfully.

echo ""
echo "Test 31 (CTL-700 D): event payload omits failure_reason on --status complete with --reason"
fresh_env t31
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-research.json"
echo '{"status":"running","ticket":"CTL-100","phase":"research"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase research --ticket CTL-100 --status complete --reason "should be dropped" >/dev/null 2>&1
LINE=$(read_event_line)
HAS_REASON=$(echo "$LINE" | jq -r '.body.payload | has("failure_reason")')
assert_eq "false" "$HAS_REASON" "failure_reason absent from event payload on complete"

echo ""
echo "Test 32 (CTL-700 D): signal file gets failureReason=null on --status complete with --reason"
fresh_env t32
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-research.json"
echo '{"status":"running","ticket":"CTL-100","phase":"research"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase research --ticket CTL-100 --status complete --reason "should be dropped" >/dev/null 2>&1
FAILURE_REASON=$(jq -r '.failureReason' "$SIGNAL" 2>/dev/null)
assert_eq "null" "$FAILURE_REASON" "signal .failureReason is null on complete"

echo ""
echo "Test 33 (CTL-700 D): signal clears a stale failureReason on --status complete"
fresh_env t33
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-research.json"
echo '{"status":"running","ticket":"CTL-100","phase":"research","failureReason":"leftover_from_failed_attempt"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase research --ticket CTL-100 --status complete >/dev/null 2>&1
FAILURE_REASON=$(jq -r '.failureReason' "$SIGNAL" 2>/dev/null)
assert_eq "null" "$FAILURE_REASON" "stale failureReason cleared to null on complete"

echo ""
echo "Test 34 (CTL-700 D): regression-lock — failed path still carries failure_reason"
fresh_env t34
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-research.json"
echo '{"status":"running","ticket":"CTL-100","phase":"research"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase research --ticket CTL-100 --status failed --reason "tests red after 3 attempts" >/dev/null 2>&1
LINE=$(read_event_line)
REASON_FIELD=$(echo "$LINE" | jq -r '.body.payload.failure_reason')
SIGNAL_REASON=$(jq -r '.failureReason' "$SIGNAL" 2>/dev/null)
assert_eq "tests red after 3 attempts" "$REASON_FIELD" "failed path still carries failure_reason in event"
assert_eq "tests red after 3 attempts" "$SIGNAL_REASON" "failed path still carries failureReason in signal"

echo ""
echo "Test 35 (CTL-700 D): regression-lock — turn-cap-exhausted still carries failure_reason"
fresh_env t35
SIGNAL="${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/phase-implement.json"
echo '{"status":"running","ticket":"CTL-100","phase":"implement"}' >"$SIGNAL"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status turn-cap-exhausted --reason "turn cap hit (75)" >/dev/null 2>&1
LINE=$(read_event_line)
PAYLOAD_REASON=$(echo "$LINE" | jq -r '.body.payload.failure_reason')
SIGNAL_REASON=$(jq -r '.failureReason' "$SIGNAL" 2>/dev/null)
assert_eq "turn cap hit (75)" "$PAYLOAD_REASON" "turn-cap path still carries failure_reason in event"
assert_eq "turn cap hit (75)" "$SIGNAL_REASON" "turn-cap path still carries failureReason in signal"

# CTL-1023: the work-type dimension (catalyst.ticket.type) rides on every phase
# terminal event, resolved from workers/<ticket>/triage.json .classification.
echo ""
echo "Test 36 (CTL-1023): catalyst.ticket.type reads triage.json .classification"
fresh_env t36
mkdir -p "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100"
echo '{"classification":"bug","estimated_scope":"small"}' >"${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/triage.json"
"$EMIT_SCRIPT" --phase implement --ticket CTL-100 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
TTYPE=$(echo "$LINE" | jq -r '.attributes."catalyst.ticket.type"')
assert_eq "bug" "$TTYPE" "catalyst.ticket.type = classification from triage.json"

echo ""
echo "Test 37 (CTL-1023): catalyst.ticket.type defaults to 'unknown' with no triage.json"
fresh_env t37
"$EMIT_SCRIPT" --phase triage --ticket CTL-100 --status complete >/dev/null 2>&1
LINE=$(read_event_line)
TTYPE=$(echo "$LINE" | jq -r '.attributes."catalyst.ticket.type"')
HAS_TTYPE=$(echo "$LINE" | jq -r '.attributes | has("catalyst.ticket.type")')
assert_eq "true" "$HAS_TTYPE" "catalyst.ticket.type is present even with no classification"
assert_eq "unknown" "$TTYPE" "catalyst.ticket.type defaults to 'unknown' (never inconsistently missing)"

echo ""
echo "Test 38 (CTL-1023): catalyst.ticket.type rides the .failed event too"
fresh_env t38
mkdir -p "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100"
echo '{"classification":"feature"}' >"${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-100/triage.json"
"$EMIT_SCRIPT" --phase verify --ticket CTL-100 --status failed --reason "tests red" >/dev/null 2>&1
LINE=$(read_event_line)
TTYPE=$(echo "$LINE" | jq -r '.attributes."catalyst.ticket.type"')
assert_eq "feature" "$TTYPE" "catalyst.ticket.type present on failed event"

# ─── CTL-1081 Phase 2: artifact self-check in emit-complete ──────────────────
# For thoughts-producing phases (research, plan), --status complete is downgraded
# to failed with reason=artifact_not_gate_visible when the own artifact is absent.
# Non-thoughts phases and non-complete statuses are unaffected.

echo ""
echo "Test 39 (CTL-1081 P2): research + doc present → complete emits phase.research.complete"
fresh_env t39
PROJ_DIR="${TEST_DIR}/proj"
mkdir -p "${PROJ_DIR}/thoughts/shared/research"
touch "${PROJ_DIR}/thoughts/shared/research/2026-06-12-ctl-1081-x.md"
(cd "$PROJ_DIR" && "$EMIT_SCRIPT" --phase research --ticket CTL-1081 --status complete >/dev/null 2>&1)
LINE=$(read_event_line)
EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"' 2>/dev/null || echo "")
assert_eq "phase.research.complete.CTL-1081" "$EVENT_NAME" "doc present → complete event emitted"

echo ""
echo "Test 40 (CTL-1081 P2): research + doc absent → complete downgraded to failed with artifact_not_gate_visible"
fresh_env t40
PROJ_DIR="${TEST_DIR}/proj"
mkdir -p "${PROJ_DIR}/thoughts/shared/research"
(cd "$PROJ_DIR" && "$EMIT_SCRIPT" --phase research --ticket CTL-1081 --status complete >/dev/null 2>&1)
LINE=$(read_event_line)
EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"' 2>/dev/null || echo "")
REASON=$(echo "$LINE" | jq -r '.body.payload.failure_reason' 2>/dev/null || echo "")
assert_eq "phase.research.failed.CTL-1081" "$EVENT_NAME" "doc absent → failed event emitted"
assert_eq "artifact_not_gate_visible" "$REASON" "failure_reason=artifact_not_gate_visible"

echo ""
echo "Test 41 (CTL-1081 P2): verify (non-thoughts phase) → complete unaffected"
fresh_env t41
(cd "${TEST_DIR}" && "$EMIT_SCRIPT" --phase verify --ticket CTL-1081 --status complete >/dev/null 2>&1)
LINE=$(read_event_line)
EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"' 2>/dev/null || echo "")
assert_eq "phase.verify.complete.CTL-1081" "$EVENT_NAME" "non-thoughts phase: complete unaffected by self-check"

echo ""
echo "Test 42 (CTL-1081 P2): research + status failed → NOT altered by self-check"
fresh_env t42
PROJ_DIR="${TEST_DIR}/proj"
mkdir -p "${PROJ_DIR}/thoughts/shared/research"
(cd "$PROJ_DIR" && "$EMIT_SCRIPT" --phase research --ticket CTL-1081 --status failed --reason "tests red" >/dev/null 2>&1)
LINE=$(read_event_line)
EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"' 2>/dev/null || echo "")
REASON=$(echo "$LINE" | jq -r '.body.payload.failure_reason' 2>/dev/null || echo "")
assert_eq "phase.research.failed.CTL-1081" "$EVENT_NAME" "non-complete status: event name unchanged"
assert_eq "tests red" "$REASON" "non-complete status: caller reason preserved"


# ─── CTL-1097: artifact self-check resolves against signal.worktreePath ──────
# A revived worker may re-emit from a cwd that is NOT the ticket worktree. The
# gate must resolve the relative thoughts dir against signal.worktreePath
# (CTL-615) rather than the emit process's cwd.

echo ""
echo "Test 43 (CTL-1097): revived worker — artifact in worktreePath, emit from a different cwd → complete stands"
fresh_env t43
WT_DIR="${TEST_DIR}/worktree"
OTHER_CWD="${TEST_DIR}/elsewhere"
mkdir -p "${WT_DIR}/thoughts/shared/plans" "${OTHER_CWD}"
touch "${WT_DIR}/thoughts/shared/plans/2026-06-13-ctl-1097-x.md"
mkdir -p "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-1097"
jq -nc --arg wt "$WT_DIR" '{ticket:"CTL-1097",phase:"plan",worktreePath:$wt,generation:1,attempt:1}' \
	> "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-1097/phase-plan.json"
(cd "$OTHER_CWD" && "$EMIT_SCRIPT" --phase plan --ticket CTL-1097 --status complete >/dev/null 2>&1)
LINE=$(read_event_line)
EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"' 2>/dev/null || echo "")
assert_eq "phase.plan.complete.CTL-1097" "$EVENT_NAME" "worktreePath resolution: complete stands from foreign cwd"

echo ""
echo "Test 44 (CTL-1097): no worktreePath in signal (pre-CTL-615) → fail-open to cwd-relative"
fresh_env t44
PROJ_DIR="${TEST_DIR}/proj"
mkdir -p "${PROJ_DIR}/thoughts/shared/plans"
touch "${PROJ_DIR}/thoughts/shared/plans/2026-06-13-ctl-1097-x.md"
mkdir -p "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-1097"
echo '{"ticket":"CTL-1097","phase":"plan","generation":1,"attempt":1}' \
	> "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-1097/phase-plan.json"
(cd "$PROJ_DIR" && "$EMIT_SCRIPT" --phase plan --ticket CTL-1097 --status complete >/dev/null 2>&1)
LINE=$(read_event_line)
EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"' 2>/dev/null || echo "")
assert_eq "phase.plan.complete.CTL-1097" "$EVENT_NAME" "no worktreePath: cwd-relative fallback still passes"

echo ""
echo "Test 45 (CTL-1097): worktreePath set but artifact genuinely absent there → downgraded to failed"
fresh_env t45
WT_DIR="${TEST_DIR}/worktree"
OTHER_CWD="${TEST_DIR}/elsewhere"
mkdir -p "${WT_DIR}/thoughts/shared/plans" "${OTHER_CWD}"
mkdir -p "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-1097"
jq -nc --arg wt "$WT_DIR" '{ticket:"CTL-1097",phase:"plan",worktreePath:$wt,generation:1,attempt:1}' \
	> "${CATALYST_ORCHESTRATOR_DIR}/workers/CTL-1097/phase-plan.json"
(cd "$OTHER_CWD" && "$EMIT_SCRIPT" --phase plan --ticket CTL-1097 --status complete >/dev/null 2>&1)
LINE=$(read_event_line)
EVENT_NAME=$(echo "$LINE" | jq -r '.attributes."event.name"' 2>/dev/null || echo "")
REASON=$(echo "$LINE" | jq -r '.body.payload.failure_reason' 2>/dev/null || echo "")
assert_eq "phase.plan.failed.CTL-1097" "$EVENT_NAME" "genuine miss in worktreePath → failed"
assert_eq "artifact_not_gate_visible" "$REASON" "genuine miss preserves artifact_not_gate_visible reason"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-agent-emit-complete: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
