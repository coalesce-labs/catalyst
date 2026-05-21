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
	cat >"${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
	chmod +x "${SCRATCH}/bin/catalyst-state.sh"
	export STATE_LOG="${SCRATCH}/state.log"
	: >"$STATE_LOG"
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
		>"${ORCH_DIR}/workers/${ticket}.json"
}

make_signal_no_pid() {
	local ticket="$1" status="$2" phase="$3"
	jq -n \
		--arg t "$ticket" --arg s "$status" --argjson p "$phase" \
		'{ticket:$t, status:$s, phase:$p, pid:null, updatedAt:"2026-04-16T00:00:00Z"}' \
		>"${ORCH_DIR}/workers/${ticket}.json"
}

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -ge 2 ] && echo "    $2"
}

# A PID guaranteed to be dead.
DEAD_PID=99999999
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$((DEAD_PID + 1)); done

# ---

echo "test: alive worker is left untouched"
scratch_setup
ALIVE_PID=$$ # this test process itself
make_signal "PROJ-1" "$ALIVE_PID" "dispatched" 0
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-1.json")
[ "$STATUS" = "dispatched" ] && pass "status unchanged" || fail "status unchanged" "got: $STATUS"
[ ! -s "$STATE_LOG" ] && pass "no state-script calls" || fail "no state-script calls" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test: dead worker is flagged"
scratch_setup
make_signal "PROJ-2" "$DEAD_PID" "dispatched" 0
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-2.json")
REASON=$(jq -r '.failureReason' "${ORCH_DIR}/workers/PROJ-2.json")
[ "$STATUS" = "failed" ] && pass "status transitioned to failed" || fail "status transitioned to failed" "got: $STATUS"
[ "$REASON" = "launch-failure" ] && pass "failureReason set" || fail "failureReason set" "got: $REASON"
grep -q "attention demo launch-failure PROJ-2" "$STATE_LOG" &&
	pass "attention raised" || fail "attention raised" "log: $(cat "$STATE_LOG")"
grep -q "worker-launch-failed" "$STATE_LOG" &&
	pass "launch-failed event emitted" || fail "launch-failed event emitted" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test: worker past phase 0 is skipped"
scratch_setup
make_signal "PROJ-3" "$DEAD_PID" "implementing" 3
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-3.json")
[ "$STATUS" = "implementing" ] && pass "advanced worker untouched" || fail "advanced worker untouched" "got: $STATUS"
[ ! -s "$STATE_LOG" ] && pass "no state-script calls for advanced worker" || fail "no state-script calls for advanced worker"
scratch_teardown

echo "test: worker with null pid is skipped safely"
scratch_setup
make_signal_no_pid "PROJ-4" "dispatched" 0
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
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
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
SA=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-A.json")
SB=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-B.json")
SC=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-C.json")
[ "$SA" = "dispatched" ] && [ "$SC" = "dispatched" ] && pass "alive workers untouched" ||
	fail "alive workers untouched" "A=$SA C=$SC"
[ "$SB" = "failed" ] && pass "dead worker flagged" || fail "dead worker flagged" "B=$SB"
DEAD_COUNT=$(grep -c "attention demo launch-failure" "$STATE_LOG" || true)
[ "$DEAD_COUNT" = "1" ] && pass "exactly one attention call" || fail "exactly one attention call" "count=$DEAD_COUNT"
scratch_teardown

echo "test: --dry-run detects but does not mutate"
scratch_setup
make_signal "PROJ-5" "$DEAD_PID" "dispatched" 0
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 --dry-run >"${SCRATCH}/out" 2>&1
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PROJ-5.json")
[ "$STATUS" = "dispatched" ] && pass "dry-run leaves signal unchanged" || fail "dry-run leaves signal unchanged" "got: $STATUS"
[ ! -s "$STATE_LOG" ] && pass "dry-run makes no state-script calls" || fail "dry-run makes no state-script calls" "log: $(cat "$STATE_LOG")"
grep -q "PROJ-5" "${SCRATCH}/out" && pass "dry-run reports the dead worker" || fail "dry-run reports the dead worker" "out: $(cat "${SCRATCH}/out")"
scratch_teardown

echo "test: non-worker JSON files are ignored"
scratch_setup
make_signal "PROJ-6" "$DEAD_PID" "dispatched" 0
# Drop a non-signal JSON file shaped like something that could appear in workers/.
echo '{"somethingElse": true}' >"${ORCH_DIR}/workers/not-a-signal.json"
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
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

