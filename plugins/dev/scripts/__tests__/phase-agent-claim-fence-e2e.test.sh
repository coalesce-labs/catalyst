#!/usr/bin/env bash
# End-to-end composition test for the CTL-736 Phase 1 claim + fencing token.
#
# The unit suites (claim.test.mjs, phase-agent-dispatch Tests 40-43,
# phase-agent-emit-complete Tests 12-16) each exercise ONE script. This test
# composes the REAL phase-agent-dispatch and phase-agent-emit-complete through
# the full revive-storm loop — only `claude --bg` is stubbed — to prove Phase
# 1's guarantee: a wrong "is this worker dead?" guess can neither double-spawn
# nor double-emit.
#
#   1. fresh dispatch                      → generation 1, one worker
#   2. concurrent revive storm (2 ticks)   → exactly ONE new worker, gen ⇒ 2
#                                            (not 3 — the concurrent twin loses
#                                            the O_EXCL claim, no runaway)
#   3. stale gen-1 worker emits complete   → FENCED (no event, signal unchanged)
#   4. current gen-2 worker emits complete → done, exactly one complete event
#
# Scope note: the daemon's revive DECISION (recovery.mjs death trigger) is
# simulated here by flipping the signal to `stalled` and re-dispatching — Phase
# 1 does not change that trigger (that is Phase 2). This validates the claim +
# fence SAFETY NET against the still-live wrong-guess trigger.
#
# Run: bash plugins/dev/scripts/__tests__/phase-agent-claim-fence-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"
EMIT="${REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-claim-fence-e2e-XXXXXX)"
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

if [[ ! -x $DISPATCH || ! -x $EMIT ]]; then
	echo "FATAL: dispatch/emit script not found or not executable" >&2
	exit 1
fi

# ─── Fixture ─────────────────────────────────────────────────────────────────
# A stub `claude` that records one line per spawn (with the generation it was
# launched at) and prints a fresh 8-hex job id so the dispatcher's parser is
# satisfied. triage is the carrier phase: it needs no prior artifact and is NOT
# a rebase phase, so the dispatch path reduces to exactly the claim + spawn.
BIN_DIR="${SCRATCH}/bin"
ORCH_DIR="${SCRATCH}/orch"
WORKER_DIR="${ORCH_DIR}/workers/CTL-100"
SIGNAL="${WORKER_DIR}/phase-triage.json"
SPAWN_LOG="${SCRATCH}/spawns.log"
mkdir -p "$BIN_DIR" "$WORKER_DIR" "${SCRATCH}/proj" "${SCRATCH}/catalyst/events"
cat >"${BIN_DIR}/claude" <<'STUB'
#!/usr/bin/env bash
printf 'spawn gen=%s\n' "${CATALYST_GENERATION:-?}" >>"$SPAWN_LOG"
printf 'backgrounded · %08x%08x\n' "$RANDOM$$" "$RANDOM" | cut -c1-30
exit 0
STUB
chmod +x "${BIN_DIR}/claude"
export PATH="${BIN_DIR}:${PATH}"
export SPAWN_LOG
export CATALYST_DIR="${SCRATCH}/catalyst"
# Neutralize the machine-config fallback so the host's real config never leaks in.
export CATALYST_MACHINE_CONFIG="${SCRATCH}/machine-config-absent.json"

dispatch() { (cd "${SCRATCH}/proj" && "$DISPATCH" --phase triage --ticket CTL-100 --orch-dir "$ORCH_DIR" --orch-id CTL-100 "$@"); }
# grep -c already prints 0 (exit 1) on no match, so a `|| echo 0` fallback would
# emit a SECOND 0 ("0\n0"). Just read grep -c's stdout; the files always exist
# (SPAWN_LOG is truncated before each count; the events glob fails to a clean 0).
spawn_count() { grep -c '^spawn ' "$SPAWN_LOG" 2>/dev/null; }
complete_events() { cat "${CATALYST_DIR}/events/"*.jsonl 2>/dev/null | grep -c '"phase.triage.complete.CTL-100"'; }

# ─── 1. Fresh dispatch ───────────────────────────────────────────────────────
echo "Step 1: fresh dispatch"
: >"$SPAWN_LOG"
dispatch >/dev/null 2>&1
assert_eq "1" "$(jq -r '.generation' "$SIGNAL")" "fresh dispatch stamps generation = 1"
assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "fresh dispatch leaves signal running"
assert_eq "yes" "$([[ -f "${WORKER_DIR}/triage.claim.1" ]] && echo yes || echo no)" "claim file triage.claim.1 created"
assert_eq "1" "$(spawn_count)" "exactly one worker spawned"

# ─── 2. Concurrent revive storm ──────────────────────────────────────────────
# Simulate the daemon falsely declaring the worker dead and reviving it TWICE
# at the same instant (the storm shape from the research). The revive flips the
# signal to stalled; two parallel re-dispatches then race the gen-2 claim.
echo ""
echo "Step 2: concurrent revive storm (2 simultaneous false revives)"
: >"$SPAWN_LOG"
jq '.status = "stalled" | .attentionReason = "ctl-587-revive-reset"' "$SIGNAL" >"${SIGNAL}.t" && mv "${SIGNAL}.t" "$SIGNAL"
dispatch >/dev/null 2>&1 &
dispatch >/dev/null 2>&1 &
wait
assert_eq "1" "$(spawn_count)" "storm spawned exactly ONE new worker (the concurrent twin lost the claim)"
assert_eq "2" "$(jq -r '.generation' "$SIGNAL")" "generation advanced to 2 only (no runaway to 3)"
assert_eq "yes" "$([[ -f "${WORKER_DIR}/triage.claim.2" ]] && echo yes || echo no)" "fresh claim file triage.claim.2 created"
assert_eq "no" "$([[ -e "${WORKER_DIR}/triage.claim.3" ]] && echo yes || echo no)" "no triage.claim.3 (the twin did not win a new generation)"

# ─── 3. Fencing: the stale gen-1 worker tries to complete ────────────────────
echo ""
echo "Step 3: the stale gen-1 worker (false-dead, still alive) tries to emit complete"
FENCE_ERR=$(CATALYST_GENERATION=1 CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
	"$EMIT" --phase triage --ticket CTL-100 --status complete --orch-dir "$ORCH_DIR" 2>&1)
FENCE_RC=$?
assert_eq "0" "$FENCE_RC" "stale emit exits 0 (clean bow-out)"
assert_eq "running" "$(jq -r '.status' "$SIGNAL")" "stale emit does NOT flip the signal (still running)"
assert_eq "0" "$(complete_events)" "stale emit writes NO complete event"
if [[ $FENCE_ERR == *"stale-generation-bow-out"* ]]; then
	pass "stale emit logs stale-generation-bow-out"
else
	fail "stale emit should log stale-generation-bow-out (got: $FENCE_ERR)"
fi

# ─── 4. The current gen-2 worker completes ───────────────────────────────────
echo ""
echo "Step 4: the current gen-2 worker emits complete"
CURGEN=$(jq -r '.generation' "$SIGNAL")
CATALYST_GENERATION="$CURGEN" CATALYST_ORCHESTRATOR_DIR="$ORCH_DIR" \
	"$EMIT" --phase triage --ticket CTL-100 --status complete --orch-dir "$ORCH_DIR" >/dev/null 2>&1
assert_eq "done" "$(jq -r '.status' "$SIGNAL")" "current-generation emit flips the signal to done"
assert_eq "1" "$(complete_events)" "exactly one phase.triage.complete event (no double-complete)"

echo ""
echo "─────────────────────────────────────────────"
echo "phase-agent-claim-fence-e2e: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
