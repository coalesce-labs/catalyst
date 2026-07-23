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
# shared.txt (the conflict target) + tracked .catalyst/config.json and
# .claude/config.json (both noise-stash members — CTL-990).
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
		mkdir -p .catalyst .claude
		printf '{"committed":true}\n' >.catalyst/config.json
		printf '{"claude":true}\n' >.claude/config.json
		printf '{"sessionId":"seed","pid":1,"acquiredAt":0}\n' >.claude/scheduled_tasks.lock
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

# ─── CTL-990: dirty-tree precheck, .claude noise, continue guard ─────────────
# Root incident: a tracked dirty file OUTSIDE the noise set makes `git rebase`
# refuse to START (pre-flight, not a conflict). classify_conflicted_files then
# sees 0 unmerged paths, every branch is skipped, and the old code fell through
# to a bogus `git rebase --continue` → {continue_failed, files:[], category:
# unknown} — looping ~1,300 events on ADV-1326/ADV-1308.

# ── 14. dirty tracked NON-noise file → typed precheck stall (rc 2) ──────────
echo "14. rebase_onto_base_classified dirty tracked source file → precheck stall"
new_fixture t14
advance_origin_main_clean
(
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  # Uncommitted edit to a tracked non-noise file — survives noise_stash_push.
  printf 'dirty-edit\n' >shared.txt
  ORIG_HEAD="$(git rev-parse HEAD)"
  echo "$ORIG_HEAD" >"$SCRATCH/t14.orig"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t14.rc"
  echo "${REBASE_LAST_STALL_REASON:-}" >"$SCRATCH/t14.reason_var"
  git rev-parse HEAD >"$SCRATCH/t14.head"
  cat shared.txt >"$SCRATCH/t14.dirty"
  [[ -d .git/rebase-merge ]] && echo leftover >"$SCRATCH/t14.rebasedir" || echo clean >"$SCRATCH/t14.rebasedir"
)
assert_eq "2" "$(cat "$SCRATCH/t14.rc")" "precheck stall → rc 2"
assert_eq "rebase_refused_dirty_tree" "$(cat "$SCRATCH/t14.reason_var")" \
  "REBASE_LAST_STALL_REASON carries the typed reason"
assert_eq "$(cat "$SCRATCH/t14.orig")" "$(cat "$SCRATCH/t14.head")" "precheck: HEAD unchanged"
assert_eq "dirty-edit" "$(cat "$SCRATCH/t14.dirty")" "precheck: dirty edit left intact"
assert_eq "clean" "$(cat "$SCRATCH/t14.rebasedir")" "precheck: no rebase-merge leftover"
STALL14="$(last_telem_line)"
assert_eq "rebase_refused_dirty_tree" "$(jq -r '.body.payload.reason' <<<"$STALL14")" \
  "precheck: stalled event reason=rebase_refused_dirty_tree"
assert_eq "precheck" "$(jq -r '.body.payload.category' <<<"$STALL14")" \
  "precheck: stalled event category=precheck"
assert_eq "shared.txt" "$(jq -r '.body.payload.files[0]' <<<"$STALL14")" \
  "precheck: offending dirty file listed in event"

# ── 15. dirty tracked .claude/config.json → stashed noise, clean rebase ─────
echo "15. rebase_onto_base_classified dirty .claude/config.json is stashed noise"
new_fixture t15
advance_origin_main_clean
(
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  # The ADV-1326/ADV-1308 blocker: a tracked, locally-modified .claude config.
  printf '{"claude":false,"dirty":true}\n' >.claude/config.json
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t15.rc"
  cat .claude/config.json >"$SCRATCH/t15.config"
  [[ -f upstream.txt ]] && echo yes >"$SCRATCH/t15.base" || echo no >"$SCRATCH/t15.base"
)
assert_eq "0" "$(cat "$SCRATCH/t15.rc")" "dirty .claude/config.json → rc 0 (stashed as noise)"
assert_eq '{"claude":false,"dirty":true}' "$(cat "$SCRATCH/t15.config")" \
  ".claude/config.json dirty content restored after rebase"
assert_eq "yes" "$(cat "$SCRATCH/t15.base")" "rebase still advanced onto new base"

