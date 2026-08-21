#!/usr/bin/env bash
# lane-relaunch.test.sh — regression coverage for the CTL-2097 incident: a liveness check that
# text-matches `ps aux` output against a lane's brief never matches a real claude -p process, so
# EVERY poll relaunches EVERY lane. This test exercises the exact liveness functions
# lane-relaunch.sh uses (pid-file + kill -0) against REAL OS processes, not mocks, because the
# incident was a false claim about what `ps` text-matching could observe — a mock would not have
# caught it either.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'jobs -p | xargs -r kill 2>/dev/null; rm -rf "${SCRATCH:?}"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

# Re-implement just the two liveness primitives under test, against a scratch PIDDIR — this
# mirrors lane-relaunch.sh's own functions exactly (kept in sync by hand; if you change one,
# change both).
PIDDIR="$SCRATCH/lane-pids"
mkdir -p "$PIDDIR"

is_alive() {
	local pf="$PIDDIR/$1.pid"
	[ -f "$pf" ] || return 1
	local pid
	pid=$(cat "$pf" 2>/dev/null)
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

echo "Test: a lane with no pid file is dead"
if is_alive "nolane"; then fail "expected dead, got alive"; else pass "no pid file -> dead"; fi

echo "Test: a lane whose pid file names a REAL running process is alive (the case v1 got wrong)"
sleep 60 &
REAL_PID=$!
echo "$REAL_PID" >"$PIDDIR/liveone.pid"
if is_alive "liveone"; then pass "real running pid -> alive"; else fail "expected alive, got dead"; fi

echo "Test: after killing that process, the SAME lane is detected dead"
kill "$REAL_PID" 2>/dev/null
# give the OS a moment to reap; kill -0 on a zombie can still succeed briefly on some platforms,
# so poll briefly rather than assert instantly.
for _ in 1 2 3 4 5; do
	is_alive "liveone" || break
	sleep 0.2
done
if is_alive "liveone"; then fail "expected dead after kill, still alive"; else pass "killed pid -> dead"; fi

echo "Test: a pid file with a stale/bogus pid (never our process) reads as dead, not alive"
echo "999999" >"$PIDDIR/bogus.pid"
if is_alive "bogus"; then fail "bogus pid falsely alive"; else pass "bogus pid -> dead"; fi

echo "Test: latest_brief prefix matching does not cross-match a longer lane name (the ctl vs"
echo "      ctlinstall6 bug from the same incident)"
BRIEFDIR="$SCRATCH/briefs"
mkdir -p "$BRIEFDIR"
touch "$BRIEFDIR/launch-ctlinstall6.txt" "$BRIEFDIR/launch-ctl24.txt" "$BRIEFDIR/launch-ctl27.txt"
latest_brief() {
	ls "$BRIEFDIR"/launch-"$1"[0-9]*.txt 2>/dev/null | grep -E "launch-$1[0-9]+\.txt$" | sort -V | tail -1
}
GOT="$(latest_brief ctl)"
if [ "$(basename "$GOT")" = "launch-ctl27.txt" ]; then
	pass "ctl matches ctl27, not ctlinstall6 ($GOT)"
else
	fail "expected launch-ctl27.txt, got '$GOT'"
fi

# CTL-2145: the rolling-window cap is SOURCED from the same lib lane-relaunch.sh and
# account-rotation-watch.sh use — not hand-mirrored here. The previous copy carried the note
# "kept in sync by hand; if you change one, change both", which is a test that stops testing
# the shipped code the moment someone changes only one of them. These thin wrappers reproduce
# lane-relaunch.sh's per-lane file naming; the mechanism under test is the real one.
WINDOW_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/rotation-window.sh"
if [ ! -r "$WINDOW_LIB" ]; then
	fail "missing $WINDOW_LIB — the shared rolling-window lib is what this section tests"
	echo ""
	echo "== ${PASSES} passed, $((FAILURES)) failed =="
	exit 1
fi
# shellcheck source=../lib/rotation-window.sh
. "$WINDOW_LIB"
RELAUNCH_HOURLY_CAP=4
RELAUNCH_WINDOW_SECONDS=3600
relaunch_count_in_window() { cw_count_in_window "$PIDDIR/$1.relaunches" "$RELAUNCH_WINDOW_SECONDS"; }
record_relaunch_attempt() { cw_record_attempt "$PIDDIR/$1.relaunches"; }

echo "Test: a lane with no relaunch history reads as 0 attempts this hour"
COUNT=$(relaunch_count_in_window "freshlane")
if [ "$COUNT" -eq 0 ]; then pass "no history -> 0"; else fail "expected 0, got $COUNT"; fi

echo "Test: recording CAP attempts brings the count to exactly CAP, not capped yet"
for _ in $(seq 1 "$RELAUNCH_HOURLY_CAP"); do record_relaunch_attempt "atcap"; done
COUNT=$(relaunch_count_in_window "atcap")
if [ "$COUNT" -eq "$RELAUNCH_HOURLY_CAP" ]; then
	pass "$RELAUNCH_HOURLY_CAP attempts -> count $RELAUNCH_HOURLY_CAP (caller compares >= to cap)"
else
	fail "expected $RELAUNCH_HOURLY_CAP, got $COUNT"
fi

echo "Test: one more attempt past the cap is still counted (the caller enforces the skip, not this fn)"
record_relaunch_attempt "atcap"
COUNT=$(relaunch_count_in_window "atcap")
if [ "$COUNT" -eq $((RELAUNCH_HOURLY_CAP + 1)) ]; then
	pass "count keeps rising past cap ($COUNT) — caller's >= check is what stops relaunching"
else
	fail "expected $((RELAUNCH_HOURLY_CAP + 1)), got $COUNT"
fi

echo "Test: an attempt older than the window ages OUT and does not count toward the cap"
OLD_TS=$(($(date +%s) - RELAUNCH_WINDOW_SECONDS - 60))
echo "$OLD_TS" >"$PIDDIR/aging.relaunches"
COUNT=$(relaunch_count_in_window "aging")
if [ "$COUNT" -eq 0 ]; then
	pass "attempt older than 60min window pruned to 0"
else
	fail "expected 0 (pruned), got $COUNT"
fi
if [ -s "$PIDDIR/aging.relaunches" ]; then
	fail "pruning should have rewritten the file empty, but it still has content"
else
	pass "pruning rewrote the counter file, so it doesn't grow unbounded forever"
fi

echo "Test: a mix of one stale + one fresh timestamp prunes to just the fresh one"
FRESH_TS=$(date +%s)
{
	echo "$OLD_TS"
	echo "$FRESH_TS"
} >"$PIDDIR/mixed.relaunches"
COUNT=$(relaunch_count_in_window "mixed")
if [ "$COUNT" -eq 1 ]; then
	pass "stale entry pruned, fresh entry kept -> count 1"
else
	fail "expected 1, got $COUNT"
fi

echo ""
echo "== $PASSES passed, $FAILURES failed =="
[ "$FAILURES" -eq 0 ]
