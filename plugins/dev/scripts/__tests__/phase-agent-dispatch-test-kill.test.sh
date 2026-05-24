#!/usr/bin/env bash
# CTL-587: test-kill injection hook for phase-agent-dispatch + phase-implement/SKILL.md.
#
# Two modes via the `CATALYST_TEST_KILL_PHASE=<phase>:<mode>` env var:
#   before-launch  — phase-agent-dispatch aborts BEFORE the claude --bg spawn;
#                    signal goes stalled with attentionReason=test-kill-before-launch
#                    (exercises the escalation path in CTL-587 revive).
#   after-prelude  — phase-implement/SKILL.md prelude exits 137 AFTER flipping
#                    the signal to "running" but BEFORE any commit work (exercises
#                    the revive path: next reclaim tick sees a stale state.json,
#                    work-done probe returns false, dispatcher re-spawns).
#
# Run: bash plugins/dev/scripts/__tests__/phase-agent-dispatch-test-kill.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"
SKILL_MD="${REPO_ROOT}/plugins/dev/skills/phase-implement/SKILL.md"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t ctl-587-test-kill-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then pass "$label"
	else fail "$label — expected '$expected', got '$actual'"
	fi
}

if [[ ! -x $DISPATCH ]]; then
	echo "FATAL: $DISPATCH not found or not executable" >&2
	exit 1
fi

# ─── Stub claude binary (mirrors phase-agent-dispatch.test.sh) ──────────────
setup_claude_stub() {
	local stub_dir="$1"
	mkdir -p "$stub_dir"
	cat >"$stub_dir/claude" <<'STUB'
#!/usr/bin/env bash
LOG="${CLAUDE_STUB_LOG:-/tmp/claude-stub.log}"
JOB_ID="${CLAUDE_STUB_JOB_ID:-deadbeef}"
{ echo "--ARGS--"; printf '%s\n' "$@"; } > "$LOG"
cat <<EOF
backgrounded · ${JOB_ID}
EOF
exit "${CLAUDE_STUB_EXIT:-0}"
STUB
	chmod +x "$stub_dir/claude"
}

fresh_env() {
	local tag="$1"
	TEST_DIR="${SCRATCH}/${tag}"
	STUB_DIR="${TEST_DIR}/bin"
	ORCH_DIR="${TEST_DIR}/orch"
	WORKER_DIR="${ORCH_DIR}/workers/CTL-9"
	mkdir -p "$STUB_DIR" "$WORKER_DIR"
	# Stage the prior-artifact (plan file) so the implement gate passes.
	mkdir -p "${TEST_DIR}/proj/thoughts/shared/plans"
	touch "${TEST_DIR}/proj/thoughts/shared/plans/2026-05-24-ctl-9.md"
	setup_claude_stub "$STUB_DIR"
	export CLAUDE_STUB_LOG="${TEST_DIR}/claude-stub.log"
	export CLAUDE_STUB_JOB_ID="deadbeef"
	unset CLAUDE_STUB_EXIT
	export PATH="${STUB_DIR}:${PATH}"
}

# ─── Test 1: implement:before-launch → signal stalled, no claude spawn ──────
echo "Test 1: CATALYST_TEST_KILL_PHASE=implement:before-launch aborts before spawn"
fresh_env t1
(
	cd "${TEST_DIR}/proj"
	CATALYST_TEST_KILL_PHASE="implement:before-launch" \
		"$DISPATCH" --phase implement --ticket CTL-9 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/t1.out" 2>"${TEST_DIR}/t1.err"
)
RC=$?
SIGNAL="${WORKER_DIR}/phase-implement.json"
assert_eq "1" "$RC" "dispatch exits 1 on test-kill before-launch"
if [[ -f $SIGNAL ]]; then
	STATUS=$(jq -r '.status' "$SIGNAL")
	REASON=$(jq -r '.attentionReason' "$SIGNAL")
	BG=$(jq -r '.bg_job_id' "$SIGNAL")
	assert_eq "stalled" "$STATUS" "signal.status = stalled"
	assert_eq "test-kill-before-launch" "$REASON" "signal.attentionReason set by mark_launch_failed"
	assert_eq "null" "$BG" "signal.bg_job_id null — claude --bg never spawned"
else
	fail "signal file written by pre-spawn step"
fi
# Claude stub should NOT have been invoked.
if [[ -f $CLAUDE_STUB_LOG ]]; then
	fail "claude --bg invoked despite before-launch kill"
else
	pass "claude --bg NOT invoked (no stub log written)"
fi

# ─── Test 2: env var with wrong phase name does NOT trigger ─────────────────
echo ""
echo "Test 2: CATALYST_TEST_KILL_PHASE with non-matching phase falls through"
fresh_env t2
(
	cd "${TEST_DIR}/proj"
	CATALYST_TEST_KILL_PHASE="research:before-launch" \
		"$DISPATCH" --phase implement --ticket CTL-9 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/t2.out" 2>"${TEST_DIR}/t2.err"
)
RC=$?
SIGNAL="${WORKER_DIR}/phase-implement.json"
assert_eq "0" "$RC" "non-matching phase does not abort dispatch"
if [[ -f $SIGNAL ]]; then
	STATUS=$(jq -r '.status' "$SIGNAL")
	assert_eq "running" "$STATUS" "signal flips to running on successful spawn"
fi

