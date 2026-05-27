#!/usr/bin/env bash
# Shell tests for lib/worktree-rebase.sh + is_rebase_phase (CTL-667 Phase 1) —
# front-load merge-conflict surfacing: mechanically rebase a build-phase
# worktree onto origin/<base> at dispatch time.
#
# Builds a REAL git fixture (bare origin + working clone + an upstream-editor
# clone) so the rebase helpers are exercised against actual git, not a stub.
#
# Run: bash plugins/dev/scripts/lib/__tests__/worktree-rebase.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REBASE_LIB="$LIB_DIR/worktree-rebase.sh"
SEQUENCE_LIB="$LIB_DIR/phase-sequence.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t worktree-rebase-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

# Deterministic, non-interactive git everywhere.
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@test
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@test
export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then pass "$label"; else
		fail "$label — expected '$expected', got '$actual'"
	fi
}

# Source the units under test.
# shellcheck source=../phase-sequence.sh
source "$SEQUENCE_LIB"
# shellcheck source=../worktree-rebase.sh
source "$REBASE_LIB"

# ─── Fixture builder ────────────────────────────────────────────────────────
# new_fixture <tag> → sets ORIGIN (bare), WORK (clone, on branch `work`), UP
# (upstream-editor clone, on main). Seeds an initial commit on main with
# shared.txt (the conflict target) + a tracked .catalyst/config.json.
new_fixture() {
	local tag="$1"
	ORIGIN="$SCRATCH/$tag/origin.git"
	WORK="$SCRATCH/$tag/work"
	UP="$SCRATCH/$tag/up"
	git init --quiet --bare -b main "$ORIGIN"

	git clone --quiet "$ORIGIN" "$UP"
	(
		cd "$UP"
		printf 'base-line\n' >shared.txt
		mkdir -p .catalyst
		printf '{"committed":true}\n' >.catalyst/config.json
		git add -A
		git commit --quiet -m "initial"
		git push --quiet origin main
	)

	git clone --quiet "$ORIGIN" "$WORK"
	(cd "$WORK" && git checkout --quiet -b work)
}

# advance_origin_main_clean → push a NON-conflicting commit to origin/main
# (touches a brand-new file only).
advance_origin_main_clean() {
	(
		cd "$UP"
		git checkout --quiet main
		printf 'upstream-feature\n' >upstream.txt
		git add -A
		git commit --quiet -m "upstream clean feature"
		git push --quiet origin main
	)
}

# advance_origin_main_conflict → push a commit editing shared.txt's only line.
advance_origin_main_conflict() {
	(
		cd "$UP"
		git checkout --quiet main
		printf 'upstream-edit\n' >shared.txt
		git add -A
		git commit --quiet -m "upstream conflicting edit"
		git push --quiet origin main
	)
}

echo "worktree-rebase tests (CTL-667)"

# ── 1. is_rebase_phase: build phases true, the rest false ───────────────────
echo "1. is_rebase_phase membership"
for p in research plan implement verify review; do
	if is_rebase_phase "$p"; then pass "is_rebase_phase $p → true"; else fail "is_rebase_phase $p → true"; fi
done
for p in triage pr remediate monitor-merge monitor-deploy bogus ""; do
	if is_rebase_phase "$p"; then fail "is_rebase_phase '$p' → false"; else pass "is_rebase_phase '$p' → false"; fi
done

# ── 2. resolve_base_branch precedence ───────────────────────────────────────
echo "2. resolve_base_branch"
new_fixture t2
(
	cd "$WORK"
	# (a) explicit override wins
	CATALYST_BASE_BRANCH=develop bash -c "source '$REBASE_LIB'; resolve_base_branch"
) >"$SCRATCH/t2.a" 2>/dev/null
assert_eq "develop" "$(cat "$SCRATCH/t2.a")" "resolve_base_branch honors CATALYST_BASE_BRANCH"

(
	cd "$WORK"
	unset CATALYST_BASE_BRANCH
	# origin/HEAD is set by clone → default branch (main)
	resolve_base_branch
) >"$SCRATCH/t2.b" 2>/dev/null
assert_eq "main" "$(cat "$SCRATCH/t2.b")" "resolve_base_branch uses origin/HEAD default branch"

(
	cd "$WORK"
	unset CATALYST_BASE_BRANCH
	git remote set-head origin --delete 2>/dev/null
	resolve_base_branch
) >"$SCRATCH/t2.c" 2>/dev/null
assert_eq "main" "$(cat "$SCRATCH/t2.c")" "resolve_base_branch falls back to main with no origin/HEAD"

