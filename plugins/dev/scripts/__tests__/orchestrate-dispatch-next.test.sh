#!/usr/bin/env bash
# Shell tests for orchestrate-dispatch-next (CTL-116).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-dispatch-next.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/orchestrate-dispatch-next"

FAILURES=0
PASSES=0

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -ge 2 ] && echo "    $2"
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

scratch_setup() {
	SCRATCH="$(mktemp -d)"
	ORCH_DIR="${SCRATCH}/orch"
	WORKTREE_ROOT="${SCRATCH}/wt"
	mkdir -p "${ORCH_DIR}/workers/output" "${SCRATCH}/bin" "${WORKTREE_ROOT}"

	# Fake catalyst-state.sh — logs argv so tests can assert.
	cat >"${SCRATCH}/bin/catalyst-state.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATE_LOG"
EOF
	chmod +x "${SCRATCH}/bin/catalyst-state.sh"
	export STATE_LOG="${SCRATCH}/state.log"
	: >"$STATE_LOG"
	export CATALYST_STATE_SCRIPT="${SCRATCH}/bin/catalyst-state.sh"

	# Fake claude binary — logs argv + env then sleeps so kill-0 sees a live PID.
	cat >"${SCRATCH}/bin/claude" <<'EOF'
#!/usr/bin/env bash
{
  echo "---"
  echo "pid=$$"
  echo "cwd=$(pwd)"
  echo "ORCH_DIR=${CATALYST_ORCHESTRATOR_DIR:-}"
  echo "ORCH_ID=${CATALYST_ORCHESTRATOR_ID:-}"
  echo "COMMS=${CATALYST_COMMS_CHANNEL:-}"
  echo "SESSION=${CATALYST_SESSION_ID:-}"
  echo "OTEL=${OTEL_RESOURCE_ATTRIBUTES:-}"
  echo "args: $*"
} >> "$CLAUDE_LOG"
sleep 30 &
disown $! 2>/dev/null || true
EOF
	chmod +x "${SCRATCH}/bin/claude"
	export CLAUDE_LOG="${SCRATCH}/claude.log"
	: >"$CLAUDE_LOG"
	export CATALYST_DISPATCH_CLAUDE_BIN="${SCRATCH}/bin/claude"

	# Disable the post-dispatch healthcheck in tests (would try to re-read signals
	# and might interfere with assertions). The script honors an empty env var.
	export CATALYST_DISPATCH_HEALTHCHECK=""
}

scratch_teardown() {
	pkill -f "sleep 30" 2>/dev/null || true
	rm -rf "$SCRATCH"
	unset STATE_LOG CLAUDE_LOG CATALYST_STATE_SCRIPT CATALYST_DISPATCH_CLAUDE_BIN
	unset CATALYST_DISPATCH_HEALTHCHECK SCRATCH ORCH_DIR WORKTREE_ROOT
}

# write_state ORCH_ID MAX_PARALLEL JQ_QUEUE
# Writes a minimal state.json into ORCH_DIR with the given orchestrator name,
# maxParallel, and a .queue object supplied as a JSON literal.
write_state() {
	local orch="$1" mp="$2" queue="$3"
	cat >"${ORCH_DIR}/state.json" <<EOF
{
  "orchestrator": "${orch}",
  "startedAt": "$(now_iso)",
  "baseBranch": "main",
  "worktreeBase": "${WORKTREE_ROOT}",
  "maxParallel": ${mp},
  "totalWaves": 3,
  "currentWave": 1,
  "queue": ${queue},
  "workers": {}
}
EOF
}

# make_worktree ORCH_ID TICKET — create an empty directory so the dispatcher's
# worktree existence check passes.
make_worktree() {
	mkdir -p "${WORKTREE_ROOT}/${1}-${2}"
}

# make_running_signal TICKET STATUS — seed a pre-existing signal so the
# running-count logic observes it.
make_running_signal() {
	local t="$1" s="$2"
	jq -n --arg t "$t" --arg s "$s" --arg ts "$(now_iso)" \
		'{ticket: $t, orchestrator: "demo", workerName: ("demo-" + $t),
      label: ("oneshot " + $t), status: $s, phase: 3,
      startedAt: $ts, updatedAt: $ts}' \
		>"${ORCH_DIR}/workers/${t}.json"
}

run_dispatch() {
	"$DISPATCH" --orch-dir "$ORCH_DIR" "$@"
}

# make_phase_signal TICKET PHASE STATUS — seed a nested phase-mode signal at
# workers/<T>/phase-<PHASE>.json so the phase-aware running counter (CTL-605
# Bug 2) observes it.
make_phase_signal() {
	local t="$1" p="$2" s="$3"
	mkdir -p "${ORCH_DIR}/workers/${t}"
	jq -n --arg t "$t" --arg p "$p" --arg s "$s" --arg ts "$(now_iso)" \
		'{ticket: $t, phase: $p, status: $s, updatedAt: $ts}' \
		>"${ORCH_DIR}/workers/${t}/phase-${p}.json"
}

# ─── Test cases ───────────────────────────────────────────────────────────────

