#!/usr/bin/env bash
# rotation-window.sh — CTL-2145. THE one home for the coord kit's rolling-window
# circuit breaker, sourced by both lane-relaunch.sh (per-lane relaunch cap) and
# account-rotation-watch.sh (per-host rotation cap).
#
# The mechanism came from CTL-2097: a pid-file liveness fix alone does not bound a lane
# that dies quickly and repeatedly on its OWN — every pass would relaunch it again,
# forever. The same shape applies to rotation: an account that gets walled the moment it
# is selected would otherwise burn every provisioned handle in a few ticks. One window,
# two consumers, one implementation — lane-relaunch.sh's own test file used to note that
# it re-implemented these "kept in sync by hand", which is the smell this removes.
#
# Timestamps are epoch SECONDS, one per line, appended on each attempt and pruned to the
# window on every read — so a subject that has been quiet ages back under the cap without
# needing a fresh attempt to trigger the prune.
#
# Usage:
#   source .../coord/lib/rotation-window.sh
#   count="$(cw_count_in_window "$DIR/<subject>.relaunches" 3600)"
#   cw_record_attempt "$DIR/<subject>.relaunches"

# cw_count_in_window FILE WINDOW_SECONDS
# Prunes FILE to the trailing WINDOW_SECONDS and prints the number of entries left.
cw_count_in_window() {
	local rf="$1" window="${2:-3600}"
	[ -f "$rf" ] || {
		echo 0
		return
	}
	local now cutoff
	now=$(date +%s)
	cutoff=$((now - window))
	local kept
	kept=$(awk -v cutoff="$cutoff" '$1 >= cutoff' "$rf")
	# `printf '%s\n' ""` writes a stray blank line, not a truly empty file — truncate
	# explicitly instead, or the counter file never actually shrinks back to empty after
	# the window clears (and the blank line then counts as an attempt forever).
	if [ -z "$kept" ]; then
		: >"$rf"
		echo 0
	else
		printf '%s\n' "$kept" >"$rf"
		printf '%s\n' "$kept" | grep -c .
	fi
}

# cw_record_attempt FILE — append "now" to FILE's rolling-window counter.
# Callers record BEFORE acting, so an action that itself fails or hangs still counts
# toward the cap: a broken actuator must not become an unbounded tight retry either.
#
# Returns NON-ZERO when the attempt could not be persisted, and that status is LOAD-BEARING
# rather than advisory — a caller that ignores it has no breaker at all. Both consumers keep
# this counter in the same directory as their act-marker, so a directory that refuses this
# append refuses the marker too; cw_count_in_window then reads the missing file as 0 on every
# subsequent tick, the `count >= cap` branch is never taken, and the edge is never consumed.
# The cap does not merely under-count in that state, it becomes a permanent no-op while the
# actuator stays fully live — the one direction a circuit breaker must never fail in. The
# raw redirect error is muted here because a bare `Permission denied` on stderr is not a
# named decline; the caller owns saying which path refused and why (CTL-2145).
cw_record_attempt() {
	mkdir -p "$(dirname "$1")" 2>/dev/null || true
	date +%s >>"$1" 2>/dev/null || return 1
}
