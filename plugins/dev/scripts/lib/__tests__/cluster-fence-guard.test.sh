#!/usr/bin/env bash
# Unit tests for scripts/lib/cluster-fence-guard.sh (CTL-864).
#
# Three cases:
#   A — CATALYST_CLUSTER_GENERATION unset → silent no-op, exit 0, emit NOT called
#   B — generation set + fence current (fence-check exit 0) → exit 0, emit NOT called
#   C — generation set + fence stale (fence-check exit 10) → exit 10, emit called
#   D — fence UNREADABLE on every attempt (exit 1) → exit 10, emit reason
#       cluster_fence_unverified — NOT cluster_fence_stale (CTL-2048)
#   E — fence unreadable ONCE then current → exit 0, emit NOT called (the retry
#       recovers the transient case that was measured on mini-2)
#   F — a stale answer is NOT retried (exactly one fence-check call)
#
# Stubs: a fake PLUGIN_ROOT with stub cluster-claim.mjs and phase-agent-emit-complete
# so the guard never touches Linear or the real dispatcher.
#
# Run: bash plugins/dev/scripts/lib/__tests__/cluster-fence-guard.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GUARD="${LIB_DIR}/cluster-fence-guard.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t cluster-fence-guard-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then pass "$label"
	else fail "$label — expected '$expected', got '$actual'"
	fi
}
assert_contains() {
	local haystack="$1" needle="$2" label="$3"
	if [[ $haystack == *"$needle"* ]]; then pass "$label"
	else fail "$label — '$needle' not found in '$haystack'"
	fi
}

if [[ ! -f $GUARD ]]; then
	echo "FATAL: $GUARD not found — implement it first" >&2
	exit 1
fi

# Build a fake PLUGIN_ROOT with configurable fence-check and emit stubs.
# FENCE_STUB_EXIT controls the exit code of cluster-claim.mjs fence-check.
# EMIT_LOG records calls to phase-agent-emit-complete.
setup_stubs() {
	local tag="$1"
	local fence_exit="${2:-0}"
	FAKE_ROOT="${SCRATCH}/${tag}"
	EMIT_LOG="${FAKE_ROOT}/emit.log"
	FENCE_CALL_LOG="${FAKE_ROOT}/fence-calls.log"
	mkdir -p "${FAKE_ROOT}/scripts/execution-core"

	# Stub cluster-claim.mjs: ignore all args, exit with configurable code.
	#
	# CTL-2048: it also COUNTS its invocations (FENCE_CALL_LOG) and can fail a fixed
	# number of times before succeeding (FENCE_STUB_FAIL_TIMES), which is what makes the
	# retry observable at all — without the counter, "the retry ran" and "the first call
	# happened to succeed" look identical from the guard's exit code.
	cat >"${FAKE_ROOT}/scripts/execution-core/cluster-claim.mjs" <<EOF
#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const log = process.env.FENCE_CALL_LOG;
let n = 0;
if (log) {
  try { n = readFileSync(log, "utf8").split("\n").filter(Boolean).length; } catch {}
  appendFileSync(log, "call\n");
}
const failTimes = parseInt(process.env.FENCE_STUB_FAIL_TIMES ?? "0");
if (n < failTimes) {
  process.stderr.write("transport-error route=attachments caller=cluster-claim\n");
  process.exit(1);
}
const exitCode = parseInt(process.env.FENCE_STUB_EXIT ?? "${fence_exit}");
process.exit(exitCode);
EOF

	# Stub phase-agent-emit-complete: log all args, exit 0.
	cat >"${FAKE_ROOT}/scripts/phase-agent-emit-complete" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$EMIT_LOG"
exit 0
STUB
	chmod +x "${FAKE_ROOT}/scripts/phase-agent-emit-complete"
}

# ─── Case A: CATALYST_CLUSTER_GENERATION unset → no-op ──────────────────────
echo "Case A: CATALYST_CLUSTER_GENERATION unset → silent no-op (exit 0, no emit)"
setup_stubs A 10  # fence would return stale IF called — confirms it is NOT called
unset CATALYST_CLUSTER_GENERATION 2>/dev/null || true
CLAUDE_PLUGIN_ROOT="${FAKE_ROOT}" EMIT_LOG="${EMIT_LOG}" \
	bash "$GUARD" --phase pr --ticket CTL-1
A_RC=$?
assert_eq "0" "$A_RC" "unset gen → exit 0 (no-op)"
A_EMIT_CALLED="$([[ -f $EMIT_LOG && -s $EMIT_LOG ]] && echo yes || echo no)"
assert_eq "no" "$A_EMIT_CALLED" "unset gen → phase-agent-emit-complete NOT called"

# ─── Case B: generation set + current → proceed ─────────────────────────────
echo ""
echo "Case B: generation set + fence current (exit 0) → proceed (exit 0, no emit)"
setup_stubs B 0  # fence returns current
CATALYST_CLUSTER_GENERATION=7 FENCE_STUB_EXIT=0 \
	CLAUDE_PLUGIN_ROOT="${FAKE_ROOT}" EMIT_LOG="${EMIT_LOG}" \
	bash "$GUARD" --phase pr --ticket CTL-1
B_RC=$?
assert_eq "0" "$B_RC" "current gen → exit 0 (proceed)"
B_EMIT_CALLED="$([[ -f $EMIT_LOG && -s $EMIT_LOG ]] && echo yes || echo no)"
assert_eq "no" "$B_EMIT_CALLED" "current gen → phase-agent-emit-complete NOT called"