# ─── CTL-452: --bg phase-mode worker state.json mtime checks ─────────────────

# make_phase_signal TICKET PHASE STATUS BG_JOB_ID
# Creates ${ORCH_DIR}/workers/<TICKET>/phase-<PHASE>.json with the given
# bg_job_id. Phase-mode signals live in a per-ticket subdirectory (NOT in
# the flat workers/*.json space scanned by the legacy PID check).
make_phase_signal() {
	local ticket="$1" phase="$2" status="$3" bg="$4"
	mkdir -p "${ORCH_DIR}/workers/${ticket}"
	jq -n \
		--arg t "$ticket" --arg p "$phase" --arg s "$status" --arg bg "$bg" \
		'{ticket:$t, phase:$p, status:$s, bg_job_id:$bg,
      startedAt:"2026-05-16T00:00:00Z", updatedAt:"2026-05-16T00:00:00Z"}' \
		>"${ORCH_DIR}/workers/${ticket}/phase-${phase}.json"
}

# make_bg_state JOB_ID STATE [AGE_SEC]
# Creates a fake ~/.claude/jobs/<id>/state.json. AGE_SEC, if provided, mutates
# the mtime to that many seconds ago.
#
# Note on touch + timezones: macOS `touch -t [[CC]YY]MMDDhhmm[.SS]` interprets
# the timestamp string in LOCAL time. To keep the stat-vs-now math (both Unix
# epochs, TZ-agnostic) consistent, we must feed touch a LOCAL-time string —
# so `date -r EPOCH` (without -u) is the correct format command on macOS.
make_bg_state() {
	local job="$1" state="$2" age="${3:-0}"
	mkdir -p "${SCRATCH}/jobs/${job}"
	echo "{\"state\":\"${state}\",\"id\":\"${job}\"}" >"${SCRATCH}/jobs/${job}/state.json"
	if [ "$age" -gt 0 ]; then
		local then
		then=$(($(date -u +%s) - age))
		if date -r "$then" "+%Y%m%d%H%M.%S" >/dev/null 2>&1; then
			touch -t "$(date -r "$then" "+%Y%m%d%H%M.%S")" "${SCRATCH}/jobs/${job}/state.json"
		else
			touch -d "@${then}" "${SCRATCH}/jobs/${job}/state.json" 2>/dev/null || true
		fi
	fi
	export CATALYST_HEALTHCHECK_JOBS_ROOT="${SCRATCH}/jobs"
}

# Read status from a per-phase signal at workers/<T>/phase-<P>.json
phase_status() {
	local ticket="$1" phase="$2"
	jq -r '.status' "${ORCH_DIR}/workers/${ticket}/phase-${phase}.json"
}

echo "test (CTL-452): phase-mode worker with stale state.json marked stalled"
scratch_setup
make_phase_signal "T-A" "implement" "running" "bg-stale"
make_bg_state "bg-stale" "running" 1200 # 20 min — older than 15 min default
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
ST=$(phase_status "T-A" "implement")
[ "$ST" = "stalled" ] && pass "stale + running → stalled" || fail "stale + running → stalled" "got: $ST"
grep -q "worker-phase-stalled" "$STATE_LOG" && pass "worker-phase-stalled event emitted" || fail "worker-phase-stalled event emitted" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test (CTL-452): phase-mode worker with fresh state.json untouched"
scratch_setup
make_phase_signal "T-B" "research" "running" "bg-fresh"
make_bg_state "bg-fresh" "running" 30 # 30s old — well within 15 min default
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
ST=$(phase_status "T-B" "research")
[ "$ST" = "running" ] && pass "fresh state.json → status untouched" || fail "fresh state.json → status untouched" "got: $ST"
grep -q "worker-phase-stalled" "$STATE_LOG" && fail "no phase-stalled event for fresh job" || pass "no phase-stalled event for fresh job"
scratch_teardown

echo "test (CTL-452): phase-mode worker with state=done untouched even when stale"
scratch_setup
make_phase_signal "T-C" "pr" "done" "bg-done"
make_bg_state "bg-done" "done" 2000 # very stale, but terminal
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
ST=$(phase_status "T-C" "pr")
[ "$ST" = "done" ] && pass "terminal job state.json → status untouched" || fail "terminal job state.json → status untouched" "got: $ST"
scratch_teardown

