#!/usr/bin/env bash
# Tests for catalyst_git_exclude_worktree_artifacts (create-worktree.sh):
# Catalyst's own worktree-local runtime artifacts (thoughts/,
# .catalyst/.workflow-context.json, etc.) must never show up as dirty/untracked
# in a fresh worktree's `git status` — without ever touching the project's
# TRACKED .gitignore. This is what makes a project's verify-phase rebase never
# get refused by Catalyst's own noise (the root cause of a real stalled-ticket
# incident: rebase_refused_dirty_tree on thoughts/ + .workflow-context.json).
# Run: bash plugins/dev/scripts/__tests__/create-worktree-gitignore-artifacts.test.sh
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
assert_contains() {
	if [[ $2 == *"$1"* ]]; then pass "$3"; else fail "$3 — expected to find '$1' in: $2"; fi
}

# Scratch layout mirrors create-worktree-tracked-clean.test.sh.
COMMITTED_CATALYST_CFG='{"catalyst":{"projectKey":"t","worktree":{"setup":["true"]}}}'
build_scratch() {
	SCRATCH="$(mktemp -d -t cwt-gitignore-XXXXXX)"
	ORIGIN="$SCRATCH/origin.git"
	SRC="$SCRATCH/src"
	WT="$SCRATCH/wt"
	FAKEHOME="$SCRATCH/home"
	mkdir -p "$WT" "$FAKEHOME"
	git init -q --bare "$ORIGIN"
	# Robust to the host's init.defaultBranch (may be "master" locally, "main" in
	# CI) — pin the bare origin's HEAD to "main" explicitly so clone/push below
	# never depend on the ambient default.
	git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

	local SEED="$SCRATCH/seed"
	git clone -q "$ORIGIN" "$SEED"
	git -C "$SEED" config user.email t@t.t
	git -C "$SEED" config user.name t
	git -C "$SEED" checkout -q -b main 2>/dev/null || git -C "$SEED" checkout -q main
	mkdir -p "$SEED/.catalyst"
	printf '%s\n' "$COMMITTED_CATALYST_CFG" >"$SEED/.catalyst/config.json"
	git -C "$SEED" add -A
	git -C "$SEED" commit -q -m c1
	git -C "$SEED" push -q -u origin main

	git clone -q "$ORIGIN" "$SRC"
	git -C "$SRC" config user.email t@t.t
	git -C "$SRC" config user.name t
}

run_create() { # $1 worktree name; $@ extra args
	local NAME="$1"
	shift
	OUTPUT="$(cd "$SRC" && HOME="$FAKEHOME" \
		bash "$CREATE_WT" "$NAME" main --worktree-dir "$WT" "$@" 2>&1)"
	EXIT=$?
	WT_PATH="$WT/$NAME"
}

echo "Test 1: fresh worktree's local git exclude carries every Catalyst runtime-artifact pattern"
build_scratch
run_create wt-exclude
assert_eq "0" "$EXIT" "exits 0"
# The exclude file is wired in via worktree-scoped `core.excludesFile`
# (never the shared `info/exclude`, which is common to every linked worktree).
EXCLUDE_FILE="$(git -C "$WT_PATH" config --worktree --get core.excludesFile 2>/dev/null)"
EXCLUDE_CONTENT="$(cat "$EXCLUDE_FILE" 2>/dev/null || true)"
for pattern in "/thoughts/" "/.catalyst/.workflow-context.json" "/.catalyst/.workflow-context.json.bak" \
	"/.catalyst/worktree-provenance.json" "/.needs-cleanup" "/.orphaned_at" \
	"/.trunk/actions" "/.trunk/logs" "/.trunk/notifications" "/.trunk/out" "/.trunk/tools"; do
	assert_contains "$pattern" "$EXCLUDE_CONTENT" "exclude file contains '$pattern'"
