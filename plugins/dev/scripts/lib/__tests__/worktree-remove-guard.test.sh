#!/usr/bin/env bash
# Shell tests for lib/worktree-remove-guard.sh (CTL-1417) — the shell port of
# CTL-791 worktree-safety.mjs `lsofCwdUnder`/`cwdUnder`. Refuse a
# `git worktree remove --force` whose target is the caller's own cwd
# (at-or-under) OR is held by a live process; fail-closed when lsof can't run.
#
# The `lsof` binary is stubbed via WT_GUARD_LSOF pointing at a mock whose
# rc/stdout are env-driven (STUB_LSOF_RC / STUB_LSOF_OUT), so branch (b) is
# deterministic and never shells out to real lsof against $SCRATCH.
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

# ─── lsof stub ───────────────────────────────────────────────────────────────
# A mock lsof whose rc + stdout are driven by STUB_LSOF_RC / STUB_LSOF_OUT in
# the environment. Real lsof is never invoked.
STUB_LSOF="$SCRATCH/mock-lsof"
cat >"$STUB_LSOF" <<'EOF'
#!/usr/bin/env bash
# STUB_LSOF_OUT → stdout (the guard parses `-F p` PID lines like "p1234").
# STUB_LSOF_ERR → stderr (simulates lsof's traversal/permission DIAGNOSTIC).
# STUB_LSOF_SLEEP → block this many seconds before returning (timeout test).
[[ -n "${STUB_LSOF_SLEEP:-}" ]] && sleep "$STUB_LSOF_SLEEP"
[[ -n "${STUB_LSOF_OUT:-}" ]] && printf '%s\n' "$STUB_LSOF_OUT"
[[ -n "${STUB_LSOF_ERR:-}" ]] && printf '%s\n' "$STUB_LSOF_ERR" >&2
exit "${STUB_LSOF_RC:-1}"
EOF
chmod +x "$STUB_LSOF"
export WT_GUARD_LSOF="$STUB_LSOF"

# Source the unit under test.
# shellcheck source=../worktree-remove-guard.sh
source "$GUARD_LIB"

# ─── assertion helpers ───────────────────────────────────────────────────────
# Each case runs the guard inside a `( cd … )` subshell for cwd + env
# isolation. Because a subshell cannot mutate the parent's PASSES/FAILURES,
# the subshell's EXIT CODE is the guard's rc and the PARENT does the counting
# from it — otherwise a failing subshell case would be silently dropped and
# the suite would falsely report success.
assert_rc_nonzero() { # <rc> <label>
	if [[ "$1" -ne 0 ]]; then pass "refused ($2)"; else fail "expected REFUSE ($2) — guard returned 0"; fi
}
assert_rc_zero() { # <rc> <label>
	if [[ "$1" -eq 0 ]]; then pass "allowed ($2)"; else fail "expected ALLOW ($2) — guard returned $1"; fi
}

# ─── Cases ───────────────────────────────────────────────────────────────────

# empty/blank target is refused
rc=0; assert_worktree_removal_safe "" 2>/dev/null || rc=$?
assert_rc_nonzero "$rc" "empty target"
rc=0; assert_worktree_removal_safe "   " 2>/dev/null || rc=$?
assert_rc_nonzero "$rc" "blank target"

# (a) target == cwd is refused, even with lsof "clear" (rc=1/empty)
mkdir -p "$SCRATCH/wt"
rc=0; (cd "$SCRATCH/wt" && STUB_LSOF_RC=1 STUB_LSOF_OUT="" assert_worktree_removal_safe "$SCRATCH/wt") 2>/dev/null || rc=$?
assert_rc_nonzero "$rc" "target == cwd"

# (a) target is an ANCESTOR of cwd is refused (removing tree you stand inside)
mkdir -p "$SCRATCH/wt/sub"
rc=0; (cd "$SCRATCH/wt/sub" && STUB_LSOF_RC=1 STUB_LSOF_OUT="" assert_worktree_removal_safe "$SCRATCH/wt") 2>/dev/null || rc=$?
assert_rc_nonzero "$rc" "target is ancestor of cwd"