echo "test (CTL-452): phase-mode worker with missing job dir → stalled"
scratch_setup
make_phase_signal "T-D" "verify" "running" "bg-missing"
export CATALYST_HEALTHCHECK_JOBS_ROOT="${SCRATCH}/jobs" # exists but no per-job subdir
mkdir -p "${SCRATCH}/jobs"
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
ST=$(phase_status "T-D" "verify")
[ "$ST" = "stalled" ] && pass "missing job dir → stalled" || fail "missing job dir → stalled" "got: $ST"
scratch_teardown

echo "test (CTL-452): --stale-bg-seconds tunes the threshold"
scratch_setup
make_phase_signal "T-E" "implement" "running" "bg-customstale"
make_bg_state "bg-customstale" "running" 120 # 2 min
# With default 900s, this is fresh. With --stale-bg-seconds 60, it's stale.
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 --stale-bg-seconds 60 >"${SCRATCH}/out" 2>&1
ST=$(phase_status "T-E" "implement")
[ "$ST" = "stalled" ] && pass "custom threshold flips fresh → stalled" || fail "custom threshold flips fresh → stalled" "got: $ST"
scratch_teardown

# ─── CTL-511: phase stall also emits phase.<name>.failed to wake the orchestrator ───
#
# The legacy worker-phase-stalled event does not match the broker's
# PHASE_EVENT_PATTERN, so a flipped-to-stalled signal never woke the
# orchestrator. CTL-511 adds a phase.<name>.failed.<TICKET> emission alongside
# it. The signal must stay at status="stalled" with NO failureReason so
# orchestrate-revive Loop 2 redispatches it.

echo "test (CTL-511): phase stall emits phase.<name>.failed event to wake the orchestrator"
scratch_setup
export CATALYST_DIR="${SCRATCH}/catalyst"
mkdir -p "${CATALYST_DIR}/events"
make_phase_signal "CTL-904" "monitor-merge" "running" "bg-ctl511-a"
export CATALYST_HEALTHCHECK_JOBS_ROOT="${SCRATCH}/jobs" # exists, no per-job subdir → state-json-missing
mkdir -p "${SCRATCH}/jobs"
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
ST=$(phase_status "CTL-904" "monitor-merge")
if [ "$ST" = "stalled" ]; then
	pass "healthcheck still flips signal to stalled"
else
	fail "healthcheck still flips signal to stalled" "got: $ST"
fi
HAS_FR=$(jq -r 'has("failureReason")' "${ORCH_DIR}/workers/CTL-904/phase-monitor-merge.json")
if [ "$HAS_FR" = "false" ]; then
	pass "stalled signal has no failureReason (Loop 2 redispatch-eligible)"
else
	fail "stalled signal has no failureReason" "got has: $HAS_FR"
fi
AR=$(jq -r '.attentionReason' "${ORCH_DIR}/workers/CTL-904/phase-monitor-merge.json")
if [ "$AR" = "state-json-missing" ]; then
	pass "stalled signal records attentionReason=state-json-missing (the cause string)"
else
	fail "stalled signal records attentionReason" "got: $AR"
fi
if grep -rqs '"phase.monitor-merge.failed.CTL-904"' "${CATALYST_DIR}/events/"; then
	pass "healthcheck emits phase.monitor-merge.failed.CTL-904 to wake the orchestrator"
else
	fail "healthcheck emitted no phase.monitor-merge.failed.CTL-904 event"
fi
unset CATALYST_DIR
scratch_teardown

echo "test (CTL-511 regression): worker-phase-stalled event still emitted alongside phase.*.failed"
scratch_setup
export CATALYST_DIR="${SCRATCH}/catalyst"
mkdir -p "${CATALYST_DIR}/events"
make_phase_signal "CTL-905" "verify" "running" "bg-ctl511-b"
export CATALYST_HEALTHCHECK_JOBS_ROOT="${SCRATCH}/jobs"
mkdir -p "${SCRATCH}/jobs"
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >"${SCRATCH}/out" 2>&1
if grep -q "worker-phase-stalled" "$STATE_LOG"; then
	pass "worker-phase-stalled event still emitted (regression)"
else
	fail "worker-phase-stalled event still emitted" "log: $(cat "$STATE_LOG")"
fi
unset CATALYST_DIR
scratch_teardown

echo "test (CTL-511): --dry-run emits no phase.*.failed event and no signal mutation"
scratch_setup
export CATALYST_DIR="${SCRATCH}/catalyst"
mkdir -p "${CATALYST_DIR}/events"
make_phase_signal "CTL-906" "implement" "running" "bg-ctl511-c"
export CATALYST_HEALTHCHECK_JOBS_ROOT="${SCRATCH}/jobs"
mkdir -p "${SCRATCH}/jobs"
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 --dry-run >"${SCRATCH}/out" 2>&1
ST=$(phase_status "CTL-906" "implement")
if [ "$ST" = "running" ]; then
	pass "--dry-run leaves phase signal unchanged"
