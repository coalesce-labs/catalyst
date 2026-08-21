#!/usr/bin/env bash
# CTL-1921: create-worktree.sh must NOT copy the agent harness's own scratch
# checkouts into every new worktree.
#
# `cp -R .claude` copied the whole directory, and `.claude/worktrees/` is where the
# harness parks `wf_*` / `agent-*` working trees — several with their own
# `node_modules`. Measured on the shared checkout the day this was filed:
#
#   .claude              1.3G
#   .claude/worktrees    1.3G   <- 13 entries
#   everything else      ~40K
#
# So each new worktree inherited a byte-for-byte copy of ~1.3 GB of other agents'
# scratch to obtain ~40 KB of config. The disk sweep that found it freed
# 14 -> 156 GiB.
#
# ⛔ THE LOAD-BEARING ASSERTION IS THE ONE THAT MEASURES BYTES, NOT THE ONE THAT
# CHECKS A PATH IS ABSENT. "worktrees/ is not there" also passes if the copy
# silently stopped copying anything at all, so every exclusion case is paired with
# a positive control proving the real config DID arrive.
#
# Run: bash plugins/dev/scripts/__tests__/create-worktree-scratch-exclusion.test.sh
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

COMMITTED_CATALYST_CFG='{"catalyst":{"projectKey":"t","worktree":{"setup":["true"]}}}'
build_scratch() {
	SCRATCH="$(mktemp -d -t cwt-ctl1921-XXXXXX)"
	ORIGIN="$SCRATCH/origin.git"
	SRC="$SCRATCH/src"
	WT="$SCRATCH/wt"
	FAKEHOME="$SCRATCH/home"
	mkdir -p "$WT" "$FAKEHOME"
	git init -q --bare "$ORIGIN"

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

run_create() {
	local NAME="$1"
	shift
	OUTPUT="$(cd "$SRC" && HOME="$FAKEHOME" \
		bash "$CREATE_WT" "$NAME" main --worktree-dir "$WT" "$@" 2>&1)"
	EXIT=$?
	WT_PATH="$WT/$NAME"
}

# Plant realistic harness debris: nested worktrees, a node_modules, and a file big
# enough that a byte measurement can tell a copy from a skip.
plant_scratch_dirs() {
	mkdir -p "$SRC/.claude/worktrees/wf_deadbeef-1/node_modules/left-pad"
	mkdir -p "$SRC/.claude/worktrees/agent-abc123/.claude/worktrees/wf_nested-2"
	mkdir -p "$SRC/.claude/debug"
	# 2 MiB of "other agent's checkout"
	dd if=/dev/zero of="$SRC/.claude/worktrees/wf_deadbeef-1/blob.bin" bs=1024 count=2048 2>/dev/null
	printf 'nested junk\n' >"$SRC/.claude/worktrees/agent-abc123/.claude/worktrees/wf_nested-2/junk.txt"
	printf 'transcript\n' >"$SRC/.claude/debug/session.log"
	# ...and the real config that MUST survive, including a dotfile.
	printf '{"local":"untracked-settings"}\n' >"$SRC/.claude/settings.local.json"
	mkdir -p "$SRC/.claude/rules"
	printf 'a rule\n' >"$SRC/.claude/rules/some-rule.md"
	printf 'dotfile-content\n' >"$SRC/.claude/.hidden-config"
	# ⛔ UNTRACKED, on purpose. A TRACKED .catalyst file proves nothing about the
	# copy: the CTL-990 block below runs `git checkout -- .catalyst` in the new
	# worktree, which materialises every tracked file from the branch whether or not
	# the copy ran at all. Mutation-verified — deleting the .catalyst copy entirely
	# SURVIVED a suite whose only .catalyst assertion was on the tracked config.json.
	printf 'untracked-catalyst\n' >"$SRC/.catalyst/machine-local.json"
}

dir_bytes() { du -sk "$1" 2>/dev/null | awk '{print $1}'; }

# ── Test 1: the scratch dirs are excluded, and the config still arrives ──────
echo "Test 1: .claude/worktrees and .claude/debug are NOT copied"
build_scratch
plant_scratch_dirs
run_create wt-scratch
assert_eq "0" "$EXIT" "exits 0"

if [[ -e "$WT_PATH/.claude/worktrees" ]]; then
	fail ".claude/worktrees was copied into the new worktree (the 150 GB defect)"
else
	pass ".claude/worktrees is absent from the new worktree"
fi
if [[ -e "$WT_PATH/.claude/debug" ]]; then
	fail ".claude/debug was copied into the new worktree"
else
	pass ".claude/debug is absent from the new worktree"
fi

# ⭐ POSITIVE CONTROLS — without these, "absent" would also pass if the copy had
# broken entirely and no .claude arrived at all.
assert_eq '{"local":"untracked-settings"}' "$(cat "$WT_PATH/.claude/settings.local.json" 2>/dev/null)" \
	"POSITIVE CONTROL: untracked machine-local settings.local.json still copied"
assert_eq 'a rule' "$(cat "$WT_PATH/.claude/rules/some-rule.md" 2>/dev/null)" \
	"POSITIVE CONTROL: a real config SUBDIRECTORY is still copied recursively"
assert_eq 'dotfile-content' "$(cat "$WT_PATH/.claude/.hidden-config" 2>/dev/null)" \
	"POSITIVE CONTROL: a DOTFILE is still copied (the glob enumerates them separately)"
assert_eq '{"claude":"committed"}' "$(cat "$WT_PATH/.claude/config.json" 2>/dev/null)" \
	"POSITIVE CONTROL: tracked .claude/config.json present, at branch content (CTL-990 still holds)"
assert_eq "$COMMITTED_CATALYST_CFG" "$(cat "$WT_PATH/.catalyst/config.json" 2>/dev/null)" \
	"POSITIVE CONTROL: tracked .catalyst/config.json present at branch content"
# ⭐ THE assertion that actually exercises the .catalyst copy — see the note in
# plant_scratch_dirs. Only an UNTRACKED file can distinguish "the copy ran" from
# "git checkout restored the tracked files".
assert_eq 'untracked-catalyst' "$(cat "$WT_PATH/.catalyst/machine-local.json" 2>/dev/null)" \
	"POSITIVE CONTROL: an UNTRACKED .catalyst file arrives — proves the copy ran, not just git checkout"

# ⛔ THE BYTE ASSERTION — and an honest note on its limit.
# The source .claude is >2 MiB of scratch; the resulting copy must be a tiny
# fraction. This catches an exclusion that matches the NAME but still recurses
# (e.g. skipping `.claude/worktrees` while a nested `agent-*/.claude/worktrees`
# rides along), which a bare `[ -e ]` check would miss.
#
# What it does NOT catch: a "fix" that copies everything and deletes afterwards.
# This measures the destination tree after the fact, so a copy-then-delete looks
# identical to a skip — while still having written every byte, which is the entire
# cost being removed. Detecting that needs peak-usage or timing measurement, which
# is flaky in CI; the guard against it is the per-entry loop plus the skip line
# asserted below, not this number. Stated plainly because an earlier draft of this
# comment claimed the assertion covered it, and it does not.
SRC_KB=$(dir_bytes "$SRC/.claude")
DST_KB=$(dir_bytes "$WT_PATH/.claude")
if [[ -n $SRC_KB && -n $DST_KB && $SRC_KB -gt 2000 && $DST_KB -lt 200 ]]; then
	pass "copied .claude is ${DST_KB}K vs source ${SRC_KB}K — the scratch bytes were never written"
else
	fail "byte check: source ${SRC_KB}K, copy ${DST_KB}K (expected source >2000K and copy <200K)"
fi

# CTL-990 must still hold: no dirty TRACKED config in the fresh worktree.
PORCELAIN="$(git -C "$WT_PATH" status --porcelain -- .claude .catalyst 2>/dev/null | grep -v '^??' || true)"
assert_eq "" "$PORCELAIN" "no tracked .claude/.catalyst changes in the fresh worktree (CTL-990 preserved)"

# The skip should be announced, not silent — an operator reading the log should be
# able to tell the difference between "excluded" and "your config vanished".
if grep -q 'skipping .claude/worktrees' <<<"$OUTPUT"; then
	pass "the skip is reported in the output"
else
	fail "the skip is silent; output was: $(tr '\n' '|' <<<"$OUTPUT" | head -c 300)"
fi
rm -rf "$SCRATCH"

# ── Test 2: NEGATIVE CONTROL — no scratch dirs at all ───────────────────────
# Proves the copy is not simply broken for everyone: with nothing to skip, a
# perfectly ordinary .claude arrives intact.
echo "Test 2: NEGATIVE CONTROL — a .claude with no scratch dirs copies fully"
build_scratch
printf '{"local":"plain"}\n' >"$SRC/.claude/settings.local.json"
mkdir -p "$SRC/.claude/prompts"
printf 'p\n' >"$SRC/.claude/prompts/p.md"
run_create wt-plain
assert_eq "0" "$EXIT" "exits 0"
assert_eq '{"local":"plain"}' "$(cat "$WT_PATH/.claude/settings.local.json" 2>/dev/null)" \
	"settings.local.json copied"
assert_eq 'p' "$(cat "$WT_PATH/.claude/prompts/p.md" 2>/dev/null)" "prompts/ copied"
if grep -q 'skipping' <<<"$OUTPUT"; then
	fail "reported a skip when there was nothing to skip"
else
	pass "no skip reported when there is no scratch to skip"
fi
rm -rf "$SCRATCH"

# ── Test 3: an EMPTY .claude must not error ─────────────────────────────────
# The entry-by-entry loop uses globs; an empty dir leaves them unmatched, and an
# unguarded loop would try to copy a literal '.claude/*'.
echo "Test 3: an empty .claude directory is handled without error"
build_scratch
git -C "$SRC" rm -q -r .claude
git -C "$SRC" commit -q -m "drop tracked .claude"
git -C "$SRC" push -q origin main
mkdir -p "$SRC/.claude"
run_create wt-empty
assert_eq "0" "$EXIT" "exits 0 on an empty .claude"
if grep -qE "cannot stat|No such file" <<<"$OUTPUT"; then
	fail "unmatched glob leaked a literal path: $(tr '\n' '|' <<<"$OUTPUT" | head -c 200)"
else
	pass "no unmatched-glob error"
fi
rm -rf "$SCRATCH"

echo ""
echo "Passed: $PASSES  Failed: $FAILURES"
[[ $FAILURES -eq 0 ]] || exit 1
