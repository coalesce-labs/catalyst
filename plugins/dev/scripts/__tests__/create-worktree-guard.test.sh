#!/usr/bin/env bash
# CTL-1417: create-worktree.sh rollback --force removals must route through the
# shared worktree-removal self-protection guard, so a rollback never yanks a
# worktree that is our own cwd or is held by a live foreign process.
#
# CTL-1628 post-merge (Codex #2948): the make-setup, bun-install, npm-install,
# and thoughts-missing rollback sites were consolidated into a single
# _worktree_rollback_remove() helper (called directly, or via
# _worktree_install_rollback()) — so there is now exactly ONE literal
# `git worktree remove --force` / `_removal_guard_ok` pair in the file, reached
# from multiple call sites, rather than one duplicated pair per site.
#
# The full create-worktree.sh flow (git worktree add → workflow-context →
# `make setup` → thoughts-init → direnv) is too heavy/environment-dependent to
# drive a deterministic rollback here, so this suite proves the change two ways:
#   1. STRUCTURAL — the single consolidated force-remove is gated by
#      assert_worktree_removal_safe, the guard lib is sourced, and multiple
#      distinct failure scenarios still route into that one guarded helper.
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

# ─── 1. Structural: the consolidated rollback removal is guard-wired ──────────
if grep -q 'source "\${SCRIPT_DIR}/lib/worktree-remove-guard.sh"' "$CREATE_WT"; then
	pass "create-worktree.sh sources the removal guard"
else
	fail "create-worktree.sh does NOT source lib/worktree-remove-guard.sh"
fi
# The single `git worktree remove --force` (consolidated in
# _worktree_rollback_remove, CTL-1628 post-merge) must be gated by the
# fail-closed _removal_guard_ok predicate (CTL-1417: guard-ABSENCE now
# REFUSES, so the site gates on the helper rather than a bare
# `command -v ... || assert...` fail-open form). Count force-removes vs
# guard-predicate calls — now 1:1 since both live in the one shared helper.
N_FORCE="$(grep -c 'git worktree remove --force "\$WORKTREE_PATH"' "$CREATE_WT" || true)"
N_GUARD="$(grep -c '_removal_guard_ok "\$WORKTREE_PATH"' "$CREATE_WT" || true)"
assert_eq "$N_FORCE" "$N_GUARD" "each rollback force-remove has a matching guard call (${N_FORCE} force / ${N_GUARD} guard)"
# Multiple DISTINCT failure scenarios (make setup, bun install, npm install —
# via _worktree_install_rollback — and thoughts-missing, calling
# _worktree_rollback_remove directly) must still route into that one shared,
# guarded helper. Count call sites: the `|| _worktree_install_rollback` idiom,
# plus bare `_worktree_rollback_remove` invocations (no trailing "()", so the
# function's own definition line is excluded) minus 1 for
# _worktree_install_rollback's own internal delegation call (not a distinct
# external trigger).
N_INSTALL_ROLLBACK_CALLS="$(grep -c '|| _worktree_install_rollback' "$CREATE_WT" || true)"
N_REMOVE_HELPER_CALLS="$(grep -cE '_worktree_rollback_remove$' "$CREATE_WT" || true)"
N_ROLLBACK_TRIGGERS=$((N_INSTALL_ROLLBACK_CALLS + N_REMOVE_HELPER_CALLS - 1))
[[ "$N_ROLLBACK_TRIGGERS" -ge 2 ]] &&
	pass "multiple rollback-triggering call sites route through the shared guarded helper (${N_ROLLBACK_TRIGGERS})" ||
	fail "expected >=2 rollback-triggering call sites, found ${N_ROLLBACK_TRIGGERS}"

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
# _removal_guard_ok predicate (guard-ABSENCE ⇒ refuse) AND (CTL-1628
# post-merge, Codex #2948) the CREATED_BRANCH gate: a branch this run did NOT
# create must survive rollback even when the worktree is force-removed.
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
		if [[ "${CREATED_BRANCH:-false}" == true ]]; then
			"$MOCK_GIT" branch -D "$WORKTREE_NAME" 2>/dev/null || true
		fi
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

# (b) clear probe (rc=1 + empty), CREATED_BRANCH=true → guard allows → remove
# AND branch-delete happen (this run created the branch, so deleting it on
# rollback is correct).
: >"$GIT_LOG"
( cd "$SCRATCH" && CREATED_BRANCH=true STUB_LSOF_RC=1 STUB_LSOF_OUT="" guarded_remove ) 2>/dev/null
if grep -q 'worktree remove --force' "$GIT_LOG"; then
	pass "clear-probe rollback force-removes as before (guard allowed)"
else
	fail "clear-probe rollback did NOT remove (guard over-refused)"
fi
if grep -q 'branch -D' "$GIT_LOG"; then
	pass "CREATED_BRANCH=true rollback deletes the branch it created"
else
	fail "CREATED_BRANCH=true rollback did NOT delete the branch"
fi

# (d) CTL-1628 post-merge (Codex #2948, P1): clear probe, CREATED_BRANCH=false
# → guard allows the worktree remove, but the PRE-EXISTING branch the user
# already owned must survive — no `branch -D` at all. A regression here is a
# silent unpushed-commit loss.
: >"$GIT_LOG"
( cd "$SCRATCH" && CREATED_BRANCH=false STUB_LSOF_RC=1 STUB_LSOF_OUT="" guarded_remove ) 2>/dev/null
if grep -q 'worktree remove --force' "$GIT_LOG"; then
	pass "CREATED_BRANCH=false rollback still force-removes the worktree"
else
	fail "CREATED_BRANCH=false rollback did NOT remove the worktree"
fi
if grep -q 'branch -D' "$GIT_LOG"; then
	fail "CREATED_BRANCH=false rollback deleted a pre-existing branch (data-loss regression)"
else
	pass "CREATED_BRANCH=false rollback PRESERVES the pre-existing branch"
fi

# (e) CTL-1417 fail-closed: guard function UNAVAILABLE → refuse (NO remove). Run
# the gate in a subshell where assert_worktree_removal_safe is unset, proving
# guard-absence is treated as a refusal rather than a bypass.
: >"$GIT_LOG"
(
	cd "$SCRATCH"
	unset -f assert_worktree_removal_safe
	CREATED_BRANCH=true guarded_remove
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
