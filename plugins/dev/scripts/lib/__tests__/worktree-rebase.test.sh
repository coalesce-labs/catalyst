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

# ─── CTL-707 Phase 2: rebase_onto_base_classified ───────────────────────────
# Each fixture uses the same new_fixture / advance_origin_* helpers above.
# EVENTS_DIR is pointed at a test-local scratch dir so telemetry doesn't
# pollute the real event log. ORCH_ID / TICKET / PHASE use test values.

export EVENTS_DIR="${SCRATCH}/events"
export ORCH_ID="test-orch" TICKET="CTL-TEST" PHASE="implement"

# Helper: last event line from the test EVENTS_DIR.
last_telem_line() {
  tail -n1 "${EVENTS_DIR}/$(date -u +%Y-%m).jsonl" 2>/dev/null || echo ""
}

# ── 7. rebase_onto_base_classified — clean rebase → 0, strategy clean ──────
echo "7. rebase_onto_base_classified clean → 0"
new_fixture t7
advance_origin_main_clean
(
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t7.rc"
  [[ -f local.txt && -f upstream.txt ]] && echo yes >"$SCRATCH/t7.both" || echo no >"$SCRATCH/t7.both"
)
assert_eq "0" "$(cat "$SCRATCH/t7.rc")" "classified clean rebase → rc 0"
assert_eq "yes" "$(cat "$SCRATCH/t7.both")" "classified clean: both local + base commits present"
assert_eq "clean" \
  "$(jq -r '.body.payload.strategy' <<<"$(last_telem_line)")" \
  "classified clean: auto-rebased(clean) event emitted"

# ── 8. tests-only conflict → 0, additive resolve ────────────────────────────
echo "8. rebase_onto_base_classified tests-only conflict → 0"
new_fixture t8
(
  cd "$UP"
  git checkout --quiet main
  mkdir -p src
  printf 'test-a\n' >src/foo.test.ts
  git add -A && git commit --quiet -m "upstream test"
  git push --quiet origin main
)
(
  cd "$WORK"
  mkdir -p src
  printf 'test-b\n' >src/foo.test.ts
  git add -A && git commit --quiet -m "local test (same file, different content)"
  ORIG_HEAD="$(git rev-parse HEAD)"
  echo "$ORIG_HEAD" >"$SCRATCH/t8.orig"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t8.rc"
  git log --oneline >"$SCRATCH/t8.log"
)
assert_eq "0" "$(cat "$SCRATCH/t8.rc")" "tests-only conflict → rc 0 (additive)"
# Work commit should still be in history after --continue.
WORK_IN_LOG="no"
grep -q "local test" "$SCRATCH/t8.log" && WORK_IN_LOG="yes"
assert_eq "yes" "$WORK_IN_LOG" "tests-only: work commit retained after --continue"
assert_eq "additive" \
  "$(jq -r '.body.payload.strategy' <<<"$(last_telem_line)")" \
  "tests-only: auto-rebased(additive) event emitted"

# ── 9. noise-only conflict (.catalyst/config.json) → 0, take-ours ───────────
echo "9. rebase_onto_base_classified noise-only conflict → 0"
new_fixture t9
(
  cd "$UP"
  git checkout --quiet main
  printf '{"upstream":true}\n' >.catalyst/config.json
  git add -A && git commit --quiet -m "upstream config change"
  git push --quiet origin main
)
(
  cd "$WORK"
  printf '{"local":true}\n' >.catalyst/config.json
  git add -A && git commit --quiet -m "local config change"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t9.rc"
  cat .catalyst/config.json >"$SCRATCH/t9.config"
)
assert_eq "0" "$(cat "$SCRATCH/t9.rc")" "noise-only conflict → rc 0 (take-ours)"
# In rebase context --ours = origin/main; noise-take-ours uses upstream config.
assert_eq '{"upstream":true}' "$(cat "$SCRATCH/t9.config")" "noise take-ours: upstream config (ours=origin/main in rebase)"

# ── 10. thoughts/** conflict → 3, HEAD restored ─────────────────────────────
echo "10. rebase_onto_base_classified thoughts/** conflict → 3"
new_fixture t10
(
  cd "$UP"
  git checkout --quiet main
  mkdir -p thoughts/shared
  printf 'upstream-research\n' >thoughts/shared/notes.md
  git add -A && git commit --quiet -m "upstream thoughts"
  git push --quiet origin main
)
(
  cd "$WORK"
  mkdir -p thoughts/shared
  printf 'local-research\n' >thoughts/shared/notes.md
  git add -A && git commit --quiet -m "local thoughts"
  ORIG_HEAD="$(git rev-parse HEAD)"
  echo "$ORIG_HEAD" >"$SCRATCH/t10.orig"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t10.rc"
  git rev-parse HEAD >"$SCRATCH/t10.head"
  [[ -d .git/rebase-merge ]] && echo leftover >"$SCRATCH/t10.rebasedir" || echo clean >"$SCRATCH/t10.rebasedir"
)
assert_eq "3" "$(cat "$SCRATCH/t10.rc")" "thoughts conflict → rc 3"
assert_eq "$(cat "$SCRATCH/t10.orig")" "$(cat "$SCRATCH/t10.head")" "thoughts conflict: HEAD restored"
assert_eq "clean" "$(cat "$SCRATCH/t10.rebasedir")" "thoughts conflict: no rebase-merge leftover"
# Stalled event must carry reason=thoughts_symlink_broken
STALL_REASON="$(jq -r '.body.payload.reason' <<<"$(last_telem_line)")"
assert_eq "thoughts_symlink_broken" "$STALL_REASON" "thoughts conflict: stalled event reason"