# ── 16. .claude/config.json CONFLICT classifies as noise; other .claude files stay source ──
echo "16. classifier sync: .claude/config.json conflict → noise; .claude/skills/* → source"
new_fixture t16
(
  cd "$UP"
  git checkout --quiet main
  printf '{"upstream":true}\n' >.claude/config.json
  git add -A && git commit --quiet -m "upstream claude config"
  git push --quiet origin main
)
(
  cd "$WORK"
  printf '{"local":true}\n' >.claude/config.json
  git add -A && git commit --quiet -m "local claude config"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t16.rc"
  cat .claude/config.json >"$SCRATCH/t16.config"
)
assert_eq "0" "$(cat "$SCRATCH/t16.rc")" ".claude/config.json conflict → rc 0 (noise take-ours)"
assert_eq '{"upstream":true}' "$(cat "$SCRATCH/t16.config")" \
  ".claude/config.json noise take-ours: upstream content wins"

# Non-noise .claude content (skills/agents/rules) must STAY a source conflict —
# auto-resolving it take-ours would silently discard committed branch work.
new_fixture t16b
(
  cd "$UP"
  git checkout --quiet main
  mkdir -p .claude/skills
  printf 'upstream-skill\n' >.claude/skills/foo.md
  git add -A && git commit --quiet -m "upstream skill"
  git push --quiet origin main
)
(
  cd "$WORK"
  mkdir -p .claude/skills
  printf 'local-skill\n' >.claude/skills/foo.md
  git add -A && git commit --quiet -m "local skill"
  ORIG_HEAD="$(git rev-parse HEAD)"
  echo "$ORIG_HEAD" >"$SCRATCH/t16b.orig"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t16b.rc"
  git rev-parse HEAD >"$SCRATCH/t16b.head"
)
assert_eq "2" "$(cat "$SCRATCH/t16b.rc")" ".claude/skills conflict stays source → rc 2"
assert_eq "$(cat "$SCRATCH/t16b.orig")" "$(cat "$SCRATCH/t16b.head")" \
  ".claude/skills conflict: HEAD restored (no silent take-ours)"

# ── 17. rebase_in_progress predicate ────────────────────────────────────────
echo "17. rebase_in_progress predicate"
new_fixture t17
(
  cd "$WORK"
  if rebase_in_progress; then echo yes; else echo no; fi >"$SCRATCH/t17.idle"
)
assert_eq "no" "$(cat "$SCRATCH/t17.idle")" "rebase_in_progress=false in an idle repo"
advance_origin_main_conflict
(
  cd "$WORK"
  printf 'local-edit\n' >shared.txt
  git add -A && git commit --quiet -m "local conflicting edit"
  git fetch --quiet origin main 2>/dev/null
  git rebase --quiet "origin/main" 2>/dev/null # stops on the conflict
  if rebase_in_progress; then echo yes; else echo no; fi >"$SCRATCH/t17.during"
  git rebase --abort 2>/dev/null
  if rebase_in_progress; then echo yes; else echo no; fi >"$SCRATCH/t17.after"
)
assert_eq "yes" "$(cat "$SCRATCH/t17.during")" "rebase_in_progress=true mid-conflict"
assert_eq "no" "$(cat "$SCRATCH/t17.after")" "rebase_in_progress=false after abort"

# ── 19. untracked-overwrite refusal → dirty-tree stall with files listed ────
# git ALSO refuses to start a rebase when an UNTRACKED file would be
# overwritten by the incoming base — invisible to the tracked-only precheck.
# The no-rebase-in-progress guard must report it as the dirty-tree class with
# the worktree's dirt listed, not as an opaque internal/[] stall.
echo "19. untracked-overwrite refusal → rebase_refused_dirty_tree with files"
new_fixture t19
(
  cd "$UP"
  git checkout --quiet main
  printf 'upstream-version\n' >colliding.txt
  git add -A && git commit --quiet -m "upstream adds colliding.txt"
  git push --quiet origin main
)
(
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  # UNTRACKED file at the path origin/main now tracks → rebase refuses to start.
  printf 'untracked-local-version\n' >colliding.txt
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t19.rc"
  echo "${REBASE_LAST_STALL_REASON:-}" >"$SCRATCH/t19.reason_var"
  cat colliding.txt >"$SCRATCH/t19.untracked"
)
assert_eq "2" "$(cat "$SCRATCH/t19.rc")" "untracked-overwrite refusal → rc 2"
assert_eq "rebase_refused_dirty_tree" "$(cat "$SCRATCH/t19.reason_var")" \
  "untracked-overwrite: typed dirty-tree reason (not no_rebase_in_progress)"
