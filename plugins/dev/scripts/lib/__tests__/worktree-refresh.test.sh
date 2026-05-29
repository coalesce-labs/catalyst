#!/usr/bin/env bash
# Tests for lib/worktree-refresh.sh (CTL-707 Phase 4).
# Run: bash plugins/dev/scripts/lib/__tests__/worktree-refresh.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REFRESH_LIB="${LIB_DIR}/worktree-refresh.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t worktree-refresh-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@test
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@test
export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

# shellcheck source=../worktree-refresh.sh
source "$REFRESH_LIB"

# Fixture: bare origin + main clone (UP) + work clone (WORK).
new_refresh_fixture() {
  local tag="$1"
  ORIGIN="${SCRATCH}/${tag}-origin.git"
  WORK="${SCRATCH}/${tag}-work"
  UP="${SCRATCH}/${tag}-up"
  git init --quiet --bare -b main "$ORIGIN"
  git clone --quiet "$ORIGIN" "$UP"
  (
    cd "$UP"
    printf 'base\n' >base.txt
    git add -A && git commit --quiet -m "initial"
    git push --quiet origin main
  )
  git clone --quiet "$ORIGIN" "$WORK"
  (cd "$WORK" && git checkout --quiet -b work)
}

echo "worktree-refresh tests (CTL-707 Phase 4)"

# ── 1. Clean refresh: work branch behind origin/main → rebased forward ───────
echo "1. refresh_worktree clean rebase"
new_refresh_fixture t1
(
  cd "$UP"
  printf 'upstream-feature\n' >upstream.txt
  git add -A && git commit --quiet -m "upstream advance"
  git push --quiet origin main
)
(
  cd "$WORK"
  printf 'local-work\n' >local.txt
  git add -A && git commit --quiet -m "local work"
)
refresh_worktree "$WORK" main
echo "$?" >"$SCRATCH/t1.rc"
[[ -f "$WORK/upstream.txt" && -f "$WORK/local.txt" ]] && echo yes >"$SCRATCH/t1.both" || echo no >"$SCRATCH/t1.both"
[[ -d "$WORK/.git/rebase-merge" ]] && echo leftover >"$SCRATCH/t1.rebasedir" || echo clean >"$SCRATCH/t1.rebasedir"
assert_eq "0" "$(cat "$SCRATCH/t1.rc")" "clean refresh → rc 0"
assert_eq "yes" "$(cat "$SCRATCH/t1.both")" "clean refresh: both local + base commits present"
assert_eq "clean" "$(cat "$SCRATCH/t1.rebasedir")" "clean refresh: no rebase-merge leftover"

# ── 2. Conflict refresh: HEAD restored, rc=2 ─────────────────────────────────
echo "2. refresh_worktree conflict rebase"
new_refresh_fixture t2
(
  cd "$UP"
  printf 'upstream-edit\n' >shared.txt
  git add -A && git commit --quiet -m "upstream conflict"
  git push --quiet origin main
)
(
  cd "$WORK"
  printf 'local-edit\n' >shared.txt
  git add -A && git commit --quiet -m "local conflict"
  git rev-parse HEAD >"$SCRATCH/t2.orig"
)
refresh_worktree "$WORK" main
echo "$?" >"$SCRATCH/t2.rc"
(cd "$WORK" && git rev-parse HEAD) >"$SCRATCH/t2.head"
[[ -d "$WORK/.git/rebase-merge" ]] && echo leftover >"$SCRATCH/t2.rebasedir" || echo clean >"$SCRATCH/t2.rebasedir"
assert_eq "2" "$(cat "$SCRATCH/t2.rc")" "conflict refresh → rc 2"
assert_eq "$(cat "$SCRATCH/t2.orig")" "$(cat "$SCRATCH/t2.head")" "conflict refresh: HEAD restored"
assert_eq "clean" "$(cat "$SCRATCH/t2.rebasedir")" "conflict refresh: no rebase-merge leftover"

# ── 3. Fetch failure → rc 1 ──────────────────────────────────────────────────
echo "3. refresh_worktree fetch failure"
new_refresh_fixture t3
(cd "$WORK" && git rev-parse HEAD >"$SCRATCH/t3.orig")
refresh_worktree "$WORK" no-such-branch-xyz
echo "$?" >"$SCRATCH/t3.rc"
(cd "$WORK" && git rev-parse HEAD) >"$SCRATCH/t3.head"
assert_eq "1" "$(cat "$SCRATCH/t3.rc")" "fetch failure → rc 1"
assert_eq "$(cat "$SCRATCH/t3.orig")" "$(cat "$SCRATCH/t3.head")" "fetch failure: HEAD unchanged"

# ── 4. Direct execution returns same rc ──────────────────────────────────────
echo "4. direct execution (bash worktree-refresh.sh)"
new_refresh_fixture t4
(
  cd "$UP"
  printf 'upstream\n' >up.txt
  git add -A && git commit --quiet -m "upstream"
  git push --quiet origin main
)
(
  cd "$WORK"
  printf 'local\n' >local.txt
  git add -A && git commit --quiet -m "local"
)
bash "$REFRESH_LIB" "$WORK" main
echo "$?" >"$SCRATCH/t4.rc"
assert_eq "0" "$(cat "$SCRATCH/t4.rc")" "direct execution clean refresh → rc 0"

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