# ── 3. noise_stash_push / noise_stash_pop ───────────────────────────────────
echo "3. noise stash push/pop"
new_fixture t3
(
	cd "$WORK"
	# Dirty a tracked noise file + create an untracked .trunk/out entry.
	printf '{"committed":false,"dirty":true}\n' >.catalyst/config.json
	mkdir -p .trunk/out
	printf 'cache-data\n' >.trunk/out/cache

	marker="$(noise_stash_push)"
	echo "$marker" >"$SCRATCH/t3.marker"
	# After push, the working tree must be clean of the noise paths.
	git status --porcelain >"$SCRATCH/t3.afterpush"
	cat .catalyst/config.json >"$SCRATCH/t3.config_afterpush"

	noise_stash_pop "$marker"
	cat .catalyst/config.json >"$SCRATCH/t3.config_afterpop"
	cat .trunk/out/cache 2>/dev/null >"$SCRATCH/t3.cache_afterpop" || true
)
assert_eq "1" "$(cat "$SCRATCH/t3.marker")" "noise_stash_push reports something stashed"
assert_eq "" "$(cat "$SCRATCH/t3.afterpush")" "working tree clean of noise after push"
assert_eq '{"committed":true}' "$(cat "$SCRATCH/t3.config_afterpush")" "config reverted to committed content after push"
assert_eq '{"committed":false,"dirty":true}' "$(cat "$SCRATCH/t3.config_afterpop")" "config dirty content restored after pop"
assert_eq "cache-data" "$(cat "$SCRATCH/t3.cache_afterpop")" "untracked .trunk/out/cache restored after pop"

# nothing-to-stash → push no-op (empty marker), pop safe no-op (rc 0)
new_fixture t3b
(
	cd "$WORK"
	marker="$(noise_stash_push)"
	echo "$marker" >"$SCRATCH/t3b.marker"
	noise_stash_pop "$marker"
	echo "$?" >"$SCRATCH/t3b.poprc"
)
assert_eq "" "$(cat "$SCRATCH/t3b.marker")" "noise_stash_push no-op marker when nothing present/dirty"
assert_eq "0" "$(cat "$SCRATCH/t3b.poprc")" "noise_stash_pop safe no-op returns 0"

# ── 4. rebase_onto_base — clean ─────────────────────────────────────────────
echo "4. rebase_onto_base clean"
new_fixture t4
advance_origin_main_clean
(
	cd "$WORK"
	# local non-conflicting commit on a new file
	printf 'local-feature\n' >local.txt
	git add -A
	git commit --quiet -m "local feature"
	rebase_onto_base "main"
	echo "$?" >"$SCRATCH/t4.rc"
	# both the rebased local commit and the new base commit are present
	[[ -f local.txt && -f upstream.txt ]] && echo yes >"$SCRATCH/t4.bothfiles" || echo no >"$SCRATCH/t4.bothfiles"
	[[ -d .git/rebase-merge ]] && echo leftover >"$SCRATCH/t4.rebasedir" || echo clean >"$SCRATCH/t4.rebasedir"
)
assert_eq "0" "$(cat "$SCRATCH/t4.rc")" "clean rebase returns 0"
assert_eq "yes" "$(cat "$SCRATCH/t4.bothfiles")" "clean rebase: both local + base commits present"
assert_eq "clean" "$(cat "$SCRATCH/t4.rebasedir")" "clean rebase: no .git/rebase-merge left behind"

# ── 5. rebase_onto_base — conflict (abort + sentinel 2) ─────────────────────
echo "5. rebase_onto_base conflict"
new_fixture t5
advance_origin_main_conflict
(
	cd "$WORK"
	printf 'local-edit\n' >shared.txt
	git add -A
	git commit --quiet -m "local conflicting edit"
	ORIG_HEAD="$(git rev-parse HEAD)"
	echo "$ORIG_HEAD" >"$SCRATCH/t5.orig"
	rebase_onto_base "main"
	echo "$?" >"$SCRATCH/t5.rc"
	git rev-parse HEAD >"$SCRATCH/t5.head"
	[[ -d .git/rebase-merge ]] && echo leftover >"$SCRATCH/t5.rebasedir" || echo clean >"$SCRATCH/t5.rebasedir"
	git status --porcelain >"$SCRATCH/t5.status"
)
assert_eq "2" "$(cat "$SCRATCH/t5.rc")" "conflicting rebase returns sentinel 2"
assert_eq "$(cat "$SCRATCH/t5.orig")" "$(cat "$SCRATCH/t5.head")" "conflict abort: HEAD back at original local commit"
assert_eq "clean" "$(cat "$SCRATCH/t5.rebasedir")" "conflict abort: no .git/rebase-merge left behind"
assert_eq "" "$(cat "$SCRATCH/t5.status")" "conflict abort: working tree clean"

# ── 6. rebase_onto_base — noise stashed across a clean rebase ───────────────
echo "6. rebase_onto_base survives dirty noise"
new_fixture t6
advance_origin_main_clean
(
	cd "$WORK"
	printf 'local-feature\n' >local.txt
	git add -A
	git commit --quiet -m "local feature"
	# Dirty a tracked noise file — plain rebase would refuse without a stash.
	printf '{"committed":false,"dirty":true}\n' >.catalyst/config.json
	rebase_onto_base "main"
	echo "$?" >"$SCRATCH/t6.rc"
	cat .catalyst/config.json >"$SCRATCH/t6.config"
	[[ -f upstream.txt ]] && echo yes >"$SCRATCH/t6.base" || echo no >"$SCRATCH/t6.base"
)
assert_eq "0" "$(cat "$SCRATCH/t6.rc")" "clean rebase with dirty noise returns 0 (noise stashed)"
assert_eq '{"committed":false,"dirty":true}' "$(cat "$SCRATCH/t6.config")" "dirty noise restored after rebase"
assert_eq "yes" "$(cat "$SCRATCH/t6.base")" "rebase still advanced onto new base"

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
