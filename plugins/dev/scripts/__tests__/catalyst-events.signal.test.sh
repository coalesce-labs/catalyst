#!/usr/bin/env bash
# Shell tests for catalyst-events signal handling and PPID liveness — CTL-439.
#
# Verifies that `tail` and `wait-for` exit promptly when:
#   1. Their parent process is killed and they get reparented to init (PPID
#      becomes stale; trap doesn't fire because no signal is delivered).
#   2. They receive SIGTERM directly (trap fires, exits 0).
#
# Without the fix, both processes would block in their `sleep 1` polling loops
# until either a downstream event arrived (tail) or their --timeout fired
# (wait-for, default 1800 s).
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-events.signal.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
EVENTS="${REPO_ROOT}/plugins/dev/scripts/catalyst-events"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
export CATALYST_DIR="$SCRATCH"
export CATALYST_EVENTS_DIR="$SCRATCH/events"
mkdir -p "$CATALYST_EVENTS_DIR"
EVENTS_FILE="$CATALYST_EVENTS_DIR/$(date -u +%Y-%m).jsonl"
: > "$EVENTS_FILE"

# Track child PIDs so we can clean up even on test failure.
CHILDREN=()
cleanup() {
  for pid in "${CHILDREN[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# Poll for process exit. Returns 0 if the process is gone within $timeout
# seconds, 1 otherwise. Resolution is 100 ms.
wait_for_exit() {
  local pid="$1" timeout="$2"
  local elapsed_ms=0
  local timeout_ms=$(( timeout * 1000 ))
  while [ "$elapsed_ms" -lt "$timeout_ms" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
    elapsed_ms=$(( elapsed_ms + 100 ))
  done
  return 1
}

pass() {
  PASSES=$((PASSES+1))
  echo "  PASS: $1"
}

fail() {
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $1"
}

echo "catalyst-events signal handling tests"

# ── 1. tail exits ≤2s when parent dies (orphan-to-init path) ───────────────
# Spawn a wrapper bash subshell that exec's catalyst-events tail. Killing the
# wrapper would normally orphan the tail (PPID becomes 1 on Linux/macOS).
# The fix: tail polls `kill -0 $PPID` each loop iteration and exits when its
# original parent disappears.
{
  WRAPPER_OUT="$SCRATCH/wrapper.out"
  WRAPPER_PIDFILE="$SCRATCH/wrapper.pid"
  TAIL_PIDFILE="$SCRATCH/tail.pid"

  # Wrapper: launch tail in background, record both PIDs, then sleep so the
  # wrapper outlives the launch. Use `setsid` if available so the wrapper is
  # its own session leader (otherwise SIGTERM to wrapper would propagate to
  # tail and we wouldn't be testing the PPID path).
  bash -c '
    "$1" tail >/dev/null 2>&1 &
    echo $! > "$2"
    echo $$ > "$3"
    sleep 30
  ' _ "$EVENTS" "$TAIL_PIDFILE" "$WRAPPER_PIDFILE" &
  WRAPPER_PID=$!
  CHILDREN+=("$WRAPPER_PID")

  # Give the wrapper a moment to write the pidfiles.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$TAIL_PIDFILE" ] && [ -s "$WRAPPER_PIDFILE" ] && break
    sleep 0.1
  done

  TAIL_PID=""
  [ -s "$TAIL_PIDFILE" ] && TAIL_PID=$(cat "$TAIL_PIDFILE")
  if [ -z "$TAIL_PID" ]; then
    fail "tail orphan: could not capture tail PID from wrapper"
  elif ! kill -0 "$TAIL_PID" 2>/dev/null; then
    fail "tail orphan: tail process never started (pid $TAIL_PID)"
  else
    CHILDREN+=("$TAIL_PID")
    # SIGKILL the wrapper without warning — the tail child gets reparented
    # to init and receives no signal.
    kill -KILL "$WRAPPER_PID" 2>/dev/null
    if wait_for_exit "$TAIL_PID" 3; then
      pass "tail exits ≤3s after parent SIGKILL (orphan-to-init)"
    else
      fail "tail did not exit after parent SIGKILL (still alive after 3s)"
      kill -KILL "$TAIL_PID" 2>/dev/null
    fi
  fi
}

# ── 2. tail exits cleanly on SIGTERM ───────────────────────────────────────
{
  "$EVENTS" tail >/dev/null 2>&1 &
  TAIL_PID=$!
  CHILDREN+=("$TAIL_PID")
  sleep 0.3   # let the script enter its loop
  if ! kill -0 "$TAIL_PID" 2>/dev/null; then
    fail "tail SIGTERM: tail exited before we could signal it"
  else
    kill -TERM "$TAIL_PID" 2>/dev/null
    if wait_for_exit "$TAIL_PID" 2; then
      pass "tail exits ≤2s on SIGTERM"
    else
      fail "tail did not exit on SIGTERM (still alive after 2s)"
      kill -KILL "$TAIL_PID" 2>/dev/null
    fi
  fi
}

# ── 3. wait-for exits ≤3s when parent dies (orphan path) ──────────────────
# wait-for with a long --timeout would otherwise sit for ~30 minutes after
# its parent goes away.
{
  WAITFOR_PIDFILE="$SCRATCH/waitfor.pid"
  WRAPPER_PIDFILE="$SCRATCH/wf-wrapper.pid"

  bash -c '
    "$1" wait-for --timeout 3600 --filter ".event == \"never-matches-anything-12345\"" >/dev/null 2>&1 &
    echo $! > "$2"
    echo $$ > "$3"
    sleep 30
  ' _ "$EVENTS" "$WAITFOR_PIDFILE" "$WRAPPER_PIDFILE" &
  WRAPPER_PID=$!
  CHILDREN+=("$WRAPPER_PID")

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$WAITFOR_PIDFILE" ] && break
    sleep 0.1
  done

  WAITFOR_PID=""
  [ -s "$WAITFOR_PIDFILE" ] && WAITFOR_PID=$(cat "$WAITFOR_PIDFILE")
  if [ -z "$WAITFOR_PID" ]; then
    fail "wait-for orphan: could not capture wait-for PID"
  elif ! kill -0 "$WAITFOR_PID" 2>/dev/null; then
    fail "wait-for orphan: wait-for never started"
  else
    CHILDREN+=("$WAITFOR_PID")
    kill -KILL "$WRAPPER_PID" 2>/dev/null
    if wait_for_exit "$WAITFOR_PID" 3; then
      pass "wait-for exits ≤3s after parent SIGKILL (orphan-to-init)"
    else
      fail "wait-for did not exit after parent SIGKILL (still alive after 3s)"
      kill -KILL "$WAITFOR_PID" 2>/dev/null
    fi
  fi
}

# ── 4. wait-for exits cleanly on SIGTERM ──────────────────────────────────
{
  "$EVENTS" wait-for --timeout 3600 --filter '.event == "never-matches-anything-12345"' >/dev/null 2>&1 &
  WAITFOR_PID=$!
  CHILDREN+=("$WAITFOR_PID")
  sleep 0.3
  if ! kill -0 "$WAITFOR_PID" 2>/dev/null; then
    fail "wait-for SIGTERM: wait-for exited before we could signal it"
  else
    kill -TERM "$WAITFOR_PID" 2>/dev/null
    if wait_for_exit "$WAITFOR_PID" 2; then
      pass "wait-for exits ≤2s on SIGTERM"
    else
      fail "wait-for did not exit on SIGTERM (still alive after 2s)"
      kill -KILL "$WAITFOR_PID" 2>/dev/null
    fi
  fi
}

echo
echo "Results: $PASSES passed, $FAILURES failed"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