assert_eq "untracked-local-version" "$(cat "$SCRATCH/t19.untracked")" \
  "untracked-overwrite: local untracked file left intact"
STALL19="$(last_telem_line)"
assert_eq "precheck" "$(jq -r '.body.payload.category' <<<"$STALL19")" \
  "untracked-overwrite: stalled event category=precheck"
T19_HAS_FILE="$(jq -r '.body.payload.files | index("colliding.txt") != null' <<<"$STALL19")"
assert_eq "true" "$T19_HAS_FILE" "untracked-overwrite: colliding file listed in event"

# ── 18. refresh_worktree (periodic path) stashes noise too ──────────────────
echo "18. refresh_worktree stashes noise (periodic timer path)"
new_fixture t18
advance_origin_main_clean
(
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  printf '{"committed":false,"dirty":true}\n' >.catalyst/config.json
)
# shellcheck source=../worktree-refresh.sh
source "$LIB_DIR/worktree-refresh.sh"
refresh_worktree "$WORK" main
echo "$?" >"$SCRATCH/t18.rc"
assert_eq "0" "$(cat "$SCRATCH/t18.rc")" "refresh with dirty noise → rc 0"
assert_eq '{"committed":false,"dirty":true}' "$(cat "$WORK/.catalyst/config.json")" \
  "refresh: dirty noise restored after rebase"
T18_BASE="no"; [[ -f "$WORK/upstream.txt" ]] && T18_BASE="yes"
assert_eq "yes" "$T18_BASE" "refresh: worktree advanced onto new base"

# ── 20. deleted tracked .claude/scheduled_tasks.lock → stashed noise, clean rebase
echo "20. deleted scheduled_tasks.lock is settling-debris noise → rc 0"
new_fixture t20
advance_origin_main_clean
(
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  # Simulate the dying worker: delete the tracked lock file (unstaged deletion).
  rm -f .claude/scheduled_tasks.lock
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t20.rc"
  [[ -f upstream.txt ]] && echo yes >"$SCRATCH/t20.base" || echo no >"$SCRATCH/t20.base"
  git diff --quiet && echo clean >"$SCRATCH/t20.tree" || echo dirty >"$SCRATCH/t20.tree"
)
assert_eq "0" "$(cat "$SCRATCH/t20.rc")" "deleted scheduled_tasks.lock → rc 0 (stashed as noise)"
assert_eq "yes" "$(cat "$SCRATCH/t20.base")" "rebase still advanced onto new base"

# ── 20b. noise_stash_push captures a deleted tracked noise path
echo "20b. noise_stash_push stashes a deleted tracked noise file"
new_fixture t20b
(
  cd "$WORK"
  rm -f .claude/scheduled_tasks.lock           # tracked deletion, file absent on disk
  marker="$(noise_stash_push)"
  echo "$marker" >"$SCRATCH/t20b.marker"
  git status --porcelain -- .claude/scheduled_tasks.lock >"$SCRATCH/t20b.afterpush"
  noise_stash_pop "$marker"
)
assert_eq "1" "$(cat "$SCRATCH/t20b.marker")" "noise_stash_push reports the deleted noise stashed"
assert_eq "" "$(cat "$SCRATCH/t20b.afterpush")" "deleted noise path clean after stash push"

# ── 21. real uncommitted source still parks IMMEDIATELY (CTL-1068 preserved) ─
echo "21. real source dirt → immediate rebase_refused_dirty_tree (no grace)"
new_fixture t21
advance_origin_main_clean
(
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  printf 'dirty-edit\n' >shared.txt            # real tracked source, uncommitted
  CATALYST_REBASE_GRACE_TOTAL_S=0 CATALYST_REBASE_GRACE_INTERVAL_S=0 \
    rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t21.rc"
  echo "${REBASE_LAST_STALL_REASON:-}" >"$SCRATCH/t21.reason"
  # 21b: capture RT_PRECHECK inside the subshell where it is set (CTL-1076 Phase 3)
  printf '%s\n' "${RT_PRECHECK[@]+"${RT_PRECHECK[@]}"}" >"$SCRATCH/t21.files"
)
assert_eq "2" "$(cat "$SCRATCH/t21.rc")" "real source dirt → rc 2"
assert_eq "rebase_refused_dirty_tree" "$(cat "$SCRATCH/t21.reason")" "real source → typed reason"