echo "test 1: empty queue reports queueEmpty and exits 0"
scratch_setup
write_state "demo" 4 '{"wave1Pending": [], "wave2Pending": []}'
OUT=$(run_dispatch 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0" || fail "exit 0" "got rc=$RC stderr=$(cat "${SCRATCH}/err")"
echo "$OUT" | jq -e '.queueEmpty == true' >/dev/null && pass "queueEmpty=true" || fail "queueEmpty=true" "got: $OUT"
echo "$OUT" | jq -e '.dispatched == []' >/dev/null && pass "dispatched empty" || fail "dispatched empty" "got: $OUT"
[ ! -s "$CLAUDE_LOG" ] && pass "claude not invoked" || fail "claude not invoked"
scratch_teardown

echo "test 2: single wave — dispatches all up to maxParallel"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1", "T-2"]}'
make_worktree "demo" "T-1"
make_worktree "demo" "T-2"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1,T-2" ] && pass "dispatched T-1,T-2 in order" || fail "dispatched in order" "got: $DISPATCHED"
[ -f "${ORCH_DIR}/workers/T-1.json" ] && pass "signal T-1 created" || fail "signal T-1 created"
[ -f "${ORCH_DIR}/workers/T-2.json" ] && pass "signal T-2 created" || fail "signal T-2 created"
grep -q "oneshot" "$CLAUDE_LOG" && pass "claude invoked" || fail "claude invoked"
# Verify queue was drained
REMAINING=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
[ "$REMAINING" = "0" ] && pass "wave1Pending drained" || fail "wave1Pending drained" "remaining: $REMAINING"
# Verify signal carries expected fields
S1_STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/T-1.json")
S1_PHASE=$(jq -r '.phase' "${ORCH_DIR}/workers/T-1.json")
S1_LABEL=$(jq -r '.label' "${ORCH_DIR}/workers/T-1.json")
S1_WT=$(jq -r '.worktreePath' "${ORCH_DIR}/workers/T-1.json")
[ "$S1_STATUS" = "dispatched" ] && pass "T-1.status=dispatched" || fail "T-1.status=dispatched" "got: $S1_STATUS"
[ "$S1_PHASE" = "0" ] && pass "T-1.phase=0" || fail "T-1.phase=0" "got: $S1_PHASE"
[ "$S1_LABEL" = "oneshot T-1" ] && pass "T-1.label" || fail "T-1.label" "got: $S1_LABEL"
[ "$S1_WT" = "${WORKTREE_ROOT}/demo-T-1" ] && pass "T-1.worktreePath" || fail "T-1.worktreePath" "got: $S1_WT"
# Verify catalyst-state was called for dispatch
grep -q "worker demo T-1" "$STATE_LOG" && pass "state worker T-1 emitted" || fail "state worker T-1 emitted"
grep -q "event" "$STATE_LOG" && pass "state event emitted" || fail "state event emitted"
scratch_teardown

echo "test 3: three waves drain in numeric order (1 → 2 → 3)"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["A"], "wave2Pending": ["B"], "wave3Pending": ["C", "D"]}'
for T in A B C D; do make_worktree "demo" "$T"; done
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "A,B,C,D" ] && pass "drains waves in order" || fail "drains waves in order" "got: $DISPATCHED"
for T in A B C D; do
	[ -f "${ORCH_DIR}/workers/${T}.json" ] && pass "$T signal created" || fail "$T signal created"
done
scratch_teardown

echo "test 4: dynamic waveN enumeration — wave5, wave10 also drain"
scratch_setup
write_state "demo" 4 '{"wave1Pending": [], "wave5Pending": ["X-5"], "wave10Pending": ["X-10"]}'
make_worktree "demo" "X-5"
make_worktree "demo" "X-10"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
# Wave 5 before wave 10 (numeric sort, not lexicographic)
[ "$DISPATCHED" = "X-5,X-10" ] && pass "wave5 before wave10 (numeric order)" || fail "wave5 before wave10" "got: $DISPATCHED"
[ -f "${ORCH_DIR}/workers/X-5.json" ] && pass "X-5 dispatched" || fail "X-5 dispatched"
[ -f "${ORCH_DIR}/workers/X-10.json" ] && pass "X-10 dispatched" || fail "X-10 dispatched"
scratch_teardown

echo "test 5: respects maxParallel across waves"
scratch_setup
write_state "demo" 2 '{"wave1Pending": ["A", "B"], "wave2Pending": ["C"], "wave3Pending": ["D"]}'
for T in A B C D; do make_worktree "demo" "$T"; done
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "A,B" ] && pass "only 2 dispatched" || fail "only 2 dispatched" "got: $DISPATCHED"
REMAINING_1=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
REMAINING_2=$(jq -r '.queue.wave2Pending | length' "${ORCH_DIR}/state.json")
REMAINING_3=$(jq -r '.queue.wave3Pending | length' "${ORCH_DIR}/state.json")
[ "$REMAINING_1" = "0" ] && pass "wave1 drained" || fail "wave1 drained" "$REMAINING_1"
[ "$REMAINING_2" = "1" ] && pass "wave2 untouched" || fail "wave2 untouched" "$REMAINING_2"
[ "$REMAINING_3" = "1" ] && pass "wave3 untouched" || fail "wave3 untouched" "$REMAINING_3"
scratch_teardown

echo "test 6: respects already-running workers"
scratch_setup
write_state "demo" 3 '{"wave1Pending": ["A", "B"]}'
make_running_signal "RUN-1" "implementing"
make_running_signal "RUN-2" "pr-created"
make_worktree "demo" "A"
make_worktree "demo" "B"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
RUNNING=$(echo "$OUT" | jq -r '.running')
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$RUNNING" = "2" ] && pass "running=2 counted" || fail "running=2 counted" "got: $RUNNING"
[ "$DISPATCHED" = "A" ] && pass "only 1 new dispatched (maxParallel=3)" || fail "only 1 new dispatched" "got: $DISPATCHED"
scratch_teardown

echo "test 7: terminal workers don't count toward running"
scratch_setup
write_state "demo" 2 '{"wave1Pending": ["A", "B"]}'
make_running_signal "DONE-1" "done"
make_running_signal "FAIL-1" "failed"
make_running_signal "STALL-1" "stalled"
make_worktree "demo" "A"
make_worktree "demo" "B"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "A,B" ] && pass "both dispatched — terminals ignored" || fail "both dispatched" "got: $DISPATCHED"
scratch_teardown

echo "test 8: skips tickets whose worktree is missing"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["A", "MISSING", "B"]}'
make_worktree "demo" "A"
make_worktree "demo" "B"
# MISSING deliberately has no worktree
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "A,B" ] && pass "A and B dispatched, MISSING skipped" || fail "A and B dispatched, MISSING skipped" "got: $DISPATCHED"
grep -qi "MISSING" "${SCRATCH}/err" && pass "stderr mentions missing worktree" || fail "stderr mentions missing" "stderr: $(cat "${SCRATCH}/err")"
# MISSING stays in wave1Pending
jq -e '.queue.wave1Pending | contains(["MISSING"])' "${ORCH_DIR}/state.json" >/dev/null &&
	pass "MISSING left in queue" || fail "MISSING left in queue"
scratch_teardown