else
	fail "--dry-run leaves phase signal unchanged" "got: $ST"
fi
if grep -rqs '"phase.implement.failed.CTL-906"' "${CATALYST_DIR}/events/"; then
	fail "--dry-run emitted a phase.*.failed event"
else
	pass "--dry-run emits no phase.*.failed event"
fi
unset CATALYST_DIR
scratch_teardown

echo "test (CTL-511): phase signal still flips to stalled when EMIT_COMPLETE is missing"
# The signal-file write must not depend on the event emit. If EMIT_COMPLETE
# resolution breaks, recovery must degrade to the slow path — not silently
# leave the signal frozen.
scratch_setup
export CATALYST_DIR="${SCRATCH}/catalyst"
mkdir -p "${CATALYST_DIR}/events"
make_phase_signal "CTL-908" "verify" "running" "bg-ctl511-e"
export CATALYST_HEALTHCHECK_JOBS_ROOT="${SCRATCH}/jobs"
mkdir -p "${SCRATCH}/jobs"
export CATALYST_EMIT_COMPLETE="${SCRATCH}/no-such-emit-complete"
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >/dev/null 2>&1
ST=$(phase_status "CTL-908" "verify")
if [ "$ST" = "stalled" ]; then
	pass "signal still reaches stalled when EMIT_COMPLETE is missing (stall write independent of emit)"
else
	fail "signal flip depends on EMIT_COMPLETE" "got: $ST"
fi
unset CATALYST_DIR CATALYST_EMIT_COMPLETE
scratch_teardown

echo "test (CTL-511 Phase 4): healthcheck is idempotent — two runs emit exactly one phase.*.failed"
# Phase 4 wires healthcheck into every reactive scan; its safety rests on
# idempotency. The second run must see status="stalled" (a terminal state) and
# skip — emitting no duplicate event, so the reactive-scan call site cannot
# cause a wake storm.
scratch_setup
export CATALYST_DIR="${SCRATCH}/catalyst"
mkdir -p "${CATALYST_DIR}/events"
make_phase_signal "CTL-907" "monitor-merge" "running" "bg-ctl511-d"
export CATALYST_HEALTHCHECK_JOBS_ROOT="${SCRATCH}/jobs"
mkdir -p "${SCRATCH}/jobs"
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >/dev/null 2>&1
"$HEALTHCHECK" --orch-dir "$ORCH_DIR" --orch-id "demo" --grace-seconds 0 >/dev/null 2>&1
EVT_COUNT=$(grep -rhs '"phase.monitor-merge.failed.CTL-907"' "${CATALYST_DIR}/events/" | wc -l | tr -d ' ')
if [ "$EVT_COUNT" = "1" ]; then
	pass "two healthcheck runs emit exactly one phase.*.failed (stalled signal skipped on rerun)"
else
	fail "healthcheck not idempotent across runs" "phase.*.failed count=$EVT_COUNT (expected 1)"
fi
unset CATALYST_DIR
scratch_teardown

# ─── CTL-511 Phase 4: orchestrate-healthcheck runs on every reactive scan ───
# A phase agent that dies after launch is detected only when orchestrate-healthcheck
# next scans it. Wiring it into the orchestrator's reactive scan (every wake +
# the 10-min idle fallback) bounds detection latency to one scan interval
# instead of the once-per-wave-only behavior. Doc-placement assertion in the
# style of the repo's other docs-drift tests.
echo "test (CTL-511 Phase 4): SKILL.md runs orchestrate-healthcheck in the reactive scan, not only per-wave"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/orchestrate/SKILL.md"
if [ ! -f "$SKILL_MD" ]; then
	fail "orchestrate/SKILL.md not found at $SKILL_MD"
else
	HC_COUNT=$(grep -c 'scripts/orchestrate-healthcheck' "$SKILL_MD")
	if [ "$HC_COUNT" -ge 2 ]; then
		pass "SKILL.md invokes orchestrate-healthcheck beyond the once-per-wave dispatch (count=$HC_COUNT)"
	else
		fail "orchestrate-healthcheck still appears only once (per-wave only)" "count=$HC_COUNT"
	fi
fi

echo
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