# (a) trailing-slash normalization: "$SCRATCH/wt/" vs cwd "$SCRATCH/wt" still refuses
rc=0; (cd "$SCRATCH/wt" && STUB_LSOF_RC=1 STUB_LSOF_OUT="" assert_worktree_removal_safe "$SCRATCH/wt/") 2>/dev/null || rc=$?
assert_rc_nonzero "$rc" "trailing-slash target == cwd"

# happy path: unrelated target, lsof rc=1 + empty (nothing under tree) → ALLOWED
mkdir -p "$SCRATCH/other"
rc=0; (cd "$SCRATCH" && STUB_LSOF_RC=1 STUB_LSOF_OUT="" assert_worktree_removal_safe "$SCRATCH/other") 2>/dev/null || rc=$?
assert_rc_zero "$rc" "unrelated target, lsof clear"

# (b) foreign holder present (lsof rc=0 + a foreign PID line) → refused even though cwd is elsewhere
rc=0; (cd "$SCRATCH" && STUB_LSOF_RC=0 STUB_LSOF_OUT="p1234" assert_worktree_removal_safe "$SCRATCH/other") 2>/dev/null || rc=$?
assert_rc_nonzero "$rc" "foreign holder present"

# (b) fail-closed: lsof probe errors (rc=127 / missing binary) → refused
rc=0; (cd "$SCRATCH" && WT_GUARD_LSOF=/nonexistent/lsof assert_worktree_removal_safe "$SCRATCH/other") 2>/dev/null || rc=$?
assert_rc_nonzero "$rc" "fail-closed on missing lsof"

# (b/#1) self-exclusion: the ONLY holder is our own process ($$) → ALLOWED.
# During teardown the worker's cwd is the tree; the guard must exempt its own
# session's process tree, not detect itself and refuse. The subshell's $$ is
# the guard's own shell (a member of _wtg_self_pids), so `p$$` must be dropped.
rc=0; (cd "$SCRATCH" && STUB_LSOF_RC=0 STUB_LSOF_OUT="p$$" assert_worktree_removal_safe "$SCRATCH/other") 2>/dev/null || rc=$?
assert_rc_zero "$rc" "self-only holder is exempted"

# (b/#1) mixed holders: self PID + a foreign PID → still refused (foreign wins).
rc=0; (cd "$SCRATCH" && STUB_LSOF_RC=0 STUB_LSOF_OUT="$(printf 'p%s\np1234\n' "$$")" assert_worktree_removal_safe "$SCRATCH/other") 2>/dev/null || rc=$?
assert_rc_nonzero "$rc" "self + foreign holder still refused"

# (b/#3) inconclusive: lsof exits 1 with a stderr DIAGNOSTIC (not clean-empty) → refused.
# rc=1 + empty stdout would otherwise read as "nothing under the tree"; the
# stderr diagnostic must flip that to fail-closed.
rc=0; (cd "$SCRATCH" && STUB_LSOF_RC=1 STUB_LSOF_OUT="" STUB_LSOF_ERR="lsof: WARNING: can't stat() apfs file system" assert_worktree_removal_safe "$SCRATCH/other") 2>/dev/null || rc=$?
assert_rc_nonzero "$rc" "lsof stderr diagnostic is inconclusive → refuse"

# (b/#2) bound: an lsof that blocks past the 10s cap → timeout → refused.
# Guarded behind WT_GUARD_TEST_SLOW=1 so the normal fast suite stays sub-second;
# opt in when you want to exercise the wall-clock cap end-to-end.
if [[ "${WT_GUARD_TEST_SLOW:-0}" == "1" ]]; then
	rc=0; (cd "$SCRATCH" && STUB_LSOF_RC=0 STUB_LSOF_OUT="p1234" STUB_LSOF_SLEEP=12 assert_worktree_removal_safe "$SCRATCH/other") 2>/dev/null || rc=$?
	assert_rc_nonzero "$rc" "lsof exceeding 10s cap → timeout → refuse"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "worktree-remove-guard: ${PASSES} passed / ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
exit 0
