#!/bin/bash
# lane-relaunch.sh — run on the CONCIERGE's own machine (the laptop). Watches a manifest of
# ad-hoc `claude -p` steward/worker "lanes" and relaunches any that have died, using each lane's
# latest launch-<lane>N.txt brief and the account currently active in fleet-account.current.
#
# ⛔ STOPGAP, NOT THE PRODUCT. This whole ad-hoc claude -p + watchdog pattern exists only because
# CTL-1974 (role-supervisor) / CTL-2095 (concierge instantiates + retires stewards) have not landed
# yet. When they do, RETIRE this script rather than maintain it as a second mechanism (CTL-2097).
# CTL-2145 hardens the stopgap DURABLY IN PLACE — it does not extend its remit. The retirement
# still belongs to those tickets.
#
# CTL-2097 (2026-08-19/20): a prior version of this script checked liveness by grepping `ps aux`
# output for ~60 chars of a lane's brief text. That NEVER matched — `claude -p`'s process listing
# does not preserve prompt text verbatim in a greppable form — so every 10-minute pass treated every
# lane as dead and relaunched it regardless of whether it was actually running. Measured impact: 117
# duplicate relaunches in one overnight run, all 4 Claude accounts walled. This version fixes that by
# tracking liveness via a PID FILE written at spawn time, checked with `kill -0` — never text-matching
# `ps` output. Verified with coord/__tests__/lane-relaunch.test.sh (or the harness pattern
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
# CTL-2145 (2026-08-21): this script used to live at the repo root (scripts/comms/) and be run by
# a `nohup`'d loop owned by whichever concierge session happened to be alive. When that session's
# job record was cleaned up, its launchers and fleet-account.current — a symlink INTO the deleted
# dir — vanished, and this watchdog survived only as a blind zombie holding deleted inodes for the
# ~75 minutes it took a human to notice. It now lives here, under version control, and is
# MATERIALIZED as a real file into the durable runtime dir by coord/materialize-coord-kit.sh.
# Nothing it reads resolves through ~/.claude/jobs/ any more.
#
# Usage:
#   ~/catalyst/comms/coord/lane-relaunch.sh   (the MATERIALIZED copy; loops forever)
#
# Run it from the materialized location, not from the repo: a linked worktree can be deleted out
# from under a long-running process, which is the same class of failure as the job-dir one above.
# (This script is still an unbounded poll loop with no self-deadline — it is deliberately NOT the
# thing the CTL-2145 LaunchAgent supervises. The account-rotation actor beside it is a
# StartInterval one-shot precisely so it cannot zombie; see coord/account-rotation-watch.sh.)
#
# Requires, all relative to the comms kit directory (COMMS_DIR, default ~/catalyst/comms/coord):
#   lanes.manifest            — one "<lane-prefix> <repo-dir>" per line
#   launch-<lane-prefix>N.txt — the Nth brief for that lane; highest N wins
#   launch-on-<account>.sh    — the per-account launcher, generated one-per-provisioned-handle by
#                               materialize-coord-kit.sh into COMMS_DIR itself (LAUNCHER_DIR
#                               defaults there; override only if you keep launchers elsewhere)
#   fleet-account.current     — single line naming the active Claude account (e.g. "acct2")

set -u

# EXPORTED, not merely assigned (CTL-2145): the per-account launcher invoked below reads
# COMMS_DIR from its ENVIRONMENT to locate the brief and the log, falling back to the path
# baked in at materialize time. Without the export a kit running under a nondefault
# COMMS_DIR handed the launcher nothing, so it looked for briefs in the baked location,
# failed every launch, and consumed the relaunch cap doing it.
export COMMS_DIR="${COMMS_DIR:-$HOME/catalyst/comms/coord}"
# CTL-2145: LAUNCHER_DIR used to be REQUIRED, and the operator convention was to point it at the
# concierge session's `~/.claude/jobs/<id>/tmp/` dir — which is precisely the ephemeral location
# that vanished mid-incident and left this watchdog invoking a launcher that no longer existed. It
# now DEFAULTS to COMMS_DIR, where materialize-coord-kit.sh generates one launcher per provisioned
# handle. An explicit override is still honored (nothing that set it breaks), but the default is
# now the durable path rather than an unset variable an operator must remember to aim somewhere.
LAUNCHER_DIR="${LAUNCHER_DIR:-$COMMS_DIR}"
LOG="$COMMS_DIR/lane-relaunch.log"
CUR="$COMMS_DIR/fleet-account.current"
PIDDIR="$COMMS_DIR/lane-pids"
MANIFEST="$COMMS_DIR/lanes.manifest"
POLL_SECONDS="${POLL_SECONDS:-900}"
RELAUNCH_HOURLY_CAP="${RELAUNCH_HOURLY_CAP:-4}"
RELAUNCH_WINDOW_SECONDS=3600
mkdir -p "$PIDDIR"

# CTL-2145: the rolling-window circuit breaker is SOURCED, not re-implemented. It used to
# live inline here and be mirrored by hand in the test file ("if you change one, change
# both"), and the account-rotation actor needs the identical mechanism — three copies of
# one cap is how a circuit breaker silently stops matching the thing it breaks. A missing
# lib is FATAL rather than a degraded run: without the window this loop is the unbounded
# relaunch storm CTL-2097 measured at 117 duplicate launches in one night.
_SRC="${BASH_SOURCE[0]}"
while [ -L "$_SRC" ]; do _SRC="$(readlink "$_SRC")"; done
COORD_SRC="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC
WINDOW_LIB="$COORD_SRC/lib/rotation-window.sh"
if [ ! -r "$WINDOW_LIB" ]; then
  echo "lane-relaunch: FATAL — missing $WINDOW_LIB; refusing to run without the relaunch cap" >&2
  exit 1
