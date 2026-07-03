#!/usr/bin/env bash
# Shell tests for lib/worktree-remove-guard.sh (CTL-1417) — the shell port of the
# CTL-791 worktree-safety self-protection gate. `assert_worktree_removal_safe`
# must refuse a `git worktree remove --force` whose target is the caller's own
# cwd (at-or-under) OR is held by a live process, and be fail-closed when the
# liveness probe cannot run.
#
# `lsof` is stubbed via WT_GUARD_LSOF pointing at a mock whose rc/stdout are
# driven by STUB_LSOF_RC / STUB_LSOF_OUT, so branch (b) is deterministic and
# never shells out to real lsof.
#
# Run: bash plugins/dev/scripts/lib/__tests__/worktree-remove-guard.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GUARD_LIB="$LIB_DIR/worktree-remove-guard.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t worktree-remove-guard-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

# Source the unit under test. A missing lib is itself a Red failure, so tolerate
# the source error and let the assertions report it rather than aborting.
# shellcheck source=../worktree-remove-guard.sh
source "$GUARD_LIB" 2>/dev/null || true

# A stub lsof whose rc/stdout is driven by env, so branch (b) is deterministic.
MOCK_LSOF="$SCRATCH/mock-lsof"
cat >"$MOCK_LSOF" <<'EOF'
#!/usr/bin/env bash
# mock lsof — emit $STUB_LSOF_OUT and exit $STUB_LSOF_RC (defaults: empty / rc=1).
printf '%s' "${STUB_LSOF_OUT:-}"
exit "${STUB_LSOF_RC:-1}"
EOF
chmod +x "$MOCK_LSOF"

# guard_case runs the guard in an isolated subshell (own cwd + stub env) and
# returns 0 iff the guard's allow/refuse verdict matches <expect>. The parent
# owns the pass/fail counters (subshell-local increments would be lost).
#
#   guard_case <refuse|allow> <cd_dir|-> <target> <lsof_rc> <lsof_out> [lsof_bin]
guard_case() {
	local expect="$1" cddir="$2" target="$3" rc_stub="$4" out_stub="$5" bin="${6:-$MOCK_LSOF}"
	(
		[[ "$cddir" != "-" ]] && { cd "$cddir" || exit 2; }
		export STUB_LSOF_RC="$rc_stub" STUB_LSOF_OUT="$out_stub" WT_GUARD_LSOF="$bin"
		if assert_worktree_removal_safe "$target" 2>/dev/null; then
			[[ "$expect" == "allow" ]]
		else
			[[ "$expect" == "refuse" ]]
		fi
	)
}

check() {
	local label="$1"
	shift
	if "$@"; then pass "$label"; else fail "$label"; fi
}

mkdir -p "$SCRATCH/wt/sub" "$SCRATCH/other"

# (guard) empty/blank target is refused.
check "empty target refused" guard_case refuse - "" 1 ""
check "blank target refused" guard_case refuse - "   " 1 ""

# (a) target == cwd is refused, even with lsof "clear" (rc=1/empty).
check "cwd == target refused" guard_case refuse "$SCRATCH/wt" "$SCRATCH/wt" 1 ""

# (a) target is an ANCESTOR of cwd is refused (removing tree you stand inside).
check "ancestor-of-cwd target refused" guard_case refuse "$SCRATCH/wt/sub" "$SCRATCH/wt" 1 ""

# (a) trailing-slash normalization: "$SCRATCH/wt/" vs cwd "$SCRATCH/wt" still refuses.
check "trailing-slash target refused" guard_case refuse "$SCRATCH/wt" "$SCRATCH/wt/" 1 ""

# happy path: unrelated target, lsof rc=1 (nothing under tree) -> ALLOWED.
check "unrelated + clear lsof allowed" guard_case allow "$SCRATCH" "$SCRATCH/other" 1 ""

# (b) foreign holder present (lsof rc=0 + output) -> refused even though cwd is elsewhere.
check "foreign live handle refused" guard_case refuse "$SCRATCH" "$SCRATCH/other" 0 "p1234"

# (b) fail-closed: lsof probe errors (missing binary, rc=127) -> refused.
check "fail-closed on lsof probe error" guard_case refuse "$SCRATCH" "$SCRATCH/other" 1 "" /nonexistent/lsof

echo ""
echo "worktree-remove-guard: ${PASSES} passed / ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
exit 0