done
# Never write to the repo's COMMON info/exclude — that file is shared by
# every linked worktree, so none of our patterns should land in it (its
# stock git-init boilerplate comments are fine and untouched either way).
COMMON_EXCLUDE="$(git -C "$SRC" rev-parse --git-path info/exclude 2>/dev/null)"
[[ $COMMON_EXCLUDE == /* ]] || COMMON_EXCLUDE="$SRC/$COMMON_EXCLUDE"
COMMON_CONTENT="$(cat "$COMMON_EXCLUDE" 2>/dev/null || true)"
if [[ $COMMON_CONTENT == *"thoughts/"* ]]; then
	fail "the shared info/exclude was NOT written to (found our pattern in it)"
else
	pass "the shared info/exclude was not written to"
fi
rm -rf "$SCRATCH"

echo ""
echo "Test 2: these artifacts don't show up in git status even when present on disk"
build_scratch
run_create wt-status
assert_eq "0" "$EXIT" "exits 0"
mkdir -p "$WT_PATH/thoughts/shared" "$WT_PATH/.catalyst"
printf 'x\n' >"$WT_PATH/thoughts/shared/doc.md"
printf '{}\n' >"$WT_PATH/.catalyst/worktree-provenance.json"
: >"$WT_PATH/.needs-cleanup"
PORCELAIN="$(git -C "$WT_PATH" status --porcelain 2>/dev/null | grep -E 'thoughts/|worktree-provenance|needs-cleanup' || true)"
assert_eq "" "$PORCELAIN" "none of the seeded artifacts appear in git status"
rm -rf "$SCRATCH"

echo ""
echo "Test 3: idempotent — calling the exclude function twice adds no duplicate lines"
build_scratch
run_create wt-idempotent
assert_eq "0" "$EXIT" "exits 0"
# Extract just the function under test (create-worktree.sh's top level expects
# real positional args and would fail if sourced directly) and re-invoke it
# against the same worktree to exercise idempotency in isolation.
FUNC_SRC="$(sed -n '/^catalyst_git_exclude_worktree_artifacts()/,/^}/p' "$CREATE_WT")"
bash -c "$FUNC_SRC"$'\n'"catalyst_git_exclude_worktree_artifacts \"\$1\"" -- "$WT_PATH"
EXCLUDE_FILE="$(git -C "$WT_PATH" config --worktree --get core.excludesFile 2>/dev/null)"
AFTER_COUNT="$(grep -cxF '/thoughts/' "$EXCLUDE_FILE" 2>/dev/null || echo 0)"
assert_eq "1" "$AFTER_COUNT" "'/thoughts/' still appears exactly once after a second call"
rm -rf "$SCRATCH"

echo ""
echo "Test 4: appending preserves a line boundary when the exclude file lacks a trailing newline"
build_scratch
run_create wt-noeof-newline
assert_eq "0" "$EXIT" "exits 0"
EXCLUDE_FILE="$(git -C "$WT_PATH" config --worktree --get core.excludesFile 2>/dev/null)"
printf 'foo' >"$EXCLUDE_FILE"
FUNC_SRC="$(sed -n '/^catalyst_git_exclude_worktree_artifacts()/,/^}/p' "$CREATE_WT")"
bash -c "$FUNC_SRC"$'\n'"catalyst_git_exclude_worktree_artifacts \"\$1\"" -- "$WT_PATH"
CONTENT="$(cat "$EXCLUDE_FILE")"
assert_contains $'foo\n' "$CONTENT" "'foo' line was not corrupted by the append"
assert_contains "/thoughts/" "$CONTENT" "'/thoughts/' was appended on its own line"
rm -rf "$SCRATCH"

echo ""
echo "Test 5: reuse path (--reuse-existing) applies the exclusions too"
build_scratch
run_create wt-reuse
assert_eq "0" "$EXIT" "exits 0"
EXCLUDE_FILE="$(git -C "$WT_PATH" config --worktree --get core.excludesFile 2>/dev/null)"
rm -f "$EXCLUDE_FILE"
run_create wt-reuse --reuse-existing
assert_eq "0" "$EXIT" "reuse exits 0"
REUSE_CONTENT="$(cat "$EXCLUDE_FILE" 2>/dev/null || true)"
assert_contains "/thoughts/" "$REUSE_CONTENT" "reuse path re-applied the exclude patterns"
rm -rf "$SCRATCH"

echo ""
echo "Passed: $PASSES  Failed: $FAILURES"
[[ $FAILURES -eq 0 ]] || exit 1