# ─── Test 3: env var unset → normal dispatch ─────────────────────────────────
echo ""
echo "Test 3: env unset → dispatcher behaves identically to pre-CTL-587"
fresh_env t3
unset CATALYST_TEST_KILL_PHASE
(
	cd "${TEST_DIR}/proj"
	"$DISPATCH" --phase implement --ticket CTL-9 \
		--orch-dir "$ORCH_DIR" --orch-id orch-test \
		>"${TEST_DIR}/t3.out" 2>"${TEST_DIR}/t3.err"
)
RC=$?
SIGNAL="${WORKER_DIR}/phase-implement.json"
assert_eq "0" "$RC" "unset env → exit 0"
STATUS=$(jq -r '.status' "$SIGNAL")
assert_eq "running" "$STATUS" "unset env → signal = running"

# ─── Test 4: SKILL.md prelude carries the after-prelude kill hook ───────────
# A static grep test rather than a behavioural one — the prelude has too many
# external dependencies (catalyst-comms, catalyst-session) to execute in a
# fixture cleanly. The hook is a single `if` block; grep is sufficient to pin
# the contract.
echo ""
echo "Test 4: phase-implement/SKILL.md contains the after-prelude kill hook"
if grep -qE 'CATALYST_TEST_KILL_PHASE.*after-prelude' "$SKILL_MD"; then
	pass "SKILL.md prelude references CATALYST_TEST_KILL_PHASE after-prelude"
else
	fail "SKILL.md prelude missing CATALYST_TEST_KILL_PHASE after-prelude hook"
fi
if grep -qE 'exit 137' "$SKILL_MD"; then
	pass "SKILL.md prelude exits 137 (SIGKILL convention) on test-kill"
else
	fail "SKILL.md prelude missing 'exit 137'"
fi
# Pin ordering: the kill hook must be AFTER the signal status flip to "running"
# (so the reclaim sweep sees a running-but-dead worker). Extract the prelude
# bash block and check the kill block appears AFTER the `.status = "running"` jq.
PRELUDE=$(awk '/^```bash$/{flag=1;next}/^```$/{flag=0}flag' "$SKILL_MD" | head -200)
STATUS_LINE=$(printf '%s\n' "$PRELUDE" | grep -n '.status = "running"' | head -1 | cut -d: -f1)
KILL_LINE=$(printf '%s\n' "$PRELUDE" | grep -n 'CATALYST_TEST_KILL_PHASE' | head -1 | cut -d: -f1)
if [[ -n $STATUS_LINE && -n $KILL_LINE && $KILL_LINE -gt $STATUS_LINE ]]; then
	pass "kill hook appears AFTER the signal flip to running (line $KILL_LINE > $STATUS_LINE)"
else
	fail "kill hook ordering: status flip at $STATUS_LINE, kill at $KILL_LINE"
fi

# ─── Test 5: behavioural smoke — extracted prelude with kill var exits 137 ──
# Run the prelude bash block in a fixture. The optional bits (catalyst-comms,
# catalyst-session) all guard with `[[ -x ... ]]` so an empty PLUGIN_ROOT
# directory degrades gracefully.
echo ""
echo "Test 5: extracted SKILL.md prelude exits 137 when after-prelude kill set"
fresh_env t5
PRELUDE_DIR="${TEST_DIR}/prelude"
mkdir -p "$PRELUDE_DIR" "${ORCH_DIR}/workers/CTL-9"
# Pre-seed the signal file with a dispatched status — the prelude flips it to
# running.
cat >"${ORCH_DIR}/workers/CTL-9/phase-implement.json" <<EOF
{"ticket":"CTL-9","phase":"implement","status":"dispatched","bg_job_id":null,"orchestrator":"orch-test"}
EOF
# Extract the prelude code block from SKILL.md (between the first ```bash and the next ```).
awk '
  /^```bash$/ && !found { found=1; next }
  /^```$/ && found && !done { done=1; exit }
  found && !done { print }
' "$SKILL_MD" > "${PRELUDE_DIR}/prelude.sh"
# Append the planned kill-hook check — RED test, this is what we expect the
# real SKILL.md to contain once Phase 1 lands. Once SKILL.md has the hook,
# this append becomes a no-op duplicate so it stays harmless.
# (Once green, the extracted prelude itself contains the hook — appending it
# again is idempotent: a second matching check still exits 137.)
chmod +x "${PRELUDE_DIR}/prelude.sh"
(
	cd "${TEST_DIR}/proj"
	CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
	CATALYST_ORCHESTRATOR_ID="orch-test" \
	CATALYST_PHASE="implement" \
	CATALYST_TICKET="CTL-9" \
	CATALYST_TEST_KILL_PHASE="implement:after-prelude" \
	PLUGIN_ROOT="${TEST_DIR}/nonexistent-plugin-root" \
		bash "${PRELUDE_DIR}/prelude.sh" >"${TEST_DIR}/t5.out" 2>"${TEST_DIR}/t5.err"
)
RC=$?
assert_eq "137" "$RC" "extracted prelude exits 137 on after-prelude kill"
# And the signal was flipped to running BEFORE the kill.
STATUS=$(jq -r '.status' "${ORCH_DIR}/workers/CTL-9/phase-implement.json")
assert_eq "running" "$STATUS" "signal status = running (flipped before kill)"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-agent-dispatch-test-kill: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -gt 0 ]] && exit 1
exit 0
