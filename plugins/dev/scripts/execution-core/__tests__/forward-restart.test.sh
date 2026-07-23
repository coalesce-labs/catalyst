#!/usr/bin/env bash
# CTL-1502: verify the atomic `forward-restart` subcommand of catalyst-monitor.sh.
# Follows the inbox-checkpoint.test.sh pattern — a self-contained shell test with a
# temp HOME/CATALYST_DIR and a stubbed FORWARD_SCRIPT (a real detached `sleep`) so
# no bun/daemon launches. Asserts pid-file transitions across restart from every
# state and that the subcommand is wired into usage()/dispatch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC_CORE_DIR="$(dirname "$SCRIPT_DIR")"
MONITOR="$(dirname "$EXEC_CORE_DIR")/catalyst-monitor.sh"

[[ -f "$MONITOR" ]] || { echo "FAIL: catalyst-monitor.sh not found at $MONITOR"; exit 1; }

TMP="$(mktemp -d)"
cleanup() {
  # Best-effort: kill any stub forwarder we started.
  [[ -f "$TMP/otel-forward.pid" ]] && kill "$(cat "$TMP/otel-forward.pid" 2>/dev/null)" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# A fake forwarder that just sleeps — stand-in for the real daemon. cmd_forward_start
# runs `bun run "$FORWARD_SCRIPT"`, so shim `bun` on PATH to exec a long-lived sleep.
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/bun" <<'SH'
#!/usr/bin/env bash
# Shim: `bun run <script>` → a detached long-lived sleep as the stand-in daemon.
exec sleep 300
SH
chmod +x "$BIN/bun"

export PATH="$BIN:$PATH"
export CATALYST_DIR="$TMP"
FORWARD_PID_FILE="$TMP/otel-forward.pid"

run_monitor() { bash "$MONITOR" "$@"; }

# --- Test 3 (static): usage() + dispatch case mention forward-restart ---
run_monitor help 2>&1 | grep -q 'forward-restart' \
  || { echo "FAIL: 'forward-restart' absent from usage()"; exit 1; }
grep -qE '^\s*forward-restart\)' "$MONITOR" \
  || { echo "FAIL: 'forward-restart)' dispatch case absent"; exit 1; }

# --- Test 1: forward-restart when NOT running → starts (pid file created), exit 0 ---
rm -f "$FORWARD_PID_FILE"
run_monitor forward-restart >/dev/null || { echo "FAIL: forward-restart (cold) exit != 0"; exit 1; }
[[ -f "$FORWARD_PID_FILE" ]] || { echo "FAIL: pid file not created on cold restart"; exit 1; }
PID1="$(cat "$FORWARD_PID_FILE")"
kill -0 "$PID1" 2>/dev/null || { echo "FAIL: stub forwarder pid $PID1 not alive after cold restart"; exit 1; }

# --- Test 2: forward-restart when running → stops old, starts new; pid file holds NEW pid ---
run_monitor forward-restart >/dev/null || { echo "FAIL: forward-restart (hot) exit != 0"; exit 1; }
[[ -f "$FORWARD_PID_FILE" ]] || { echo "FAIL: pid file gone after hot restart"; exit 1; }
PID2="$(cat "$FORWARD_PID_FILE")"
[[ "$PID2" != "$PID1" ]] || { echo "FAIL: pid did not change on hot restart ($PID1 == $PID2)"; exit 1; }
kill -0 "$PID2" 2>/dev/null || { echo "FAIL: new forwarder pid $PID2 not alive"; exit 1; }
kill -0 "$PID1" 2>/dev/null && { echo "FAIL: old forwarder pid $PID1 still alive after restart"; exit 1; } || true

# --- Test 4: two back-to-back restarts both exit 0 (idempotent) ---
run_monitor forward-restart >/dev/null || { echo "FAIL: 1st back-to-back restart exit != 0"; exit 1; }
run_monitor forward-restart >/dev/null || { echo "FAIL: 2nd back-to-back restart exit != 0"; exit 1; }
PID3="$(cat "$FORWARD_PID_FILE")"
kill -0 "$PID3" 2>/dev/null || { echo "FAIL: forwarder not alive after back-to-back restarts"; exit 1; }

echo "PASS: forward-restart cold-start, hot-swap, and idempotent back-to-back restarts + wiring"