echo "test 9: idempotent — skips tickets that already have a signal"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["PRE-1", "NEW-1"]}'
make_running_signal "PRE-1" "researching"
make_worktree "demo" "PRE-1"
make_worktree "demo" "NEW-1"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "NEW-1" ] && pass "only NEW-1 dispatched" || fail "only NEW-1 dispatched" "got: $DISPATCHED"
# PRE-1 signal's status is preserved
PRE_STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/PRE-1.json")
[ "$PRE_STATUS" = "researching" ] && pass "PRE-1 signal untouched" || fail "PRE-1 signal untouched" "got: $PRE_STATUS"
scratch_teardown

echo "test 10: --dry-run makes no state changes"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$(run_dispatch --dry-run 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "dispatched list reports T-1" || fail "dispatched list reports T-1" "got: $DISPATCHED"
[ ! -f "${ORCH_DIR}/workers/T-1.json" ] && pass "no signal file created" || fail "no signal file created"
[ ! -s "$CLAUDE_LOG" ] && pass "claude not invoked" || fail "claude not invoked"
REMAINING=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
[ "$REMAINING" = "1" ] && pass "queue untouched" || fail "queue untouched" "remaining: $REMAINING"
scratch_teardown

echo "test 11: no slots available → exits 0 with slots=0, no dispatches"
scratch_setup
write_state "demo" 2 '{"wave1Pending": ["A"]}'
make_running_signal "R1" "implementing"
make_running_signal "R2" "validating"
make_worktree "demo" "A"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 when full" || fail "exit 0 when full"
echo "$OUT" | jq -e '.slotsAfter == 0 and .dispatched == []' >/dev/null &&
	pass "slotsAfter=0 dispatched=[]" || fail "slotsAfter=0 dispatched=[]" "got: $OUT"
[ ! -f "${ORCH_DIR}/workers/A.json" ] && pass "A not dispatched" || fail "A not dispatched"
scratch_teardown

echo "test 12: ticket removed only from the wave it came from (not from others)"
scratch_setup
# Put a ticket "DUP" only in wave3Pending; verify wave1/wave2 untouched.
write_state "demo" 4 '{"wave1Pending": ["W1"], "wave2Pending": ["W2"], "wave3Pending": ["DUP"]}'
make_worktree "demo" "W1"
make_worktree "demo" "W2"
make_worktree "demo" "DUP"
run_dispatch 2>"${SCRATCH}/err" >/dev/null
W1_LEN=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
W2_LEN=$(jq -r '.queue.wave2Pending | length' "${ORCH_DIR}/state.json")
W3_LEN=$(jq -r '.queue.wave3Pending | length' "${ORCH_DIR}/state.json")
[ "$W1_LEN" = "0" ] && pass "wave1 drained to 0" || fail "wave1 drained" "$W1_LEN"
[ "$W2_LEN" = "0" ] && pass "wave2 drained to 0" || fail "wave2 drained" "$W2_LEN"
[ "$W3_LEN" = "0" ] && pass "wave3 drained to 0" || fail "wave3 drained" "$W3_LEN"
scratch_teardown

echo "test 13: env/args forwarded to claude"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
run_dispatch --session-id "sess-abc" --worker-command "/catalyst-dev:oneshot" \
	--worker-args "--auto-merge --extra" 2>"${SCRATCH}/err" >/dev/null
grep -q "ORCH_ID=demo" "$CLAUDE_LOG" && pass "ORCH_ID forwarded" || fail "ORCH_ID forwarded" "log: $(cat "$CLAUDE_LOG")"
grep -q "ORCH_DIR=${ORCH_DIR}" "$CLAUDE_LOG" && pass "ORCH_DIR forwarded" || fail "ORCH_DIR forwarded"
grep -q "SESSION=sess-abc" "$CLAUDE_LOG" && pass "SESSION_ID forwarded" || fail "SESSION_ID forwarded"
# CTL-373: channel name is the orch-id directly (legacy was `orch-${orch-id}`).
grep -q "COMMS=demo" "$CLAUDE_LOG" && pass "COMMS channel forwarded (default = orch-id)" || fail "COMMS channel forwarded"
grep -q -- "T-1 --auto-merge --extra" "$CLAUDE_LOG" && pass "worker args forwarded" || fail "worker args forwarded" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test 14: --orch-id override takes precedence over state.json"
scratch_setup
write_state "stateorch" 4 '{"wave1Pending": ["T-1"]}'
mkdir -p "${WORKTREE_ROOT}/cliorch-T-1"
run_dispatch --orch-id "cliorch" 2>"${SCRATCH}/err" >/dev/null
[ -f "${ORCH_DIR}/workers/T-1.json" ] && pass "signal created with override" || fail "signal created with override"
SIGNAL_ORCH=$(jq -r '.orchestrator' "${ORCH_DIR}/workers/T-1.json")
[ "$SIGNAL_ORCH" = "cliorch" ] && pass "signal.orchestrator=cliorch" || fail "signal.orchestrator=cliorch" "got: $SIGNAL_ORCH"
SIGNAL_WT=$(jq -r '.worktreePath' "${ORCH_DIR}/workers/T-1.json")
[ "$SIGNAL_WT" = "${WORKTREE_ROOT}/cliorch-T-1" ] && pass "worktreePath uses cli orch-id" || fail "worktreePath uses cli orch-id" "got: $SIGNAL_WT"
scratch_teardown

echo "test 15: missing --orch-dir fails with non-zero exit"
OUT=$("$DISPATCH" 2>&1)
RC=$?
[ "$RC" != "0" ] && pass "exits non-zero without --orch-dir" || fail "exits non-zero" "got rc=$RC"

echo "test 15b: --help prints the full usage block (concurrency note present)"
OUT=$("$DISPATCH" --help 2>&1)
echo "$OUT" | grep -q "Concurrency:" && pass "help shows concurrency note" || fail "help shows concurrency note" "got: $OUT"
echo "$OUT" | grep -q "CATALYST_DISPATCH_HEALTHCHECK" && pass "help shows env overrides" || fail "help shows env overrides"

echo "test 16: missing state.json fails"
scratch_setup
# No state.json
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" 2>&1)
RC=$?
[ "$RC" != "0" ] && pass "exits non-zero when state.json missing" || fail "exits non-zero when state.json missing"
scratch_teardown

echo "test 17: no .queue key → treated as empty queue"
scratch_setup
cat >"${ORCH_DIR}/state.json" <<EOF
{"orchestrator": "demo", "worktreeBase": "${WORKTREE_ROOT}", "maxParallel": 2}
EOF
OUT=$(run_dispatch 2>"${SCRATCH}/err")
echo "$OUT" | jq -e '.queueEmpty == true' >/dev/null &&
	pass "queueEmpty when .queue missing" || fail "queueEmpty when .queue missing" "got: $OUT"
scratch_teardown

echo "test 18 (CTL-208): rejects bare /oneshot worker-command with exit 2"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$(run_dispatch --worker-command "/oneshot" 2>&1)
RC=$?
[ "$RC" = "2" ] && pass "exit code 2 on bare /oneshot" || fail "exit code 2 on bare /oneshot" "got rc=$RC"
echo "$OUT" | grep -q "plugin-namespaced" &&
	pass "stderr mentions plugin-namespaced" ||
	fail "stderr mentions plugin-namespaced" "got: $OUT"
echo "$OUT" | grep -q "/catalyst-dev:oneshot" &&
	pass "stderr suggests /catalyst-dev:oneshot" ||
	fail "stderr suggests /catalyst-dev:oneshot"
[ ! -f "${ORCH_DIR}/workers/T-1.json" ] && pass "no signal created when rejected" || fail "no signal created"
[ ! -s "$CLAUDE_LOG" ] && pass "claude not invoked when rejected" || fail "claude not invoked"
scratch_teardown

echo "test 19 (CTL-208): rejects empty workerCommand with exit 2"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$(run_dispatch --worker-command "" 2>&1)
RC=$?
[ "$RC" = "2" ] && pass "exit code 2 on empty worker-command" || fail "exit code 2 on empty" "got rc=$RC"
scratch_teardown

echo "test 20 (CTL-208): accepts properly namespaced worker-command"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$(run_dispatch --worker-command "/catalyst-dev:oneshot" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 on /catalyst-dev:oneshot" || fail "exit 0 on /catalyst-dev:oneshot" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
[ -f "${ORCH_DIR}/workers/T-1.json" ] && pass "signal created" || fail "signal created"
scratch_teardown

echo "test 21 (CTL-208): signal file records wave number from source waveN key"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["A"], "wave2Pending": ["B"], "wave3Pending": ["C"]}'
for T in A B C; do make_worktree "demo" "$T"; done
run_dispatch 2>"${SCRATCH}/err" >/dev/null
A_WAVE=$(jq -r '.wave' "${ORCH_DIR}/workers/A.json")
B_WAVE=$(jq -r '.wave' "${ORCH_DIR}/workers/B.json")
C_WAVE=$(jq -r '.wave' "${ORCH_DIR}/workers/C.json")
[ "$A_WAVE" = "1" ] && pass "A.wave=1" || fail "A.wave=1" "got: $A_WAVE"
[ "$B_WAVE" = "2" ] && pass "B.wave=2" || fail "B.wave=2" "got: $B_WAVE"
[ "$C_WAVE" = "3" ] && pass "C.wave=3" || fail "C.wave=3" "got: $C_WAVE"
# wave is an integer, not a string
A_WAVE_TYPE=$(jq -r '.wave | type' "${ORCH_DIR}/workers/A.json")
[ "$A_WAVE_TYPE" = "number" ] && pass "wave is number type" || fail "wave is number type" "got: $A_WAVE_TYPE"
scratch_teardown

echo "test 22 (CTL-208): signal file records wave for non-contiguous wave numbers"
scratch_setup
write_state "demo" 4 '{"wave5Pending": ["X"], "wave10Pending": ["Y"]}'
make_worktree "demo" "X"
make_worktree "demo" "Y"
run_dispatch 2>"${SCRATCH}/err" >/dev/null
X_WAVE=$(jq -r '.wave' "${ORCH_DIR}/workers/X.json")
Y_WAVE=$(jq -r '.wave' "${ORCH_DIR}/workers/Y.json")
[ "$X_WAVE" = "5" ] && pass "X.wave=5" || fail "X.wave=5" "got: $X_WAVE"
[ "$Y_WAVE" = "10" ] && pass "Y.wave=10" || fail "Y.wave=10" "got: $Y_WAVE"
scratch_teardown

echo "test 23 (CTL-334): worker subshell does not inherit parent herestring stdin"
scratch_setup
# Replace the fake claude with one that captures its own stdin to a per-pid
# file. With the stdin leak, the first worker(s) would see the leftover
# `<wave>\t<ticket>` rows from the dispatcher's `done <<< "$PENDING"` loop.
cat >"${SCRATCH}/bin/claude" <<EOF2
#!/usr/bin/env bash
# Drain stdin into a deterministic file so the test can inspect it.
cat <&0 > "${SCRATCH}/stdin-\$\$.log" 2>/dev/null || true
sleep 30 &
disown \$! 2>/dev/null || true
EOF2
chmod +x "${SCRATCH}/bin/claude"
write_state "demo" 4 '{"wave1Pending": ["T-1", "T-2", "T-3"]}'
for T in T-1 T-2 T-3; do make_worktree "demo" "$T"; done
OUT=$(run_dispatch 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1,T-2,T-3" ] && pass "all 3 dispatched in one call" ||
	fail "all 3 dispatched in one call" "got: $DISPATCHED (stdin leak symptom: only first N-1 dispatched)"
# Every captured stdin file must be empty (no inherited herestring content).
LEAK_COUNT=0
for SF in "${SCRATCH}"/stdin-*.log; do
	[ -e "$SF" ] || continue
	if [ -s "$SF" ]; then
		LEAK_COUNT=$((LEAK_COUNT + 1))
		echo "    LEAK in $SF: $(head -c 200 "$SF")" >&2
	fi
done
[ "$LEAK_COUNT" = "0" ] && pass "no worker received leftover herestring on stdin" ||
	fail "no worker received leftover herestring on stdin" "$LEAK_COUNT worker(s) saw stdin content"
scratch_teardown

# ─── CTL-452: --ticket flag + dispatchMode tests ─────────────────────────────

# phase_agent_dispatch_setup — install a stub phase-agent-dispatch on $PATH
# (via CATALYST_PHASE_AGENT_DISPATCH env var) that logs argv + a fake stdout
# summary instead of actually spawning claude --bg.
phase_agent_dispatch_setup() {
	cat >"${SCRATCH}/bin/phase-agent-dispatch" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$PHASE_DISPATCH_LOG"
# Write the per-phase signal so the dispatcher's idempotency check sees it on
# subsequent invocations — mirrors what the real helper does.
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
  echo "{\"ticket\":\"${TICKET}\",\"phase\":\"${PHASE}\",\"status\":\"dispatched\",\"bg_job_id\":\"fake-${TICKET}-${PHASE}\"}" \
    > "${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
fi
echo "{\"ticket\":\"${TICKET}\",\"phase\":\"${PHASE}\",\"bg_job_id\":\"fake-${TICKET}-${PHASE}\",\"status\":\"running\"}"
EOF
	chmod +x "${SCRATCH}/bin/phase-agent-dispatch"
	export PHASE_DISPATCH_LOG="${SCRATCH}/phase-dispatch.log"
	: >"$PHASE_DISPATCH_LOG"
	export CATALYST_PHASE_AGENT_DISPATCH="${SCRATCH}/bin/phase-agent-dispatch"
}

# write_config DISPATCH_MODE — drop a minimal .catalyst/config.json at $SCRATCH/.catalyst
# and return the absolute path. Caller passes via --config.
write_config() {
	local mode="$1"
	mkdir -p "${SCRATCH}/.catalyst"
	cat >"${SCRATCH}/.catalyst/config.json" <<EOF
{"catalyst": {"orchestration": {"dispatchMode": "${mode}"}}}
EOF
	echo "${SCRATCH}/.catalyst/config.json"
}

# phase_agent_dispatch_drain_setup — like phase_agent_dispatch_setup, but the
# stub also drains its own stdin to a per-pid file. This models the real bug:
# phase-agent-dispatch synchronously launches `claude --bg` with fd 0 inherited,
# which drains the dispatch loop's `done <<<"$PENDING"` herestring. With the leak
# (missing </dev/null on the caller's command substitution) the leftover
# `<wave>\t<ticket>` rows land in stdin-<pid>.log here and the outer loop stops
# after the first ticket. Used by the CTL-605 Bug 1 regression test.
phase_agent_dispatch_drain_setup() {
	cat >"${SCRATCH}/bin/phase-agent-dispatch" <<'EOF'
#!/usr/bin/env bash
cat <&0 > "${PHASE_STDIN_DIR}/stdin-$$.log" 2>/dev/null || true
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
  echo "{\"ticket\":\"${TICKET}\",\"phase\":\"${PHASE}\",\"status\":\"dispatched\"}" \
    > "${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
fi
echo "{\"ticket\":\"${TICKET}\",\"phase\":\"${PHASE}\",\"bg_job_id\":\"fake-${TICKET}\",\"status\":\"running\"}"
EOF
	chmod +x "${SCRATCH}/bin/phase-agent-dispatch"
	export PHASE_DISPATCH_LOG="${SCRATCH}/phase-dispatch.log"
	: >"$PHASE_DISPATCH_LOG"
	export PHASE_STDIN_DIR="${SCRATCH}/phase-stdin"
	mkdir -p "$PHASE_STDIN_DIR"
	export CATALYST_PHASE_AGENT_DISPATCH="${SCRATCH}/bin/phase-agent-dispatch"
}

echo "test 24 (CTL-452): --ticket without --phase exits 2"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" 2>&1)
RC=$?
[ "$RC" = "2" ] && pass "exit 2 on --ticket without --phase" || fail "exit 2 on --ticket without --phase" "rc=$RC"
echo "$OUT" | grep -qi "phase" && pass "stderr mentions phase" || fail "stderr mentions phase" "got: $OUT"
scratch_teardown

echo "test 25 (CTL-452): --ticket T-1 --phase research dispatches one ticket; wave queue untouched"
scratch_setup
phase_agent_dispatch_setup
# Wave queue does NOT contain T-1 — proves single-ticket targeting bypasses queue.
write_state "demo" 4 '{"wave1Pending": ["UNRELATED-1", "UNRELATED-2"]}'
make_worktree "demo" "T-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 on single-ticket phase dispatch" || fail "exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "dispatched=[T-1]" || fail "dispatched=[T-1]" "got: $DISPATCHED"
grep -q -- "--phase research" "$PHASE_DISPATCH_LOG" && pass "phase-agent-dispatch called with --phase research" || fail "phase-agent-dispatch called with --phase research" "log: $(cat "$PHASE_DISPATCH_LOG")"
grep -q -- "--ticket T-1" "$PHASE_DISPATCH_LOG" && pass "phase-agent-dispatch called with --ticket T-1" || fail "phase-agent-dispatch called with --ticket T-1"
# Wave queue untouched
W1_LEN=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
[ "$W1_LEN" = "2" ] && pass "wave queue untouched (single-ticket mode)" || fail "wave queue untouched" "$W1_LEN"
[ ! -s "$CLAUDE_LOG" ] && pass "claude (legacy oneshot) not invoked" || fail "claude (legacy oneshot) not invoked"
scratch_teardown

echo "test 26 (CTL-452): --ticket --phase is idempotent when per-phase signal exists"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
# Pre-create the per-phase signal — dispatcher should see it and no-op.
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"research","status":"running"}' >"${ORCH_DIR}/workers/T-1/phase-research.json"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 on idempotent" || fail "exit 0 on idempotent" "rc=$RC"
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "" ] && pass "dispatched=[] on idempotent" || fail "dispatched=[] on idempotent" "got: $DISPATCHED"
[ ! -s "$PHASE_DISPATCH_LOG" ] && pass "phase-agent-dispatch NOT called on idempotent" || fail "phase-agent-dispatch NOT called on idempotent" "log: $(cat "$PHASE_DISPATCH_LOG")"
scratch_teardown