# ── 21b. RT_PRECHECK carries offending file name after stall ──────────────────
echo "21b. RT_PRECHECK carries offending file name after stall"
assert_eq "shared.txt" "$(grep -Fx shared.txt "$SCRATCH/t21.files")" \
  "RT_PRECHECK lists the dirty source file"

# ── 22. settling-debris-only (untracked node_modules/) → grace re-probe → clean
echo "22. untracked node_modules settling-debris → grace re-probe → rc 0"
new_fixture t22
advance_origin_main_clean
(
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  mkdir -p node_modules/pkg
  printf 'junk\n' >node_modules/pkg/index.js   # untracked settling-debris
  CATALYST_REBASE_GRACE_TOTAL_S=0 CATALYST_REBASE_GRACE_INTERVAL_S=0 \
    rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t22.rc"
  [[ -f upstream.txt ]] && echo yes >"$SCRATCH/t22.base" || echo no >"$SCRATCH/t22.base"
)
assert_eq "0" "$(cat "$SCRATCH/t22.rc")" "node_modules-only debris → rc 0 after grace re-probe"
assert_eq "yes" "$(cat "$SCRATCH/t22.base")" "debris re-probe still advanced onto new base"

# ── 23. mixed real source + debris → stalls (real source dominates) ──────────
echo "23. real source + debris mixed → rc 2 (real source forces park)"
new_fixture t23
advance_origin_main_clean
(
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  printf 'dirty-edit\n' >shared.txt            # real source
  mkdir -p node_modules/pkg
  printf 'junk\n' >node_modules/pkg/index.js   # debris
  CATALYST_REBASE_GRACE_TOTAL_S=0 CATALYST_REBASE_GRACE_INTERVAL_S=0 \
    rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t23.rc"
)
assert_eq "2" "$(cat "$SCRATCH/t23.rc")" "mixed source+debris → rc 2"

# ── 24. _is_settling_debris_path matches debris, rejects source ───────────────
echo "24. _is_settling_debris_path classification"
for d in node_modules/pkg/index.js build/output.log foo.log .claude/scheduled_tasks.lock; do
  if _is_settling_debris_path "$d"; then pass "_is_settling_debris_path $d → true"
  else fail "_is_settling_debris_path $d → true (expected debris)"; fi
done
for s in src/index.ts shared.txt plugins/dev/scripts/foo.sh; do
  if _is_settling_debris_path "$s"; then fail "_is_settling_debris_path $s → false (expected source)"
  else pass "_is_settling_debris_path $s → false"; fi
done

# ── 25. CTL-1120: orch-monitor build artifact paths classify as settling-debris ─
echo "25. _is_settling_debris_path — orch-monitor build artifacts (CTL-1120)"
for d in \
  plugins/dev/scripts/orch-monitor/public/assets/Board-4MoUfxM8.js \
  plugins/dev/scripts/orch-monitor/public/assets/main-ynmsqRqh.css \
  plugins/dev/scripts/orch-monitor/public/index.html \
  orch-monitor/public/assets/main-abc123.js \
  orch-monitor/public/index.html; do
  if _is_settling_debris_path "$d"; then pass "_is_settling_debris_path $d → true"
  else fail "_is_settling_debris_path $d → true (expected debris)"; fi
done
# real orch-monitor source must NOT be classified as debris
for s in \
  plugins/dev/scripts/orch-monitor/server.ts \
  plugins/dev/scripts/orch-monitor/ui/src/main.tsx \
  plugins/dev/scripts/orch-monitor/public/mockups/index.html \
  plugins/dev/scripts/orch-monitor/public/favicon.svg; do
  if _is_settling_debris_path "$s"; then fail "_is_settling_debris_path $s → false (expected source)"
  else pass "_is_settling_debris_path $s → false"; fi
done

