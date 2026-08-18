#!/usr/bin/env bash
# worktree-thoughts-exclude-backfill.test.sh — CTC-633's reclaim, applied to EXISTING worktrees.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../worktree-thoughts-exclude-backfill.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}

git_q() { git -C "$1" -c user.email=t@t -c user.name=T "${@:2}" >/dev/null 2>&1; }

# repo A: has a worktree with an UNTRACKED thoughts/ — the case the backfill fixes.
# repo B: identical shape but NO thoughts/ at all — the negative control; it must be left alone.
for r in A B; do
	R="$SCRATCH/repo$r"
	mkdir -p "$R"
	git_q "$R" init -b main
	echo hi >"$R/f.txt"
	git_q "$R" add -A
	git_q "$R" commit -m init
	git_q "$R" worktree add "$SCRATCH/wt/repo$r/w1" -b w1
done
mkdir -p "$SCRATCH/wt/repoA/w1/thoughts/shared"
echo note >"$SCRATCH/wt/repoA/w1/thoughts/shared/n.md"

# repo C: thoughts/ is TRACKED, then modified — no ignore rule can silence it.
R="$SCRATCH/repoC"
mkdir -p "$R/thoughts"
git_q "$R" init -b main
echo v1 >"$R/thoughts/tracked.md"
git_q "$R" add -A
git_q "$R" commit -m init
git_q "$R" worktree add "$SCRATCH/wt/repoC/w1" -b w1
echo v2 >"$SCRATCH/wt/repoC/w1/thoughts/tracked.md"

run_backfill() { CATALYST_WT_ROOT="$SCRATCH/wt" bash "$SUBJECT" "$@" 2>&1; }

echo ""
echo "=== before: repoA's worktree is dirty because of thoughts/ ==="
if git -C "$SCRATCH/wt/repoA/w1" status --porcelain | grep -q '^?? *thoughts/'; then
	pass "repoA/w1 shows an untracked thoughts/ (the defect exists to be fixed)"
else
	fail "repoA/w1 shows an untracked thoughts/" "the fixture is wrong; nothing below means anything"
fi

echo ""
echo "=== --dry-run changes NOTHING on disk ==="
OUT="$(run_backfill --dry-run)"
if grep -qxF "thoughts/" "$SCRATCH/repoA/.git/info/exclude" 2>/dev/null; then
	fail "--dry-run left the exclude untouched" "it wrote to repoA anyway"
else
	pass "--dry-run left the exclude untouched"
fi
grep -q "dry-run" <<<"$OUT" && pass "--dry-run says so" || fail "--dry-run says so" "$OUT"

echo ""
echo "=== the real run fixes repoA ==="
OUT="$(run_backfill)"
RC=$?
if grep -qxF "thoughts/" "$SCRATCH/repoA/.git/info/exclude" 2>/dev/null; then pass "repoA got the exclude"; else fail "repoA got the exclude" "$OUT"; fi
if git -C "$SCRATCH/wt/repoA/w1" status --porcelain | grep -q 'thoughts/'; then
	fail "repoA/w1 is no longer dirty from thoughts/" "$(git -C "$SCRATCH/wt/repoA/w1" status --porcelain)"
else
	pass "repoA/w1 is no longer dirty from thoughts/"
fi
[ "$RC" -eq 0 ] && pass "exit 0 when every untracked case was fixed" || fail "exit 0" "rc=$RC"

echo ""
echo "--- ⛔ NEGATIVE CONTROL: a repo without the defect is NOT touched ---"
if [ -f "$SCRATCH/repoB/.git/info/exclude" ] && grep -qxF "thoughts/" "$SCRATCH/repoB/.git/info/exclude"; then
	fail "repoB was left alone" "the script writes to every repo it discovers, not just affected ones"
else
	pass "repoB was left alone"
fi

echo ""
echo "--- ⛔ a TRACKED-MODIFIED thoughts/ is REPORTED, not silently counted as fixed ---"
if grep -q "TRACKED-MODIFIED" <<<"$OUT"; then pass "the tracked case is reported"; else fail "the tracked case is reported" "$OUT"; fi
if git -C "$SCRATCH/wt/repoC/w1" status --porcelain | grep -q 'thoughts/tracked.md'; then
	pass "control — the tracked path is genuinely still dirty (so the report is true)"
else
	fail "control — the tracked path is still dirty" "the fixture stopped exercising the tracked case"
fi

echo ""
echo "=== idempotence: a second run is a no-op ==="
BEFORE="$(md5 -q "$SCRATCH/repoA/.git/info/exclude" 2>/dev/null || md5sum "$SCRATCH/repoA/.git/info/exclude" | cut -d' ' -f1)"
OUT2="$(run_backfill)"
AFTER="$(md5 -q "$SCRATCH/repoA/.git/info/exclude" 2>/dev/null || md5sum "$SCRATCH/repoA/.git/info/exclude" | cut -d' ' -f1)"
[ "$BEFORE" = "$AFTER" ] && pass "the exclude file is byte-identical after a re-run" || fail "re-run is a no-op" "the file changed"
grep -q "already ignored" <<<"$OUT2" && pass "the re-run says 'already ignored'" || fail "the re-run says 'already ignored'" "$OUT2"