echo "test 26b (CTL-604): re-dispatches when per-phase signal is failed (not just file-exists)"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
mkdir -p "${ORCH_DIR}/workers/T-1"
# A failed signal must NOT block re-dispatch — a dead worker that never
# recovered should be relaunched, not stranded on mere file existence.
echo '{"ticket":"T-1","phase":"research","status":"failed"}' >"${ORCH_DIR}/workers/T-1/phase-research.json"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 on failed re-dispatch" || fail "exit 0 on failed re-dispatch" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "failed per-phase signal re-dispatched" || fail "failed per-phase signal re-dispatched" "got: $DISPATCHED"
grep -q -- "--ticket T-1" "$PHASE_DISPATCH_LOG" && pass "phase-agent-dispatch called for failed re-dispatch" || fail "phase-agent-dispatch called for failed re-dispatch" "log: $(cat "$PHASE_DISPATCH_LOG")"
scratch_teardown

echo "test 26c (CTL-604): re-dispatches when per-phase signal is stalled"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"research","status":"stalled"}' >"${ORCH_DIR}/workers/T-1/phase-research.json"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "stalled per-phase signal re-dispatched" || fail "stalled per-phase signal re-dispatched" "got: $DISPATCHED"
scratch_teardown

echo "test 26d (CTL-604): does NOT re-dispatch a done per-phase signal"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"research","status":"done"}' >"${ORCH_DIR}/workers/T-1/phase-research.json"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "" ] && pass "done per-phase signal NOT re-dispatched" || fail "done per-phase signal NOT re-dispatched" "got: $DISPATCHED"
[ ! -s "$PHASE_DISPATCH_LOG" ] && pass "phase-agent-dispatch NOT called for done signal" || fail "phase-agent-dispatch NOT called for done signal" "log: $(cat "$PHASE_DISPATCH_LOG")"
scratch_teardown