# ── 26. mixed orch-monitor artifact + real source still rc 2 ─────────────────
echo "26. mixed orch-monitor artifact + real source → rc 2 (exclusive-artifact gate)"
(
  new_fixture t26
  cd "$WORK"
  printf 'local-feature\n' >local.txt
  git add -A && git commit --quiet -m "local feature"
  # dirt: one real source change + one orch-monitor build artifact
  printf 'dirty-edit\n' >shared.txt
  mkdir -p plugins/dev/scripts/orch-monitor/public/assets
  printf 'junk\n' >plugins/dev/scripts/orch-monitor/public/assets/main-fake.js
  CATALYST_REBASE_GRACE_TOTAL_S=0 CATALYST_REBASE_GRACE_INTERVAL_S=0 \
    rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t26.rc"
)
assert_eq "2" "$(cat "$SCRATCH/t26.rc")" "mixed source + orch-monitor artifact → rc 2"

# ── 27. escalation-explain.mjs threads observed.dirtyFiles through unchanged ─
echo "27. escalation-explain.mjs round-trips observed.dirtyFiles (CTL-1130, D1 passthrough)"
EXPLAIN_MJS="${SCRIPT_DIR}/../../execution-core/escalation-explain.mjs"
if [[ -f "$EXPLAIN_MJS" ]] && command -v node >/dev/null 2>&1; then
  OBS='{"rebaseRc":2,"stallReason":"rebase_refused_dirty_tree","dirtyFiles":["shared.txt"]}'
  EXPL_OUT="$(node "$EXPLAIN_MJS" \
    --ticket CTL-1076 --phase plan \
    --type decision \
    --problem "rebase refused dirty tree: shared.txt has uncommitted changes" \
    --call-to-action "resolve shared.txt by hand or discard the local edit and re-run?" \
    --options '[{"label":"resolve","tradeoff":"manual merge work"},{"label":"discard","tradeoff":"lose local change to shared.txt"}]' \
    --why-you "conflict resolution is a judgment call the agent cannot make unilaterally" \
    --observed "$OBS" 2>/dev/null || echo '{}')"
  assert_eq "shared.txt" \
    "$(printf '%s' "$EXPL_OUT" | jq -r '.observed.dirtyFiles[0]' 2>/dev/null)" \
    "escalation-explain: observed.dirtyFiles[0] passes through unchanged (D1)"
else
  echo "  SKIP: escalation-explain.mjs or node not available"
fi

# ─── CTL-1505: transient source conflict cleared by a re-fetch retry ─────────
# A source conflict is judged against origin/<base> as fetched at the top of
# rebase_onto_base_classified. When main has since moved, that judgement is
# STALE: rebasing onto a freshly-fetched base often applies cleanly. Before the
# terminal rc=2 park, the classifier must abort, RE-FETCH origin/<base>, and
# retry the rebase exactly once. This is the CTL-1504 regression.

# ── 28. transient source conflict → re-fetch retry clears it → rc 0 ─────────
echo "28. rebase_onto_base_classified transient source conflict → retry → rc 0"
new_fixture t28
advance_origin_main_conflict   # origin/main tip: shared.txt='upstream-edit' (conflicts)
# git shim: on the 2nd `git fetch … main` (the CTL-1505 retry fetch), first push
# a RESOLVING commit to origin (reverting shared.txt to base-line) with the REAL
# git, then delegate. Simulates origin/main advancing between the initial fetch
# (conflict) and the retry fetch (clean) inside one function call.
mkdir -p "$SCRATCH/t28/shimbin"
cat >"$SCRATCH/t28/shimbin/git" <<'SHIM'
#!/usr/bin/env bash
if [[ "$1" == "fetch" && "$*" == *main* ]]; then
  __n=$(( $(cat "$T28_COUNTER" 2>/dev/null || echo 0) + 1 ))
  echo "$__n" >"$T28_COUNTER"
  if [[ "$__n" -ge 2 ]]; then
    (
      cd "$T28_UP" || exit 0
      "$T28_REAL_GIT" checkout --quiet main
      printf 'base-line\n' >shared.txt
      "$T28_REAL_GIT" add -A
      "$T28_REAL_GIT" commit --quiet -m "upstream resolves conflict (main advanced)"
      "$T28_REAL_GIT" push --quiet origin main
    ) >/dev/null 2>&1
  fi