echo ""
echo "--- ⛔ a worktree path containing a SPACE is not truncated (Codex #3521 P2) ---"
# `awk '/^worktree /{print $2}'` returned only the first component, so a spaced path became a
# nonexistent one, was skipped, and the run reported still-untracked=0 and exited 0.
R="$SCRATCH/repoD"
mkdir -p "$R"
git_q "$R" init -b main
echo hi >"$R/f.txt"
git_q "$R" add -A
git_q "$R" commit -m init
git_q "$R" worktree add "$SCRATCH/wt/repoD/with space" -b w1
mkdir -p "$SCRATCH/wt/repoD/with space/thoughts"
echo n >"$SCRATCH/wt/repoD/with space/thoughts/n.md"
# ⛔ Positive control: the defect really is there before the run.
if git -C "$SCRATCH/wt/repoD/with space" status --porcelain | grep -q '^?? *thoughts/'; then
	pass "control — the spaced-path worktree really has the defect"
else
	fail "control — the spaced-path worktree has the defect" "fixture wrong; the check below proves nothing"
fi
OUT_SP="$(run_backfill)"
if grep -qxF "thoughts/" "$R/.git/info/exclude" 2>/dev/null; then
	pass "the spaced-path worktree's repo was found and fixed"
else
	fail "the spaced-path worktree's repo was found and fixed" "$OUT_SP"
fi

echo ""
echo "--- ⛔ an UNREADABLE worktree is not counted as clean (Codex #3521 P2) ---"
# git status failing was discarded and the empty output read as a clean tree — a false zero.
R="$SCRATCH/repoE"
mkdir -p "$R"
git_q "$R" init -b main
echo hi >"$R/f.txt"
git_q "$R" add -A
git_q "$R" commit -m init
git_q "$R" worktree add "$SCRATCH/wt/repoE/w1" -b w1
git_q "$R" worktree add "$SCRATCH/wt/repoE/healthy" -b healthy
mkdir -p "$SCRATCH/wt/repoE/healthy/thoughts"
echo n >"$SCRATCH/wt/repoE/healthy/thoughts/n.md"
# Break ONLY w1's metadata. The healthy sibling keeps the repo discoverable — Codex's exact
# scenario, and without it the broken worktree is simply never discovered and the case is moot.
echo "gitdir: /nonexistent/definitely/not/here" >"$SCRATCH/wt/repoE/w1/.git"
if git -C "$SCRATCH/wt/repoE/w1" status --porcelain >/dev/null 2>&1; then
	fail "control — w1's status really is unreadable" "the fixture did not break it"
else
	pass "control — w1's status really is unreadable"
fi
OUT_UR="$(run_backfill)"
RC_UR=$?
if grep -q "UNREADABLE" <<<"$OUT_UR"; then pass "the unreadable worktree is reported"; else fail "the unreadable worktree is reported" "$OUT_UR"; fi
if [ "$RC_UR" -ne 0 ]; then pass "the run exits NON-ZERO on an unreadable worktree (rc=$RC_UR)"; else fail "the run exits non-zero on an unreadable worktree" "rc=0 — an unknown was reported as a pass"; fi
rm -rf "$SCRATCH/wt/repoE"

echo ""
echo "--- ⛔ detection survives a status stream larger than the pipe buffer (Codex #3521 P2) ---"
# `git status --porcelain | grep -q` let grep exit on first match, git took SIGPIPE, and under
# `set -o pipefail` the pipeline returned nonzero — so a repo that DID have the defect was
# counted as skipped. Needs enough output to fill the ~64 KiB pipe buffer.
R="$SCRATCH/repoF"
mkdir -p "$R"
git_q "$R" init -b main
echo hi >"$R/f.txt"
git_q "$R" add -A
git_q "$R" commit -m init
git_q "$R" worktree add "$SCRATCH/wt/repoF/w1" -b w1
mkdir -p "$SCRATCH/wt/repoF/w1/thoughts"
echo n >"$SCRATCH/wt/repoF/w1/thoughts/n.md"
# ⛔ TWO fixture mistakes had to be fixed before this case tested anything, and both were caught
# by running a mutation rather than by reading:
#  1. Files in a subdirectory collapse to one "?? pad/" line in porcelain — 6000 of them produced
#     21 bytes of status. Hence top-level files. (The byte-count control caught this.)
#  2. They must sort AFTER "thoughts/", or grep matches on the LAST line, git has already written
#     everything, and there is no SIGPIPE at all — the mutation below passed happily. Hence the
#     zzz_ prefix: thoughts/ matches early, git still has ~145 KB to write, and the pipe breaks.
i=0
while [ "$i" -lt 6000 ]; do
	: >"$SCRATCH/wt/repoF/w1/zzz_padding_$i.txt"
	i=$((i + 1))
done
BYTES="$(git -C "$SCRATCH/wt/repoF/w1" status --porcelain | wc -c | tr -d ' ')"
if [ "$BYTES" -gt 65536 ]; then
	pass "control — the status stream is ${BYTES} bytes, past the 64 KiB pipe buffer"
else
	fail "control — the status stream exceeds the pipe buffer" "only ${BYTES} bytes; the case is not exercised"
fi
OUT_BIG="$(run_backfill)"
if grep -qxF "thoughts/" "$R/.git/info/exclude" 2>/dev/null; then
	pass "the large-status repo was still detected and fixed"
else
	fail "the large-status repo was still detected and fixed" "$(tail -5 <<<"$OUT_BIG")"
fi

echo ""
echo "--- ⛔ discovering ZERO repos must FAIL, not report success ---"
OUT3="$(CATALYST_WT_ROOT="$SCRATCH/nonexistent" bash "$SUBJECT" 2>&1)"
RC3=$?
[ "$RC3" -eq 2 ] && pass "zero-discovery exits 2" || fail "zero-discovery exits 2" "rc=$RC3: $OUT3"

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
