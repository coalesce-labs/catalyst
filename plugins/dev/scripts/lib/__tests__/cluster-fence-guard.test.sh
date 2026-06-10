#!/usr/bin/env bash
# Unit tests for scripts/lib/cluster-fence-guard.sh (CTL-864).
#
# Three cases:
#   A — CATALYST_CLUSTER_GENERATION unset → silent no-op, exit 0, emit NOT called
#   B — generation set + fence current (fence-check exit 0) → exit 0, emit NOT called
#   C — generation set + fence stale (fence-check exit 10) → exit 10, emit called
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
	mkdir -p "${FAKE_ROOT}/scripts/execution-core"

	# Stub cluster-claim.mjs: ignore all args, exit with configurable code.
	cat >"${FAKE_ROOT}/scripts/execution-core/cluster-claim.mjs" <<EOF
#!/usr/bin/env node
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

echo ""
echo "─────────────────────────────────────────────"
echo "cluster-fence-guard: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
