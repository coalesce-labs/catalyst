#!/bin/bash
# lane-relaunch.sh — run on the CONCIERGE's own machine (the laptop). Watches a manifest of
# ad-hoc `claude -p` steward/worker "lanes" and relaunches any that have died, using each lane's
# latest launch-<lane>N.txt brief and the account currently active in fleet-account.current.
#
# ⛔ STOPGAP, NOT THE PRODUCT. This whole ad-hoc claude -p + watchdog pattern exists only because
# CTL-1974 (role-supervisor) / CTL-2095 (concierge instantiates + retires stewards) have not landed
# yet. When they do, RETIRE this script rather than maintain it as a second mechanism (CTL-2097).
#
# CTL-2097 (2026-08-19/20): a prior version of this script checked liveness by grepping `ps aux`
# output for ~60 chars of a lane's brief text. That NEVER matched — `claude -p`'s process listing
# does not preserve prompt text verbatim in a greppable form — so every 10-minute pass treated every
# lane as dead and relaunched it regardless of whether it was actually running. Measured impact: 117
# duplicate relaunches in one overnight run, all 4 Claude accounts walled. This version fixes that by
# tracking liveness via a PID FILE written at spawn time, checked with `kill -0` — never text-matching
# `ps` output. Verified with scripts/comms/__tests__/lane-relaunch.bats (or the harness pattern
# documented in that incident's ticket) before trusting it unattended again.
#
# ⛔ The pid-file fix alone does NOT bound a lane that dies quickly and repeatedly on its OWN (a real
# startup bug, not a false-dead reading) — every 15-min pass would relaunch it again, forever. Ryan's
# post-incident monitoring plan explicitly called for a per-lane hourly relaunch cap as a circuit
# breaker the v1/v2 pid-file fix lacked; this version adds it: RELAUNCH_HOURLY_CAP (default 4)
# relaunches per lane per rolling 60-minute window, tracked in $PIDDIR/<lane>.relaunches (one epoch
# timestamp per attempt, pruned to the window on each check). Past the cap, the lane is logged as
# CAPPED and skipped until the window ages out — noisy, not catastrophic.
#
# Usage:
#   scripts/comms/lane-relaunch.sh   (loops forever; run under nohup/a background job)
#
# Requires, all relative to the comms kit directory (COMMS_DIR, default ~/catalyst/comms/coord):
#   lanes.manifest            — one "<lane-prefix> <repo-dir>" per line
#   launch-<lane-prefix>N.txt — the Nth brief for that lane; highest N wins
#   launch-on-<account>.sh    — the per-account launcher (in the same tmp dir as this repo's
#                               operator convention; pass its location via LAUNCHER_DIR)
#   fleet-account.current     — single line naming the active Claude account (e.g. "acct2")

set -u

COMMS_DIR="${COMMS_DIR:-$HOME/catalyst/comms/coord}"
LAUNCHER_DIR="${LAUNCHER_DIR:?set LAUNCHER_DIR to the directory holding launch-on-<account>.sh}"
LOG="$COMMS_DIR/lane-relaunch.log"
CUR="$COMMS_DIR/fleet-account.current"
PIDDIR="$COMMS_DIR/lane-pids"
MANIFEST="$COMMS_DIR/lanes.manifest"
POLL_SECONDS="${POLL_SECONDS:-900}"
RELAUNCH_HOURLY_CAP="${RELAUNCH_HOURLY_CAP:-4}"
RELAUNCH_WINDOW_SECONDS=3600
mkdir -p "$PIDDIR"

latest_brief() { # $1 lane-prefix -> path of highest-numbered brief, digits-only match
  # The [0-9]* + grep -E anchor is load-bearing: without it, prefix "ctl" also matches a stale
  # "ctlinstall6.txt" brief from an unrelated, retired lane family.
  ls "$COMMS_DIR"/launch-"$1"[0-9]*.txt 2>/dev/null | grep -E "launch-$1[0-9]+\.txt$" | sort -V | tail -1
}

is_alive() { # $1 lane-prefix -> 0 iff its recorded pid is a live process
  local pf="$PIDDIR/$1.pid"
  [ -f "$pf" ] || return 1
  local pid; pid=$(cat "$pf" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# $1 lane-prefix -> prunes $PIDDIR/<lane>.relaunches to the rolling window and prints the count
# remaining. Pruning happens on every call (not just on relaunch) so a lane that has been quiet
# for a while ages back under the cap even without a fresh attempt.
relaunch_count_in_window() {
  local rf="$PIDDIR/$1.relaunches"
  [ -f "$rf" ] || { echo 0; return; }
  local now cutoff; now=$(date +%s); cutoff=$((now - RELAUNCH_WINDOW_SECONDS))
  local kept; kept=$(awk -v cutoff="$cutoff" '$1 >= cutoff' "$rf")
  # `printf '%s\n' ""` writes a stray blank line, not a truly empty file — truncate explicitly
  # instead, or the counter file never actually shrinks back to empty after the window clears.
  if [ -z "$kept" ]; then : > "$rf"; echo 0; else printf '%s\n' "$kept" > "$rf"; printf '%s\n' "$kept" | grep -c .; fi
}

record_relaunch_attempt() { # $1 lane-prefix -> append "now" to its rolling-window counter file
  date +%s >> "$PIDDIR/$1.relaunches"
}

while :; do
  ACCT=$(cat "$CUR" 2>/dev/null || echo acct1)
  LAUNCHER="$LAUNCHER_DIR/launch-on-$ACCT.sh"
  while read -r lane repo; do
    [ -z "$lane" ] && continue
    if is_alive "$lane"; then continue; fi
    COUNT=$(relaunch_count_in_window "$lane")
    if [ "$COUNT" -ge "$RELAUNCH_HOURLY_CAP" ]; then
      echo "$(date '+%H:%M:%S') CAPPED $lane — $COUNT relaunches in the last hour (cap $RELAUNCH_HOURLY_CAP), skipping" >> "$LOG"
      continue
    fi
    brief=$(latest_brief "$lane")
    [ -z "$brief" ] && continue
    name=$(basename "$brief" .txt); name=${name#launch-}
    # Record the attempt BEFORE launching, so a launcher that itself fails or hangs still counts
    # toward the cap — a broken launcher must not become an unbounded tight retry either.
    record_relaunch_attempt "$lane"
    echo "$(date '+%H:%M:%S') relaunching $name on $ACCT (pid-file said dead, attempt $((COUNT + 1))/$RELAUNCH_HOURLY_CAP this hour)" >> "$LOG"
    OUT=$(bash "$LAUNCHER" "$name" "$repo" 2>&1)
    echo "$OUT" >> "$LOG"
    PID=$(echo "$OUT" | grep -o 'pid [0-9]*' | grep -o '[0-9]*')
    [ -n "$PID" ] && echo "$PID" > "$PIDDIR/$lane.pid"
    sleep 15
  done < "$MANIFEST"
  sleep "$POLL_SECONDS"
done