fi
exec "$T28_REAL_GIT" "$@"
SHIM
chmod +x "$SCRATCH/t28/shimbin/git"
(
  cd "$WORK"
  printf 'local-edit\n' >shared.txt
  git add -A && git commit --quiet -m "local conflicting edit"
  ORIG_HEAD="$(git rev-parse HEAD)"
  echo "$ORIG_HEAD" >"$SCRATCH/t28.orig"
  # Capture REAL git BEFORE the shim shadows it on PATH.
  export T28_REAL_GIT="$(command -v git)"
  export T28_UP="$UP" T28_COUNTER="$SCRATCH/t28/fetchcount"
  export PATH="$SCRATCH/t28/shimbin:$PATH"
  hash -r 2>/dev/null || true
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t28.rc"
  git log --oneline >"$SCRATCH/t28.log"
  cat shared.txt >"$SCRATCH/t28.shared"
  [[ -d .git/rebase-merge ]] && echo leftover >"$SCRATCH/t28.rebasedir" || echo clean >"$SCRATCH/t28.rebasedir"
  git status --porcelain >"$SCRATCH/t28.status"
)
assert_eq "0" "$(cat "$SCRATCH/t28.rc")" "transient source conflict cleared by re-fetch retry → rc 0"
assert_eq "clean" "$(cat "$SCRATCH/t28.rebasedir")" "retry-clean: no rebase-merge leftover"
assert_eq "" "$(cat "$SCRATCH/t28.status")" "retry-clean: working tree clean (noise stash popped)"
assert_eq "local-edit" "$(cat "$SCRATCH/t28.shared")" "retry-clean: local edit applied onto advanced base"
T28_WORK_IN_LOG="no"; grep -q "local conflicting edit" "$SCRATCH/t28.log" && T28_WORK_IN_LOG="yes"
assert_eq "yes" "$T28_WORK_IN_LOG" "retry-clean: local work commit retained"
# The auto-rebased(refetch-retry) event is the distinct, observable retry signal.
assert_eq "refetch-retry" \
  "$(jq -r '.body.payload.strategy' <<<"$(last_telem_line)")" \
  "retry-clean: auto-rebased(refetch-retry) event emitted"

# ── 29. persistent source conflict → retry still conflicts → rc 2, HEAD restored
# Guards boundedness (one retry, no loop) and that the terminal reason stays the
# routing-recognized source_conflict_ctl708_unavailable (downstream recovery
# keys EXACTLY on it — see catB-force-with-lease.mjs / STALL_CATEGORY_MAP).
echo "29. persistent source conflict → retry still conflicts → rc 2 (bounded)"
new_fixture t29
advance_origin_main_conflict
(
  cd "$WORK"
  printf 'local-edit\n' >shared.txt
  git add -A && git commit --quiet -m "local conflicting edit"
  ORIG_HEAD="$(git rev-parse HEAD)"
  echo "$ORIG_HEAD" >"$SCRATCH/t29.orig"
  rebase_onto_base_classified "main"
  echo "$?" >"$SCRATCH/t29.rc"
  echo "${REBASE_LAST_STALL_REASON:-}" >"$SCRATCH/t29.reason"
  git rev-parse HEAD >"$SCRATCH/t29.head"
  [[ -d .git/rebase-merge ]] && echo leftover >"$SCRATCH/t29.rebasedir" || echo clean >"$SCRATCH/t29.rebasedir"
  git status --porcelain >"$SCRATCH/t29.status"
)
assert_eq "2" "$(cat "$SCRATCH/t29.rc")" "persistent source conflict survives retry → rc 2"
assert_eq "source_conflict_ctl708_unavailable" "$(cat "$SCRATCH/t29.reason")" \
  "persistent: terminal reason stays routing-recognized (not renamed)"
assert_eq "$(cat "$SCRATCH/t29.orig")" "$(cat "$SCRATCH/t29.head")" "persistent: HEAD restored after retry+abort"
assert_eq "clean" "$(cat "$SCRATCH/t29.rebasedir")" "persistent: no rebase-merge leftover after retry"
assert_eq "" "$(cat "$SCRATCH/t29.status")" "persistent: working tree clean after retry+abort"
STALL29="$(last_telem_line)"
assert_eq "source_conflict_ctl708_unavailable" "$(jq -r '.body.payload.reason' <<<"$STALL29")" \
  "persistent: stalled event reason recorded (observable park)"

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