# ── 11. source conflict → 2, CTL-708 stub unavailable, HEAD restored ─────────
echo "11. rebase_onto_base_classified source conflict → 2"
new_fixture t11
advance_origin_main_conflict
(
  cd "$WORK"
  printf 'local-edit\n' >shared.txt
  git add -A && git commit --quiet -m "local conflicting edit"
  ORIG_HEAD="$(git rev-parse HEAD)"
  echo "$ORIG_HEAD" >"$SCRATCH/t11.orig"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t11.rc"
  git rev-parse HEAD >"$SCRATCH/t11.head"
  [[ -d .git/rebase-merge ]] && echo leftover >"$SCRATCH/t11.rebasedir" || echo clean >"$SCRATCH/t11.rebasedir"
)
assert_eq "2" "$(cat "$SCRATCH/t11.rc")" "source conflict → rc 2"
assert_eq "$(cat "$SCRATCH/t11.orig")" "$(cat "$SCRATCH/t11.head")" "source conflict: HEAD restored"
assert_eq "clean" "$(cat "$SCRATCH/t11.rebasedir")" "source conflict: no rebase-merge leftover"
STALL_REASON2="$(jq -r '.body.payload.reason' <<<"$(last_telem_line)")"
assert_eq "source_conflict_ctl708_unavailable" "$STALL_REASON2" "source conflict: stalled reason"
# Categorize event is the second-to-last event; find it by filtering event name.
CAT_LINE_T11="$(grep 'rebase-conflict-categorized' "${EVENTS_DIR}/$(date -u +%Y-%m).jsonl" 2>/dev/null | tail -n1 || echo "")"
if [[ -n "$CAT_LINE_T11" ]]; then
  SC="$(jq -r '.body.payload.source_count' <<<"$CAT_LINE_T11")"
  TC="$(jq -r '.body.payload.test_count' <<<"$CAT_LINE_T11")"
  NC="$(jq -r '.body.payload.noise_count' <<<"$CAT_LINE_T11")"
  THKC="$(jq -r '.body.payload.thoughts_count' <<<"$CAT_LINE_T11")"
  assert_eq "1" "$SC" "source conflict categorize: source_count=1"
  assert_eq "0" "$TC" "source conflict categorize: test_count=0"
  assert_eq "0" "$NC" "source conflict categorize: noise_count=0"
  assert_eq "0" "$THKC" "source conflict categorize: thoughts_count=0"
else
  fail "source conflict categorize: no categorize event found"
fi

# ── 12. mixed test+noise conflict → 0, both resolved ────────────────────────
echo "12. rebase_onto_base_classified mixed test+noise conflict → 0"
new_fixture t12
(
  cd "$UP"
  git checkout --quiet main
  mkdir -p src
  printf 'upstream-test\n' >src/bar.test.ts
  printf '{"upstream":true}\n' >.catalyst/config.json
  git add -A && git commit --quiet -m "upstream test + config"
  git push --quiet origin main
)
(
  cd "$WORK"
  mkdir -p src
  printf 'local-test\n' >src/bar.test.ts
  printf '{"local":true}\n' >.catalyst/config.json
  git add -A && git commit --quiet -m "local test + config"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t12.rc"
  cat .catalyst/config.json >"$SCRATCH/t12.config"
)
assert_eq "0" "$(cat "$SCRATCH/t12.rc")" "mixed test+noise → rc 0"
assert_eq '{"upstream":true}' "$(cat "$SCRATCH/t12.config")" "mixed: noise takes upstream (ours=origin/main in rebase)"

# ── 13. fetch failure (bogus base) → 1, un-rebased ──────────────────────────
echo "13. rebase_onto_base_classified fetch failure → 1"
new_fixture t13
(
  cd "$WORK"
  printf 'local\n' >local.txt
  git add -A && git commit --quiet -m "local"
  ORIG_HEAD="$(git rev-parse HEAD)"
  echo "$ORIG_HEAD" >"$SCRATCH/t13.orig"
  rebase_onto_base_classified "no-such-branch-xyz"
  echo "$?" >"$SCRATCH/t13.rc"
  git rev-parse HEAD >"$SCRATCH/t13.head"
)
assert_eq "1" "$(cat "$SCRATCH/t13.rc")" "fetch failure → rc 1"
assert_eq "$(cat "$SCRATCH/t13.orig")" "$(cat "$SCRATCH/t13.head")" "fetch failure: HEAD unchanged"

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