echo "test 27 (CTL-452): dispatchMode=phase-agents in config — wave dispatches default phase=triage"
scratch_setup
phase_agent_dispatch_setup
CONFIG_PATH=$(write_config "phase-agents")
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$CONFIG_PATH" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 with dispatchMode=phase-agents" || fail "exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "dispatched=[T-1] via phase-agents mode" || fail "dispatched=[T-1] via phase-agents mode" "got: $DISPATCHED"
grep -q -- "--phase triage" "$PHASE_DISPATCH_LOG" && pass "default phase=triage when dispatchMode=phase-agents" || fail "default phase=triage when dispatchMode=phase-agents" "log: $(cat "$PHASE_DISPATCH_LOG")"
[ ! -s "$CLAUDE_LOG" ] && pass "claude (legacy oneshot) not invoked in phase-agents mode" || fail "claude not invoked in phase-agents mode"
# Queue should be drained
W1_LEN=$(jq -r '.queue.wave1Pending | length' "${ORCH_DIR}/state.json")
[ "$W1_LEN" = "0" ] && pass "wave1 queue drained in phase-agents mode" || fail "wave1 queue drained" "$W1_LEN"
scratch_teardown

echo "test 28 (CTL-452): dispatchMode=oneshot-legacy in config — wave uses legacy oneshot path"
scratch_setup
phase_agent_dispatch_setup
CONFIG_PATH=$(write_config "oneshot-legacy")
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$CONFIG_PATH" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 with dispatchMode=oneshot-legacy" || fail "exit 0" "rc=$RC"
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "dispatched=[T-1] via legacy mode" || fail "dispatched=[T-1] via legacy mode" "got: $DISPATCHED"
grep -q "oneshot" "$CLAUDE_LOG" && pass "claude (legacy oneshot) invoked" || fail "claude (legacy oneshot) invoked" "log: $(cat "$CLAUDE_LOG")"
[ ! -s "$PHASE_DISPATCH_LOG" ] && pass "phase-agent-dispatch NOT invoked in legacy mode" || fail "phase-agent-dispatch NOT invoked in legacy mode"
scratch_teardown