fi
# shellcheck source=lib/rotation-window.sh
. "$WINDOW_LIB"

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
# for a while ages back under the cap even without a fresh attempt. Thin per-lane adapters over
# the shared window primitives — the mechanism itself lives in lib/rotation-window.sh.
relaunch_count_in_window() { # $1 lane-prefix
  cw_count_in_window "$PIDDIR/$1.relaunches" "$RELAUNCH_WINDOW_SECONDS"
}

record_relaunch_attempt() { # $1 lane-prefix -> append "now" to its rolling-window counter file
  cw_record_attempt "$PIDDIR/$1.relaunches"
}

while :; do
  ACCT=$(cat "$CUR" 2>/dev/null || echo acct1)
  LAUNCHER="$LAUNCHER_DIR/launch-on-$ACCT.sh"
  while read -r lane repo; do
    [ -z "$lane" ] && continue
    if is_alive "$lane"; then continue; fi
    # A counter that cannot be READ is a broken breaker, exactly like one that cannot be
    # written, and it must decline in the same direction. cw_count_in_window used to convert
    # an unreadable file into the count 0 (and truncate it on the way past), so a lane whose
    # counter lost read permission was relaunched every pass forever with `COUNT >= CAP`
    # never true — the uncapped-actuator direction the block below exists to prevent.
    if ! COUNT=$(relaunch_count_in_window "$lane"); then
      MSG="$(date '+%H:%M:%S') REFUSING to relaunch $lane — could not READ the relaunch counter at $PIDDIR/$lane.relaunches; without a working circuit breaker this loop would relaunch uncapped every pass (is it readable?). Not launching; the lane stays down until the counter can be read."
      echo "$MSG" >> "$LOG" 2>/dev/null || true
      echo "$MSG" >&2
      continue
    fi
    if [ "$COUNT" -ge "$RELAUNCH_HOURLY_CAP" ]; then
      echo "$(date '+%H:%M:%S') CAPPED $lane — $COUNT relaunches in the last hour (cap $RELAUNCH_HOURLY_CAP), skipping" >> "$LOG"
      continue
    fi
    brief=$(latest_brief "$lane")
    [ -z "$brief" ] && continue
    name=$(basename "$brief" .txt); name=${name#launch-}
    # Record the attempt BEFORE launching, so a launcher that itself fails or hangs still counts
    # toward the cap — a broken launcher must not become an unbounded tight retry either.
    #
    # And if the attempt cannot be PERSISTED, do not launch at all. cw_record_attempt's non-zero
    # return is load-bearing rather than advisory (lib/rotation-window.sh): $PIDDIR holds both this
    # counter and <lane>.pid, so a directory that refuses the append refuses the pid file too. The
    # two failures compound instead of cancelling — cw_count_in_window reads the missing counter as
    # 0 forever, so `COUNT >= CAP` is never true and no pass is ever CAPPED, while the unwritable
    # pid file makes is_alive report the lane dead on every pass. The result is a launcher fired
    # every POLL_SECONDS indefinitely, each one a real claude session on the active account, with
    # the cap that is supposed to bound it silently disarmed — the one direction a circuit breaker
    # must never fail in. Measured, matched pair (40s, cap 1): writable -> 1 launch and 24 CAPPED
    # refusals; $PIDDIR chmod 555 -> 3 launches and 0 CAPPED lines.
    #
    # `continue`, NOT `exit`: unlike the account-rotation actor beside it — a StartInterval
    # one-shot that launchd re-runs next interval, so exiting 1 there costs one skipped tick — this
    # is a long-running unsupervised poll loop with nothing to restart it. Exiting would convert a
    # transient unwritable directory into a permanently dead lane watchdog, which is the very
    # unnoticed-dead-lanes failure CTL-2097 exists to prevent. Declining this pass leaves the lane
    # dead and the log loud, and the first pass that can persist the counter relaunches it.
    #
    # Announced on EVERY declining pass rather than once per episode: the marker such a latch would
    # need lives in the directory that just refused a write. At the 900s default that is ~4 lines
    # per hour per lane, which is a cadence an operator can read, not a flood (CTL-1817). It also
    # goes to stderr, since $LOG is under COMMS_DIR and a wider permissions failure takes it too.
    if ! record_relaunch_attempt "$lane"; then
      MSG="$(date '+%H:%M:%S') REFUSING to relaunch $lane — could not record the attempt at $PIDDIR/$lane.relaunches; without a working circuit breaker this loop would relaunch uncapped every pass (is $PIDDIR writable?). Not launching; the lane stays down until the counter can be persisted."
      echo "$MSG" >> "$LOG" 2>/dev/null || true
      echo "$MSG" >&2
      continue
    fi
    echo "$(date '+%H:%M:%S') relaunching $name on $ACCT (pid-file said dead, attempt $((COUNT + 1))/$RELAUNCH_HOURLY_CAP this hour)" >> "$LOG"
    OUT=$(bash "$LAUNCHER" "$name" "$repo" 2>&1)
    echo "$OUT" >> "$LOG"
    PID=$(echo "$OUT" | grep -o 'pid [0-9]*' | grep -o '[0-9]*')
    [ -n "$PID" ] && echo "$PID" > "$PIDDIR/$lane.pid"
    sleep 15
  done < "$MANIFEST"
  sleep "$POLL_SECONDS"
done
