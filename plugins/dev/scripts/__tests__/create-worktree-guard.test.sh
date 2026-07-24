#!/usr/bin/env bash
# CTL-1417: create-worktree.sh rollback removals must route through the shared
# self-protection guard (assert_worktree_removal_safe). When the guard reports a
# live foreign handle under the worktree, the `--force` rollback removal is
# SKIPPED (tree left for the reaper) instead of yanking an in-use tree. When the
# guard is clear, the rollback removes exactly as before.
#
# Drives rollback site 1 (auto-detected `make setup` failure) by committing a
# Makefile whose `setup` target exits non-zero. lsof is stubbed via WT_GUARD_LSOF
# so the guard verdict is deterministic.
#
# Run: bash plugins/dev/scripts/__tests__/create-worktree-guard.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CREATE_WT="${REPO_ROOT}/plugins/dev/scripts/create-worktree.sh"

FAILURES=0
PASSES=0
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
}
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
assert_eq() {
	if [[ $1 == "$2" ]]; then pass "$3"; else fail "$3 — expected '$1', got '$2'"; fi
}

SCRATCH="$(mktemp -d -t cwt-guard-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

# Deterministic, non-interactive git.
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@test
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@test
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

# A stub lsof whose rc/stdout is driven by STUB_LSOF_RC / STUB_LSOF_OUT.
MOCK_LSOF="$SCRATCH/mock-lsof"
cat >"$MOCK_LSOF" <<'MOCK'
#!/usr/bin/env bash
printf '%s' "${STUB_LSOF_OUT:-}"
exit "${STUB_LSOF_RC:-1}"
MOCK
chmod +x "$MOCK_LSOF"

ORIGIN="$SCRATCH/origin.git"
git init -q --bare "$ORIGIN"
SEED="$SCRATCH/seed"
git clone -q "$ORIGIN" "$SEED"
git -C "$SEED" checkout -q -b main 2>/dev/null || git -C "$SEED" checkout -q main
# No catalyst.worktree.setup → create-worktree takes the auto-detected path and
# runs `make setup`, whose target below exits 1 to force the rollback.
mkdir -p "$SEED/.catalyst"
printf '{"catalyst":{"projectKey":"t"}}\n' >"$SEED/.catalyst/config.json"
printf 'setup:\n\t@exit 1\n' >"$SEED/Makefile"
git -C "$SEED" add -A
git -C "$SEED" commit -q -m c1
git -C "$SEED" push -q -u origin main

SRC="$SCRATCH/src"
git clone -q "$ORIGIN" "$SRC"

# run_rollback <name> — invoke create-worktree.sh so its `make setup` fails and
# the rollback fires. Returns whether the worktree dir survived on disk.
run_rollback() {
	local name="$1"
	local wtbase="$SCRATCH/wt-$name"
	mkdir -p "$wtbase"
	(cd "$SRC" && HOME="$SCRATCH/home-$name" \
		WT_GUARD_LSOF="$MOCK_LSOF" STUB_LSOF_RC="${STUB_LSOF_RC:-1}" STUB_LSOF_OUT="${STUB_LSOF_OUT:-}" \
		bash "$CREATE_WT" "$name" main --worktree-dir "$wtbase" --skip-fetch >/dev/null 2>&1)
	WT_PATH="$wtbase/$name"
}

# Case 1: foreign live handle (rc=0 + output) → guard refuses → tree kept.
STUB_LSOF_RC=0 STUB_LSOF_OUT="p9999" run_rollback refuse
assert_eq "yes" "$([[ -d $WT_PATH ]] && echo yes || echo no)" \
	"rollback: guard refusal (live handle) leaves the worktree on disk"

# Case 2: clear lsof (rc=1 + empty) → guard allows → tree removed as before.
STUB_LSOF_RC=1 STUB_LSOF_OUT="" run_rollback allow
assert_eq "no" "$([[ -d $WT_PATH ]] && echo yes || echo no)" \
	"rollback: clear guard force-removes the worktree (unchanged behavior)"

echo ""
echo "create-worktree-guard: ${PASSES} passed / ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
exit 0