echo "test 29 (CTL-452): no config + no --phase → defaults to legacy oneshot (backward compat)"
scratch_setup
phase_agent_dispatch_setup
# No --config flag, no .catalyst/config.json — should fall through to existing oneshot behavior.
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 with no config (backward compat)" || fail "exit 0 no config" "rc=$RC"
grep -q "oneshot" "$CLAUDE_LOG" && pass "defaults to legacy oneshot when no dispatchMode" || fail "defaults to legacy oneshot when no dispatchMode"
[ ! -s "$PHASE_DISPATCH_LOG" ] && pass "phase-agent-dispatch NOT invoked when no dispatchMode" || fail "phase-agent-dispatch NOT invoked when no dispatchMode"
scratch_teardown

echo "test 30 (CTL-452): explicit --phase overrides dispatchMode=oneshot-legacy"
scratch_setup
phase_agent_dispatch_setup
CONFIG_PATH=$(write_config "oneshot-legacy")
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
# Explicit --phase always wins (orchestrator's phase-advance calls always set --phase)
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$CONFIG_PATH" --phase "implement" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "explicit --phase overrides legacy mode" || fail "exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
grep -q -- "--phase implement" "$PHASE_DISPATCH_LOG" && pass "phase-agent-dispatch called with --phase implement" || fail "phase-agent-dispatch called with --phase implement" "log: $(cat "$PHASE_DISPATCH_LOG")"
[ ! -s "$CLAUDE_LOG" ] && pass "claude (oneshot) NOT invoked when --phase explicit" || fail "claude NOT invoked when --phase explicit"
scratch_teardown

