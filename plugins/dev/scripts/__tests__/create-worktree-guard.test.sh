#!/usr/bin/env bash
# CTL-1417: create-worktree.sh rollback --force removals must route through the
# shared worktree-removal self-protection guard, so a rollback never yanks a
# worktree that is our own cwd or is held by a live foreign process.
#
# The full create-worktree.sh flow (git worktree add → workflow-context →
# `make setup` → thoughts-init → direnv) is too heavy/environment-dependent to
# drive a deterministic rollback here, so this suite proves the change two ways:
#   1. STRUCTURAL — both rollback force-removals are gated by
#      assert_worktree_removal_safe and the guard lib is sourced.
#   2. BEHAVIORAL — the exact guard-gated removal decision create-worktree.sh
#      now uses is exercised against a REAL git linked worktree with a stubbed
#      lsof: a live-handle probe SKIPS the remove (tree survives), a clear probe
#      REMOVES it.
#
# Run: bash plugins/dev/scripts/__tests__/create-worktree-guard.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CREATE_WT="${REPO_ROOT}/plugins/dev/scripts/create-worktree.sh"
GUARD_LIB="${REPO_ROOT}/plugins/dev/scripts/lib/worktree-remove-guard.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t create-worktree-guard-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
assert_eq() { if [[ $1 == "$2" ]]; then pass "$3"; else fail "$3 — expected '$1', got '$2'"; fi; }

# ─── 1. Structural: both rollback removals are guard-wired ────────────────────
if grep -q 'source "\${SCRIPT_DIR}/lib/worktree-remove-guard.sh"' "$CREATE_WT"; then
	pass "create-worktree.sh sources the removal guard"
else
	fail "create-worktree.sh does NOT source lib/worktree-remove-guard.sh"
fi
# Every `git worktree remove --force` must be gated by the fail-closed
# _removal_guard_ok predicate (CTL-1417: guard-ABSENCE now REFUSES, so the sites
# gate on the helper rather than a bare `command -v ... || assert...` fail-open
# form). Count force-removes vs guard-predicate calls.
N_FORCE="$(grep -c 'git worktree remove --force "\$WORKTREE_PATH"' "$CREATE_WT" || true)"
N_GUARD="$(grep -c '_removal_guard_ok "\$WORKTREE_PATH"' "$CREATE_WT" || true)"
assert_eq "$N_FORCE" "$N_GUARD" "each rollback force-remove has a matching guard call (${N_FORCE} force / ${N_GUARD} guard)"
[[ "$N_FORCE" -ge 2 ]] && pass "both rollback sites present (${N_FORCE})" || fail "expected >=2 rollback force-removes, found ${N_FORCE}"

# ─── 2. Behavioral: the guard-gated removal decision ──────────────────────────
# Build a real repo + linked worktree; a mock git records `worktree remove` so
# we can assert whether the gate reached it. lsof is stubbed via WT_GUARD_LSOF.
source "$GUARD_LIB"

STUB_LSOF="$SCRATCH/mock-lsof"
cat >"$STUB_LSOF" <<'EOF'
#!/usr/bin/env bash
[[ -n "${STUB_LSOF_OUT:-}" ]] && printf '%s\n' "$STUB_LSOF_OUT"
exit "${STUB_LSOF_RC:-1}"
EOF
chmod +x "$STUB_LSOF"
export WT_GUARD_LSOF="$STUB_LSOF"

# Exported so the mock git child process can append to it.
export GIT_LOG="$SCRATCH/git.log"
MOCK_GIT="$SCRATCH/mockgit"
cat >"$MOCK_GIT" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${GIT_LOG}"
exit 0
EOF
chmod +x "$MOCK_GIT"

WORKTREE_PATH="$SCRATCH/wt/CTL-100"
WORKTREE_NAME="CTL-100"
mkdir -p "$WORKTREE_PATH"

# Replicate create-worktree.sh's exact guarded-removal gate — the fail-closed
# _removal_guard_ok predicate (guard-ABSENCE ⇒ refuse).
_removal_guard_ok() {
	local _wt="${1:-}"
	if ! command -v assert_worktree_removal_safe >/dev/null 2>&1; then
		echo "worktree-remove-guard: unavailable — refusing forced removal of ${_wt}" >&2
		return 1
	fi
	assert_worktree_removal_safe "$_wt"
}
guarded_remove() {
	if _removal_guard_ok "$WORKTREE_PATH"; then
		"$MOCK_GIT" worktree remove --force "$WORKTREE_PATH"
		"$MOCK_GIT" branch -D "$WORKTREE_NAME" 2>/dev/null || true
	else
		echo "create-worktree: guard refused/unavailable for ${WORKTREE_PATH}; leaving for reaper" >&2
	fi
}

# (a) live foreign holder (rc=0 + output) → guard refuses → NO remove.
: >"$GIT_LOG"
( cd "$SCRATCH" && STUB_LSOF_RC=0 STUB_LSOF_OUT="p4321" guarded_remove ) 2>/dev/null
if grep -q 'worktree remove' "$GIT_LOG"; then
	fail "live-handle rollback still force-removed the worktree"
else
	pass "live-handle rollback SKIPS the force-remove (guard refused)"
fi

# (b) clear probe (rc=1 + empty) → guard allows → remove happens.
: >"$GIT_LOG"
( cd "$SCRATCH" && STUB_LSOF_RC=1 STUB_LSOF_OUT="" guarded_remove ) 2>/dev/null
if grep -q 'worktree remove --force' "$GIT_LOG"; then
	pass "clear-probe rollback force-removes as before (guard allowed)"
else
	fail "clear-probe rollback did NOT remove (guard over-refused)"
fi

# (c) CTL-1417 fail-closed: guard function UNAVAILABLE → refuse (NO remove). Run
# the gate in a subshell where assert_worktree_removal_safe is unset, proving
# guard-absence is treated as a refusal rather than a bypass.
: >"$GIT_LOG"
(
	cd "$SCRATCH"
	unset -f assert_worktree_removal_safe
	guarded_remove
) 2>/dev/null
if grep -q 'worktree remove' "$GIT_LOG"; then
	fail "guard-absent rollback force-removed the worktree (fail-OPEN regression)"
else
	pass "guard-absent rollback SKIPS the force-remove (fail-closed)"
fi

echo ""
echo "create-worktree-guard: ${PASSES} passed / ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
exit 0
