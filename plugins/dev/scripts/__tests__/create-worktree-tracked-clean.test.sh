#!/usr/bin/env bash
# Tests for CTL-990: create-worktree.sh must not dirty TRACKED files in the
# fresh worktree. `cp -R .claude` / `cp -R .catalyst` copy the MAIN checkout's
# working-tree versions — local edits included — over the freshly-checked-out
# branch versions, so every new worktree starts with dirty tracked config and
# the dispatch-time rebase refuses to start (the ADV-1326/ADV-1308 loop).
# Untracked machine-local files (settings.local.json, …) must still be copied.
# Run: bash plugins/dev/scripts/__tests__/create-worktree-tracked-clean.test.sh
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

# Scratch layout mirrors create-worktree-base-ref.test.sh:
#   SCRATCH/origin.git   bare origin
#   SCRATCH/src          main checkout (where tracked config gets locally dirtied)
#   SCRATCH/wt           worktree base
# The committed config carries catalyst.worktree.setup=["true"] so creation
# takes the config-driven setup path (a no-op) instead of the auto-detected
# thoughts-init path, which requires a live humanlayer thoughts profile.
COMMITTED_CATALYST_CFG='{"catalyst":{"projectKey":"t","worktree":{"setup":["true"]}}}'
build_scratch() {
	SCRATCH="$(mktemp -d -t cwt-ctl990-XXXXXX)"
	ORIGIN="$SCRATCH/origin.git"
	SRC="$SCRATCH/src"
	WT="$SCRATCH/wt"
	FAKEHOME="$SCRATCH/home"
	mkdir -p "$WT" "$FAKEHOME"
	git init -q --bare "$ORIGIN"

	# Seed origin/main with TRACKED .claude/config.json + .catalyst/config.json.
	local SEED="$SCRATCH/seed"
	git clone -q "$ORIGIN" "$SEED"
	git -C "$SEED" config user.email t@t.t
	git -C "$SEED" config user.name t
	git -C "$SEED" checkout -q -b main 2>/dev/null || git -C "$SEED" checkout -q main
	mkdir -p "$SEED/.claude" "$SEED/.catalyst"
	printf '{"claude":"committed"}\n' >"$SEED/.claude/config.json"
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

# Case 1 — dirty tracked config in the main checkout must NOT dirty the worktree.
echo "Test 1: locally-modified tracked config does not dirty the fresh worktree"
build_scratch
printf '{"claude":"machine-local-edit"}\n' >"$SRC/.claude/config.json"
printf '{"catalyst":{"projectKey":"t","worktree":{"setup":["true"]},"machineLocal":true}}\n' >"$SRC/.catalyst/config.json"
printf '{"local":"untracked-settings"}\n' >"$SRC/.claude/settings.local.json"
run_create wt-clean
assert_eq "0" "$EXIT" "exits 0"
PORCELAIN="$(git -C "$WT_PATH" status --porcelain -- .claude .catalyst 2>/dev/null | grep -v '^??' || true)"
assert_eq "" "$PORCELAIN" "no tracked .claude/.catalyst changes in the fresh worktree"
assert_eq '{"claude":"committed"}' "$(cat "$WT_PATH/.claude/config.json" 2>/dev/null)" \
	"tracked .claude/config.json carries the BRANCH content, not the dirty copy"
assert_eq "$COMMITTED_CATALYST_CFG" "$(cat "$WT_PATH/.catalyst/config.json" 2>/dev/null)" \
	"tracked .catalyst/config.json carries the BRANCH content, not the dirty copy"
assert_eq '{"local":"untracked-settings"}' "$(cat "$WT_PATH/.claude/settings.local.json" 2>/dev/null)" \
	"untracked machine-local settings.local.json still copied"
rm -rf "$SCRATCH"

# Case 2 — a wholly-untracked .claude dir copies fine (checkout pathspec no-match tolerated).
echo "Test 2: untracked-only .claude dir copies without error"
build_scratch
git -C "$SRC" rm -q -r .claude
git -C "$SRC" commit -q -m "drop tracked .claude"
git -C "$SRC" push -q origin main
mkdir -p "$SRC/.claude"
printf '{"only":"untracked"}\n' >"$SRC/.claude/settings.local.json"
run_create wt-untracked
assert_eq "0" "$EXIT" "exits 0 when .claude has no tracked files"
assert_eq '{"only":"untracked"}' "$(cat "$WT_PATH/.claude/settings.local.json" 2>/dev/null)" \
	"untracked-only .claude content still copied"
rm -rf "$SCRATCH"

echo ""
echo "Passed: $PASSES  Failed: $FAILURES"
[[ $FAILURES -eq 0 ]] || exit 1