echo "test 31 (CTL-495): legacy oneshot path tags OTEL with task.type=oneshot"
scratch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
OUT=$(run_dispatch 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "legacy dispatch exit 0" || fail "legacy dispatch exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
grep -q "OTEL=.*task.type=oneshot" "$CLAUDE_LOG" &&
	pass "legacy claude inherits OTEL with task.type=oneshot" ||
	fail "legacy claude OTEL has task.type=oneshot" "log: $(cat "$CLAUDE_LOG")"
scratch_teardown

echo "test 32 (CTL-495): phase-agent path does NOT pre-set task.type in dispatch-next"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": ["T-1"]}'
make_worktree "demo" "T-1"
# Phase-agent path delegates to phase-agent-dispatch which owns its own OTEL
# composition; dispatch-next must NOT pre-tag (would idempotency-block the
# phase-specific value). We assert the stub-phase-agent-dispatch was invoked
# without dispatch-next having written OTEL_RESOURCE_ATTRIBUTES first.
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --phase "implement" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "phase dispatch exit 0" || fail "phase dispatch exit 0" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
# CLAUDE_LOG should be empty (phase path delegates to phase-agent-dispatch stub).
[ ! -s "$CLAUDE_LOG" ] && pass "phase path skips legacy claude stub" || fail "phase path skips legacy claude stub"
# phase-agent-dispatch stub was called — that helper does its own OTEL work.
grep -q -- "--phase implement" "$PHASE_DISPATCH_LOG" && pass "phase-agent-dispatch invoked" || fail "phase-agent-dispatch invoked"
scratch_teardown

echo "test 33 (CTL-554): dispatchMode=execution-core in config is accepted without a WARN"
scratch_setup
phase_agent_dispatch_setup
CONFIG_PATH=$(write_config "execution-core")
write_state "demo" 4 '{"wave1Pending": []}'
"$DISPATCH" --orch-dir "$ORCH_DIR" --config "$CONFIG_PATH" 2>"${SCRATCH}/err" >/dev/null
RC=$?
# if/then/else (not `&& pass || fail`) keeps the new lines shellcheck-SC2015-clean
if [ "$RC" = "0" ]; then pass "exit 0 with dispatchMode=execution-core"; else fail "exit 0" "rc=$RC"; fi
if ! grep -q "invalid dispatchMode" "${SCRATCH}/err"; then
	pass "no 'invalid dispatchMode' WARN for execution-core"
else
	fail "no WARN for execution-core" "stderr=$(cat "${SCRATCH}/err")"
fi
scratch_teardown

echo "test 34 (CTL-605 Bug 1): phase-agents multi-ticket wave dispatches all in one call; no stdin leak"
scratch_setup
phase_agent_dispatch_drain_setup
CONFIG_PATH=$(write_config "phase-agents")
write_state "demo" 4 '{"wave1Pending": ["T-1", "T-2", "T-3"]}'
for T in T-1 T-2 T-3; do make_worktree "demo" "$T"; done
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$CONFIG_PATH" 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | sort | join(",")')
[ "$DISPATCHED" = "T-1,T-2,T-3" ] && pass "all 3 dispatched in one phase-agents call" ||
	fail "all 3 dispatched in one phase-agents call" "got: $DISPATCHED (leak symptom: only first ticket)"
LEAK_COUNT=0
for SF in "${PHASE_STDIN_DIR}"/stdin-*.log; do
	[ -e "$SF" ] || continue
	if [ -s "$SF" ]; then
		LEAK_COUNT=$((LEAK_COUNT + 1))
		echo "    LEAK in $SF: $(head -c 200 "$SF")" >&2
	fi
done
[ "$LEAK_COUNT" = "0" ] && pass "no phase worker received leftover herestring on stdin" ||
	fail "no phase worker received leftover herestring on stdin" "$LEAK_COUNT saw stdin content"
scratch_teardown

echo "test 35 (CTL-605 Bug 2): nested phase signals count toward RUNNING and enforce maxParallel"
scratch_setup
phase_agent_dispatch_setup
CONFIG_PATH=$(write_config "phase-agents")
write_state "demo" 2 '{"wave1Pending": ["NEW-1"]}'
make_phase_signal "BUSY-A" "implement" "running"
make_phase_signal "BUSY-B" "research" "running"
make_worktree "demo" "NEW-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$CONFIG_PATH" 2>"${SCRATCH}/err")
RUNNING=$(echo "$OUT" | jq -r '.running')
[ "$RUNNING" = "2" ] && pass "nested in-flight counted (running=2)" || fail "running=2" "got: $RUNNING"
echo "$OUT" | jq -e '.slotsAfter == 0 and .dispatched == []' >/dev/null &&
	pass "cap enforced — no dispatch when full" || fail "cap enforced" "got: $OUT"
scratch_teardown

echo "test 36 (CTL-605 Bug 2): monitor-deploy done frees the slot"
scratch_setup
phase_agent_dispatch_setup
CONFIG_PATH=$(write_config "phase-agents")
write_state "demo" 1 '{"wave1Pending": ["NEW-1"]}'
make_phase_signal "SHIPPED" "monitor-deploy" "done"
make_worktree "demo" "NEW-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$CONFIG_PATH" 2>"${SCRATCH}/err")
[ "$(echo "$OUT" | jq -r '.running')" = "0" ] && pass "monitor-deploy done not counted" || fail "monitor-deploy done not counted" "$OUT"
[ "$(echo "$OUT" | jq -r '.dispatched | join(",")')" = "NEW-1" ] && pass "freed slot dispatched NEW-1" || fail "freed slot dispatched NEW-1" "$OUT"
scratch_teardown

echo "test 37 (CTL-605 Bug 2): mid-pipeline done (non-monitor) still holds slot"
scratch_setup
phase_agent_dispatch_setup
CONFIG_PATH=$(write_config "phase-agents")
write_state "demo" 1 '{"wave1Pending": ["NEW-1"]}'
make_phase_signal "MIDWAY" "implement" "done" # done, but not monitor-deploy
make_worktree "demo" "NEW-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$CONFIG_PATH" 2>"${SCRATCH}/err")
[ "$(echo "$OUT" | jq -r '.running')" = "1" ] && pass "mid-pipeline done still in-flight" || fail "mid-pipeline done still in-flight" "$OUT"
echo "$OUT" | jq -e '.dispatched == []' >/dev/null && pass "cap held — NEW-1 not dispatched" || fail "cap held" "$OUT"
scratch_teardown

