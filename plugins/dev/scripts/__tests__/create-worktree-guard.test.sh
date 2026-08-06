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
# CTL-1628 post-merge (Codex #2948 round 2): exercise the REAL production
# _removal_guard_ok and _worktree_rollback_remove, extracted verbatim from
# create-worktree.sh — the same sed-range-extraction pattern
# phase-agent-dispatch.test.sh uses for compose_worker_settings_json — rather
# than a local reimplementation. A local mock can't regress; sourcing the
# actual function means a regression in the production gate (e.g. the
# CREATED_BRANCH check silently dropped) fails THIS suite instead of only
# ever exercising a hand-maintained copy.
#
# A stubbed `git` placed first on PATH records `worktree remove`/`branch -D`
# invocations so we can assert whether the gate reached them (the real
# function shells out to bare `git`, not an injectable command). lsof is
# stubbed via WT_GUARD_LSOF, per worktree-remove-guard.sh's existing seam.
source "$GUARD_LIB"

STUB_LSOF="$SCRATCH/mock-lsof"
cat >"$STUB_LSOF" <<'EOF'
#!/usr/bin/env bash
[[ -n "${STUB_LSOF_OUT:-}" ]] && printf '%s\n' "$STUB_LSOF_OUT"
exit "${STUB_LSOF_RC:-1}"
EOF
chmod +x "$STUB_LSOF"
export WT_GUARD_LSOF="$STUB_LSOF"

# Exported so the stubbed `git` on PATH can append to it.
export GIT_LOG="$SCRATCH/git.log"
STUB_BIN="$SCRATCH/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/git" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${GIT_LOG}"
exit 0
EOF
chmod +x "$STUB_BIN/git"

WORKTREE_PATH="$SCRATCH/wt/CTL-100"
WORKTREE_NAME="CTL-100"
mkdir -p "$WORKTREE_PATH"

# Extract the two real functions verbatim, by name, out of create-worktree.sh.
EXTRACTED_FUNCS="$SCRATCH/extracted-funcs.sh"
{
	sed -n '/^_removal_guard_ok()/,/^}/p' "$CREATE_WT"
	sed -n '/^_worktree_rollback_remove()/,/^}/p' "$CREATE_WT"
} >"$EXTRACTED_FUNCS"
if grep -q '^_removal_guard_ok()' "$EXTRACTED_FUNCS" && grep -q '^_worktree_rollback_remove()' "$EXTRACTED_FUNCS"; then
	pass "extracted the real _removal_guard_ok and _worktree_rollback_remove from create-worktree.sh"
else
	fail "could not extract _removal_guard_ok / _worktree_rollback_remove — sed range markers drifted from create-worktree.sh"
fi

# run_real_rollback [--no-guard-fn] — invokes the extracted PRODUCTION
# _worktree_rollback_remove in a subshell: cd into $WORKTREE_PATH first (so
# the function's own `cd -` mirrors create-worktree.sh returning to the
# pre-worktree directory), stub `git` first on PATH, and point SCRIPT_DIR at
# $SCRATCH (no lib/worktree-presweep.sh under it, so that clause safely
# no-ops — this suite targets the guard+CREATED_BRANCH gate, not presweep
# integration, which has its own coverage).
run_real_rollback() {
	local no_guard_fn="${1:-}"
	(
		cd "$SCRATCH" || exit 1
		cd "$WORKTREE_PATH" || exit 1
		export PATH="$STUB_BIN:$PATH"
		export SCRIPT_DIR="$SCRATCH"
		export WORKTREE_PATH WORKTREE_NAME
		export CREATED_BRANCH="${CREATED_BRANCH:-false}"
		# shellcheck source=/dev/null
		source "$GUARD_LIB"
		[[ "$no_guard_fn" == "--no-guard-fn" ]] && unset -f assert_worktree_removal_safe
		# shellcheck source=/dev/null
		source "$EXTRACTED_FUNCS"
		_worktree_rollback_remove
	) 2>/dev/null
}

# (a) live foreign holder (rc=0 + output) → guard refuses → NO remove.
: >"$GIT_LOG"
STUB_LSOF_RC=0 STUB_LSOF_OUT="p4321" run_real_rollback
if grep -q 'worktree remove' "$GIT_LOG"; then
	fail "live-handle rollback still force-removed the worktree"
else
	pass "live-handle rollback SKIPS the force-remove (guard refused)"
fi

# (b) clear probe (rc=1 + empty), CREATED_BRANCH=true → guard allows → remove
# AND branch-delete happen (this run created the branch, so deleting it on
# rollback is correct).
: >"$GIT_LOG"
CREATED_BRANCH=true STUB_LSOF_RC=1 STUB_LSOF_OUT="" run_real_rollback
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
CREATED_BRANCH=false STUB_LSOF_RC=1 STUB_LSOF_OUT="" run_real_rollback
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

# (e) CTL-1417 fail-closed: guard function UNAVAILABLE → refuse (NO remove).
# Run the gate with assert_worktree_removal_safe unset, proving guard-absence
# is treated as a refusal rather than a bypass.
: >"$GIT_LOG"
CREATED_BRANCH=true STUB_LSOF_RC=1 STUB_LSOF_OUT="" run_real_rollback --no-guard-fn
if grep -q 'worktree remove' "$GIT_LOG"; then
	fail "guard-absent rollback force-removed the worktree (fail-OPEN regression)"
else
	pass "guard-absent rollback SKIPS the force-remove (fail-closed)"
fi

echo ""
echo "create-worktree-guard: ${PASSES} passed / ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
exit 0
