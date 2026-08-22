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

# ─── an unwritable $PIDDIR must not disarm the relaunch cap ──────────────────
#
# Everything above exercises PRIMITIVES. This case drives the REAL lane-relaunch.sh loop,
# because the defect it guards lives in the caller's control flow, not in the lib: the loop
# called record_relaunch_attempt un-checked under `set -u` (no -e), so a $PIDDIR that refused
# the append changed nothing and it launched anyway. The two failures compound rather than
# cancel — cw_count_in_window reads the missing counter as 0, so `COUNT >= CAP` is never true
# and no pass is ever CAPPED, while the unwritable <lane>.pid makes is_alive report the lane
# dead every pass — so the launcher fires every POLL_SECONDS forever, each one a real claude
# session, with the cap that is meant to bound it silently gone. Same defect class, same
# shared lib, as the account-rotation actor's breaker-unavailable refusal (CTL-2145).
#
# THE assertion is that the launcher was invoked no more often than the cap allows. Counting
# CAPPED lines alone would pass vacuously: the unwritable run emits none either way, because
# never reaching the cap is the whole defect.

echo "Test: an unwritable \$PIDDIR refuses to relaunch instead of relaunching uncapped"

LR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lane-relaunch.sh"

# run_lane_loop MODE DEADLINE -> "<launches> <capped_lines>" for one bounded run of the real
# script against a scratch kit. The deadline lives in a watchdog that SIGKILLs the child, so
# the unbounded `while :` poll loop can never outlive this test even if every later line here
# is broken (AGENTS.md: a background process must not be able to outlive its starter).
run_lane_loop() {
	local mode="$1" deadline="$2" s p w launches capped
	s="$(mktemp -d)"
	mkdir -p "$s/coord" "$s/repo"
	printf 'ctl %s\n' "$s/repo" >"$s/coord/lanes.manifest"
	: >"$s/coord/launch-ctl1.txt"
	printf 'acct1\n' >"$s/coord/fleet-account.current"
	: >"$s/launches"
	# The stub reports a pid that is definitely NOT running, so is_alive is false on every
	# pass and the CAP is the only thing that can bound the writable control. (A stub echoing
	# "pid 0" would make `kill -0 0` succeed — the lane would read alive and the control would
	# bound at 1 launch without the cap ever being consulted, proving nothing.)
	cat >"$s/coord/launch-on-acct1.sh" <<-STUB
		#!/usr/bin/env bash
		echo "\$*" >>"$s/launches"
		echo "started pid 999999"
	STUB
	chmod +x "$s/coord/launch-on-acct1.sh"
	mkdir -p "$s/coord/lane-pids"
	if [ "$mode" = unwritable ]; then
		chmod 555 "$s/coord/lane-pids"
		# Verify the INSTRUMENT before trusting what it measures: a mode change silently
		# ignored (root, an ACL, a filesystem that does not honour the bits) would leave a
		# perfectly writable dir and the refusal assertion would be measuring nothing.
		# Probed by writing, not by checking the uid, so every one of those causes is caught.
		if touch "$s/coord/lane-pids/.probe" 2>/dev/null; then
			rm -f "$s/coord/lane-pids/.probe" 2>/dev/null || true
			chmod 755 "$s/coord/lane-pids" 2>/dev/null || true
			rm -rf "$s"
			printf 'INCONCLUSIVE'
			return 0
		fi
	fi
	COMMS_DIR="$s/coord" POLL_SECONDS=1 RELAUNCH_HOURLY_CAP=1 \
		bash "$LR_SCRIPT" >/dev/null 2>&1 &
	p=$!
	(
		sleep "$deadline"
		kill -9 "$p" 2>/dev/null
	) &
	w=$!
	wait "$p" 2>/dev/null
	kill "$w" 2>/dev/null
	# Restore BEFORE the cleanup rm -rf, which cannot unlink through a 555 directory.
	chmod 755 "$s/coord/lane-pids" 2>/dev/null || true
	# `grep -c` PRINTS its count and exits 1 when that count is zero, so the obvious
	# `|| echo 0` appends a SECOND line and the caller's `[ "$x" -le 1 ]` dies with
	# "integer expression expected" — a broken instrument, which is the one thing a
	# positive control cannot catch for you. `|| true` keeps grep's own printed 0.
	launches=0
	[ -f "$s/launches" ] && launches=$(grep -c . "$s/launches" 2>/dev/null || true)
	capped=0
	[ -f "$s/coord/lane-relaunch.log" ] &&
		capped=$(grep -c 'CAPPED' "$s/coord/lane-relaunch.log" 2>/dev/null || true)
	rm -rf "$s"
	printf '%s %s' "$launches" "$capped"
}

# ~22s per arm: the loop sleeps 15s after each relaunch, so an uncapped run reaches its
# SECOND launch at t=15 while a capped one is still refusing.
UNWRITABLE_RESULT="$(run_lane_loop unwritable 22)"
if [ "$UNWRITABLE_RESULT" = INCONCLUSIVE ]; then
	echo "  INCONCLUSIVE: chmod 555 did not make the pid dir unwritable to this process (root? ACL?) — the unwritable-dir case cannot run here"
else
	U_LAUNCHES="${UNWRITABLE_RESULT%% *}"
	if [ "$U_LAUNCHES" -le 1 ]; then
		pass "did NOT relaunch uncapped when the attempt could not be recorded ($U_LAUNCHES launch(es) in 22s, cap 1)"
	else
		fail "relaunched with a disarmed breaker: $U_LAUNCHES launches in 22s against a cap of 1"
	fi

	# POSITIVE CONTROL — the identical run with the dir writable. Without it, a loop that
	# refused to launch for any other reason (a broken fixture, a stub that never runs) would
	# pass the assertion above while proving nothing about the breaker.
	CONTROL_RESULT="$(run_lane_loop writable 22)"
	C_LAUNCHES="${CONTROL_RESULT%% *}"
	C_CAPPED="${CONTROL_RESULT##* }"
	if [ "$C_LAUNCHES" -ge 1 ] && [ "$C_CAPPED" -ge 1 ]; then
		pass "positive control: the SAME fixture launches and then CAPS when the dir is writable ($C_LAUNCHES launch(es), $C_CAPPED capped pass(es)) — the refusal was the breaker, not the fixture"
	else
		fail "positive control FAILED — $C_LAUNCHES launch(es), $C_CAPPED capped pass(es): this test proves nothing"
	fi
fi

echo ""
echo "== $PASSES passed, $FAILURES failed =="
[ "$FAILURES" -eq 0 ]