# ─── Case C: generation set + stale → bow out ───────────────────────────────
echo ""
echo "Case C: generation set + fence stale (exit 10) → bow out (exit 10, emit failed)"
setup_stubs C 10  # fence returns stale
CATALYST_CLUSTER_GENERATION=1 FENCE_STUB_EXIT=10 \
	CLAUDE_PLUGIN_ROOT="${FAKE_ROOT}" EMIT_LOG="${EMIT_LOG}" \
	bash "$GUARD" --phase pr --ticket CTL-1
C_RC=$?
assert_eq "10" "$C_RC" "stale gen → exit 10 (bow out)"
C_EMIT_LOG="$(cat "$EMIT_LOG" 2>/dev/null || echo "")"
assert_contains "$C_EMIT_LOG" "--status" "stale gen → emit-complete called with --status"
assert_contains "$C_EMIT_LOG" "failed" "stale gen → emit-complete called with failed status"
assert_contains "$C_EMIT_LOG" "cluster_fence_stale" "stale gen → emit-complete reason=cluster_fence_stale"

# ─── Case D: fence UNREADABLE on every attempt → unverified, NOT stale ──────
#
# ⛔ THE DEFECT (CTL-2048). `fence-check` exits 10 for a genuinely stale generation and 1
# when it THREW. The guard branched on `if …; then exit 0; fi` and called everything else
# stale, so a transport error was recorded as a definite takeover by another host. Measured
# on mini-2 on 2026-08-18: two real triage.json artifacts, both signals written
# `cluster_fence_stale`, and neither fence was stale.
echo ""
echo "Case D: fence unreadable (exit 1) on every attempt → exit 10, reason=cluster_fence_unverified"
setup_stubs D 1
CATALYST_CLUSTER_GENERATION=1 FENCE_STUB_EXIT=1 CATALYST_FENCE_CHECK_RETRIES=1 \
	CLAUDE_PLUGIN_ROOT="${FAKE_ROOT}" EMIT_LOG="${EMIT_LOG}" FENCE_CALL_LOG="${FENCE_CALL_LOG}" \
	bash "$GUARD" --phase pr --ticket CTL-1 2>/dev/null
D_RC=$?
assert_eq "10" "$D_RC" "unreadable fence → exit 10 (side-effect still declined)"
D_EMIT_LOG="$(cat "$EMIT_LOG" 2>/dev/null || echo "")"
assert_contains "$D_EMIT_LOG" "cluster_fence_unverified" "unreadable fence → reason=cluster_fence_unverified"
# ⛔ The whole point: it must NOT assert a fact it did not establish.
D_SAID_STALE="$([[ $D_EMIT_LOG == *"cluster_fence_stale"* ]] && echo yes || echo no)"
assert_eq "no" "$D_SAID_STALE" "unreadable fence → does NOT report cluster_fence_stale"
D_CALLS="$(wc -l <"$FENCE_CALL_LOG" 2>/dev/null | tr -d ' ')"
assert_eq "2" "$D_CALLS" "unreadable fence → retried (1 retry ⇒ 2 fence-check calls)"

# ─── Case E: unreadable ONCE, then current → the retry recovers it ──────────
#
# The measured mini-2 case: one transport error, then {"current":true} on re-run 3/3.
# One retry would have avoided both real failures.
echo ""
echo "Case E: fence unreadable once then current → exit 0, no emit (retry recovers)"
setup_stubs E 0
CATALYST_CLUSTER_GENERATION=1 FENCE_STUB_EXIT=0 FENCE_STUB_FAIL_TIMES=1 \
	CLAUDE_PLUGIN_ROOT="${FAKE_ROOT}" EMIT_LOG="${EMIT_LOG}" FENCE_CALL_LOG="${FENCE_CALL_LOG}" \
	bash "$GUARD" --phase pr --ticket CTL-1 2>/dev/null
E_RC=$?
assert_eq "0" "$E_RC" "transient unreadable → exit 0 (proceed after retry)"
E_EMIT_CALLED="$([[ -f $EMIT_LOG && -s $EMIT_LOG ]] && echo yes || echo no)"
assert_eq "no" "$E_EMIT_CALLED" "transient unreadable → NO failure emitted"
E_CALLS="$(wc -l <"$FENCE_CALL_LOG" 2>/dev/null | tr -d ' ')"
# ⛔ Without this the case passes even if the guard never retried and the stub simply
# succeeded first time — the assertion has to see the failed attempt.
assert_eq "2" "$E_CALLS" "transient unreadable → the FIRST call really did fail (2 calls)"

# ─── Case F: a STALE answer is not retried ─────────────────────────────────
#
# Exit 10 is an ANSWER, not a failure to read. Retrying it asks a settled question again
# and delays a real zombie's bow-out.
echo ""
echo "Case F: stale (exit 10) is answered, not retried → exactly one fence-check call"
setup_stubs F 10
CATALYST_CLUSTER_GENERATION=1 FENCE_STUB_EXIT=10 CATALYST_FENCE_CHECK_RETRIES=3 \
	CLAUDE_PLUGIN_ROOT="${FAKE_ROOT}" EMIT_LOG="${EMIT_LOG}" FENCE_CALL_LOG="${FENCE_CALL_LOG}" \
	bash "$GUARD" --phase pr --ticket CTL-1 2>/dev/null
F_RC=$?
assert_eq "10" "$F_RC" "stale → exit 10"
F_CALLS="$(wc -l <"$FENCE_CALL_LOG" 2>/dev/null | tr -d ' ')"
assert_eq "1" "$F_CALLS" "stale → exactly ONE fence-check call (no retry)"
F_EMIT_LOG="$(cat "$EMIT_LOG" 2>/dev/null || echo "")"
assert_contains "$F_EMIT_LOG" "cluster_fence_stale" "stale → still reason=cluster_fence_stale"

echo ""
echo "─────────────────────────────────────────────"
echo "cluster-fence-guard: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
