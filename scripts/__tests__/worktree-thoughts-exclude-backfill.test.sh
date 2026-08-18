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
echo "--- ⛔ discovering ZERO repos must FAIL, not report success ---"
OUT3="$(CATALYST_WT_ROOT="$SCRATCH/nonexistent" bash "$SUBJECT" 2>&1)"
RC3=$?
[ "$RC3" -eq 2 ] && pass "zero-discovery exits 2" || fail "zero-discovery exits 2" "rc=$RC3: $OUT3"

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
