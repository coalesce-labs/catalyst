#!/usr/bin/env bash
# Shell tests for catalyst-comms signal handling and PPID liveness — CTL-1423.
# Models on catalyst-events.signal.test.sh (CTL-439).
#
# Verifies that `poll --wait` and `watch` exit promptly when:
#   1. Their parent process is killed and they are reparented to init (PPID
#      becomes stale; trap doesn't fire because no signal is delivered).
#   2. They receive SIGTERM directly (trap fires, exits 0).
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-comms.signal.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
COMMS="${REPO_ROOT}/plugins/dev/scripts/catalyst-comms"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
CHANNEL="test-signal-$$"
export CATALYST_COMMS_DIR="$SCRATCH/comms"
mkdir -p "$CATALYST_COMMS_DIR/channels"
echo '{}' > "$CATALYST_COMMS_DIR/channels.json"
# Create the channel file so poll/watch don't wait for it.
touch "$CATALYST_COMMS_DIR/channels/${CHANNEL}.jsonl"

# Register the channel so poll/watch don't fail the require_channel check.
"$COMMS" join "$CHANNEL" --as "signal-test" --ttl 3600 >/dev/null 2>&1 || {
  echo "error: could not register test channel" >&2
  rm -rf "$SCRATCH"
  exit 1
}

CHILDREN=()
cleanup() {
  for pid in "${CHILDREN[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

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

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; }

echo "catalyst-comms signal handling tests"

# ── 1. poll --wait exits ≤5s when parent dies (orphan-to-init path) ────────
{
  PIDFILE_POLL="$SCRATCH/poll.pid"
  WRAPPER_PIDFILE="$SCRATCH/poll-wrapper.pid"

  bash -c '
    "$1" poll "$2" --wait >/dev/null 2>&1 &
    echo $! > "$3"
    echo $$ > "$4"
    sleep 30
  ' _ "$COMMS" "$CHANNEL" "$PIDFILE_POLL" "$WRAPPER_PIDFILE" &
  WRAPPER_PID=$!
  CHILDREN+=("$WRAPPER_PID")

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$PIDFILE_POLL" ] && [ -s "$WRAPPER_PIDFILE" ] && break
    sleep 0.1
  done

  POLL_PID=""
  [ -s "$PIDFILE_POLL" ] && POLL_PID=$(cat "$PIDFILE_POLL")
  if [ -z "$POLL_PID" ]; then
    fail "poll orphan: could not capture poll PID from wrapper"
  elif ! kill -0 "$POLL_PID" 2>/dev/null; then
    fail "poll orphan: poll process never started (pid $POLL_PID)"
  else
    CHILDREN+=("$POLL_PID")
    kill -KILL "$WRAPPER_PID" 2>/dev/null
    if wait_for_exit "$POLL_PID" 5; then
      pass "poll --wait exits ≤5s after parent SIGKILL (orphan-to-init)"
    else
      fail "poll --wait did not exit after parent SIGKILL (still alive after 5s)"
      kill -KILL "$POLL_PID" 2>/dev/null
    fi
  fi
}

# ── 2. poll --wait exits cleanly on SIGTERM ─────────────────────────────────
{
  "$COMMS" poll "$CHANNEL" --wait >/dev/null 2>&1 &
  POLL_PID=$!
  CHILDREN+=("$POLL_PID")
  sleep 0.3
  if ! kill -0 "$POLL_PID" 2>/dev/null; then
    fail "poll SIGTERM: poll exited before we could signal it"
  else
    kill -TERM "$POLL_PID" 2>/dev/null
    if wait_for_exit "$POLL_PID" 3; then
      pass "poll --wait exits ≤3s on SIGTERM"
    else
      fail "poll --wait did not exit on SIGTERM (still alive after 3s)"
      kill -KILL "$POLL_PID" 2>/dev/null
    fi
  fi
}

# ── 3. watch exits ≤5s when parent dies (orphan-to-init path) ────────────
{
  PIDFILE_WATCH="$SCRATCH/watch.pid"
  WRAPPER_PIDFILE="$SCRATCH/watch-wrapper.pid"

  bash -c '
    "$1" watch "$2" >/dev/null 2>&1 &
    echo $! > "$3"
    echo $$ > "$4"
    sleep 30
  ' _ "$COMMS" "$CHANNEL" "$PIDFILE_WATCH" "$WRAPPER_PIDFILE" &
  WRAPPER_PID=$!
  CHILDREN+=("$WRAPPER_PID")

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$PIDFILE_WATCH" ] && [ -s "$WRAPPER_PIDFILE" ] && break
    sleep 0.1
  done

  WATCH_PID=""
  [ -s "$PIDFILE_WATCH" ] && WATCH_PID=$(cat "$PIDFILE_WATCH")
  if [ -z "$WATCH_PID" ]; then
    fail "watch orphan: could not capture watch PID from wrapper"
  elif ! kill -0 "$WATCH_PID" 2>/dev/null; then
    fail "watch orphan: watch process never started (pid $WATCH_PID)"
  else
    CHILDREN+=("$WATCH_PID")
    kill -KILL "$WRAPPER_PID" 2>/dev/null
    if wait_for_exit "$WATCH_PID" 5; then
      pass "watch exits ≤5s after parent SIGKILL (orphan-to-init)"
    else
      fail "watch did not exit after parent SIGKILL (still alive after 5s)"
      kill -KILL "$WATCH_PID" 2>/dev/null
    fi
  fi
}

# ── 4. watch exits cleanly on SIGTERM ────────────────────────────────────
{
  "$COMMS" watch "$CHANNEL" >/dev/null 2>&1 &
  WATCH_PID=$!
  CHILDREN+=("$WATCH_PID")
  sleep 0.3
  if ! kill -0 "$WATCH_PID" 2>/dev/null; then
    fail "watch SIGTERM: watch exited before we could signal it"
  else
    kill -TERM "$WATCH_PID" 2>/dev/null
    if wait_for_exit "$WATCH_PID" 3; then
      pass "watch exits ≤3s on SIGTERM"
    else
      fail "watch did not exit on SIGTERM (still alive after 3s)"
      kill -KILL "$WATCH_PID" 2>/dev/null
    fi
  fi
}

echo
echo "Results: $PASSES passed, $FAILURES failed"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