echo "test 38 (CTL-605 Bug 2): failed/stalled phase is terminal (frees slot)"
scratch_setup
phase_agent_dispatch_setup
CONFIG_PATH=$(write_config "phase-agents")
write_state "demo" 1 '{"wave1Pending": ["NEW-1"]}'
make_phase_signal "BROKEN" "verify" "failed"
make_worktree "demo" "NEW-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --config "$CONFIG_PATH" 2>"${SCRATCH}/err")
[ "$(echo "$OUT" | jq -r '.running')" = "0" ] && pass "failed phase terminal" || fail "failed phase terminal" "$OUT"
scratch_teardown

echo "test 39 (CTL-605 Bug 2 / OQ2): single-ticket advance is NOT slot-gated when cap full"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 1 '{"wave1Pending": []}'
make_phase_signal "ADV-1" "implement" "running" # cap=1 already full
make_worktree "demo" "ADV-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "ADV-1" --phase "verify" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "advance exits 0 despite full cap" || fail "advance exits 0" "rc=$RC err=$(cat "${SCRATCH}/err")"
[ "$(echo "$OUT" | jq -r '.dispatched | join(",")')" = "ADV-1" ] && pass "advance dispatched despite full cap" || fail "advance dispatched" "$OUT"
grep -q -- "--phase verify" "$PHASE_DISPATCH_LOG" && pass "phase-agent-dispatch called for verify" || fail "verify dispatched" "$(cat "$PHASE_DISPATCH_LOG")"
scratch_teardown
echo "test 40 (CTL-604): --ticket --phase re-dispatches when per-phase signal is 'failed'"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
# Pre-existing signal at status:failed — a dead phase that never emitted complete.
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"research","status":"failed"}' >"${ORCH_DIR}/workers/T-1/phase-research.json"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
RC=$?
[ "$RC" = "0" ] && pass "exit 0 on failed re-dispatch" || fail "exit 0 on failed re-dispatch" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "failed signal IS re-dispatched" || fail "failed signal IS re-dispatched" "got: $DISPATCHED"
grep -q -- "--phase research" "$PHASE_DISPATCH_LOG" && pass "phase-agent-dispatch called for re-dispatch" || fail "phase-agent-dispatch called for re-dispatch" "log: $(cat "$PHASE_DISPATCH_LOG")"
scratch_teardown

echo "test 41 (CTL-604): --ticket --phase re-dispatches when per-phase signal is 'stalled'"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"plan","status":"stalled"}' >"${ORCH_DIR}/workers/T-1/phase-plan.json"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "plan" 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "stalled signal IS re-dispatched" || fail "stalled signal IS re-dispatched" "got: $DISPATCHED"
scratch_teardown

echo "test 42 (CTL-604): --ticket --phase still no-ops when per-phase signal is 'running'"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"research","status":"running"}' >"${ORCH_DIR}/workers/T-1/phase-research.json"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "" ] && pass "running signal NOT re-dispatched" || fail "running signal NOT re-dispatched" "got: $DISPATCHED"
[ ! -s "$PHASE_DISPATCH_LOG" ] && pass "phase-agent-dispatch NOT called for running" || fail "phase-agent-dispatch NOT called for running" "log: $(cat "$PHASE_DISPATCH_LOG")"
scratch_teardown

echo "test 43 (CTL-604): --ticket --phase still no-ops when per-phase signal is 'done'"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
mkdir -p "${ORCH_DIR}/workers/T-1"
echo '{"ticket":"T-1","phase":"research","status":"done"}' >"${ORCH_DIR}/workers/T-1/phase-research.json"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "" ] && pass "done signal NOT re-dispatched" || fail "done signal NOT re-dispatched" "got: $DISPATCHED"
scratch_teardown

echo "test 44 (CTL-611): phase-agent-dispatch failure emits phase.dispatch.failed event"
scratch_setup
# Install a stub phase-agent-dispatch that ALWAYS exits non-zero.
cat >"${SCRATCH}/bin/phase-agent-dispatch" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$PHASE_DISPATCH_LOG"
exit 1
EOF
chmod +x "${SCRATCH}/bin/phase-agent-dispatch"
export PHASE_DISPATCH_LOG="${SCRATCH}/phase-dispatch.log"
: >"$PHASE_DISPATCH_LOG"
export CATALYST_PHASE_AGENT_DISPATCH="${SCRATCH}/bin/phase-agent-dispatch"
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
RC=$?
# Exit code stays 0 — idempotency contract unchanged.
[ "$RC" = "0" ] && pass "exit 0 on phase-agent-dispatch failure (unchanged contract)" || fail "exit 0 on phase-agent-dispatch failure" "rc=$RC stderr=$(cat "${SCRATCH}/err")"
# Stdout shape unchanged — dispatched stays empty.
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "" ] && pass "dispatched=[] on failure (unchanged shape)" || fail "dispatched=[] on failure" "got: $DISPATCHED"
# State log gained exactly one phase.dispatch.failed.T-1 event.
COUNT=$(grep -c "phase.dispatch.failed.T-1" "$STATE_LOG" || true)
[ "$COUNT" = "1" ] && pass "exactly one phase.dispatch.failed.T-1 event" || fail "exactly one phase.dispatch.failed.T-1 event" "count=$COUNT log: $(cat "$STATE_LOG")"
grep -q "research" "$STATE_LOG" && pass "event carries toPhase=research" || fail "event carries toPhase=research" "log: $(cat "$STATE_LOG")"
scratch_teardown

echo "test 45 (CTL-611): successful phase-agent-dispatch does NOT emit phase.dispatch.failed"
scratch_setup
phase_agent_dispatch_setup
write_state "demo" 4 '{"wave1Pending": []}'
make_worktree "demo" "T-1"
OUT=$("$DISPATCH" --orch-dir "$ORCH_DIR" --ticket "T-1" --phase "research" 2>"${SCRATCH}/err")
DISPATCHED=$(echo "$OUT" | jq -r '.dispatched | join(",")')
[ "$DISPATCHED" = "T-1" ] && pass "dispatched=[T-1] on success" || fail "dispatched=[T-1] on success" "got: $DISPATCHED"
COUNT=$(grep -c "phase.dispatch.failed" "$STATE_LOG" || true)
[ "$COUNT" = "0" ] && pass "no phase.dispatch.failed event on success" || fail "no phase.dispatch.failed event on success" "count=$COUNT log: $(cat "$STATE_LOG")"
scratch_teardown

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
