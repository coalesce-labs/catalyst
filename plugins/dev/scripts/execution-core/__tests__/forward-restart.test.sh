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
# `exec -a` sets the stub's argv[0] so its command line contains "otel-forward":
# read_forward_pid checks process IDENTITY, not just `kill -0` (a recycled pid
# must never be reported live or signalled), so a stub that looked like a bare
# `sleep` would be correctly rejected as not-the-forwarder and every pid-file
# assertion below would fail.
exec -a "bun run otel-forward/index.ts" sleep 300
SH
chmod +x "$BIN/bun"

export PATH="$BIN:$PATH"
export CATALYST_DIR="$TMP"
FORWARD_PID_FILE="$TMP/otel-forward.pid"

run_monitor() { bash "$MONITOR" "$@"; }

# Load the monitor's own helpers into THIS shell so the assertions below can call
# the production predicate rather than a drifting copy of it. The script has no
# `BASH_SOURCE == $0` guard and dispatches at the bottom, so it is sourced with an
# explicit `help` arg and silenced — that path only prints usage(). CATALYST_DIR is
# already exported above, so its FORWARD_PID_FILE resolves to the same temp path we
# use; it is re-asserted afterwards regardless so a future change to either side
# cannot silently repoint this test at the real ~/catalyst.
# shellcheck disable=SC1090
source "$MONITOR" help >/dev/null 2>&1 || true
FORWARD_PID_FILE="$TMP/otel-forward.pid"
type _forward_pid_gone >/dev/null 2>&1 \
  || { echo "FAIL: _forward_pid_gone not defined after sourcing $MONITOR"; exit 1; }

# --- Test 3 (static): usage() + dispatch case mention forward-restart ---
# Capture first, then match. Piping straight into `grep -q` is unsafe under
# `set -o pipefail`: grep exits at the first match, and if usage() still has
# lines to write (it does — the watchdog-* commands print after forward-restart)
# the writer takes SIGPIPE and the pipeline reports failure on a PASSING check.
USAGE_OUT="$(run_monitor help 2>&1)"
grep -q 'forward-restart' <<<"$USAGE_OUT" \
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
# Capture the restart's own output: when the assertion below fails, whether the stop
# path said "Forwarder stopped" or "Forwarder not running" is the single most
# diagnostic fact, and a bare pid assertion throws it away.
HOT_OUT="$(run_monitor forward-restart 2>&1)" || { echo "FAIL: forward-restart (hot) exit != 0"; echo "$HOT_OUT"; exit 1; }
[[ -f "$FORWARD_PID_FILE" ]] || { echo "FAIL: pid file gone after hot restart"; exit 1; }
PID2="$(cat "$FORWARD_PID_FILE")"
[[ "$PID2" != "$PID1" ]] || { echo "FAIL: pid did not change on hot restart ($PID1 == $PID2)"; exit 1; }
kill -0 "$PID2" 2>/dev/null || { echo "FAIL: new forwarder pid $PID2 not alive"; exit 1; }
# CTL-1502 CI FLAKE: root cause was a real gap in _forward_stop_impl (fixed in
# catalyst-monitor.sh) — the SIGKILL escalation path returned immediately with
# no confirmation the kill took effect, so "Forwarder stopped" could be echoed
# moments before the kernel actually finished tearing PID1 down.
#
# This observer loop polls _forward_pid_gone, NOT `kill -0` (Codex #3172 P1).
# `kill -0` succeeds for a DEFUNCT process, so where PID 1 does not reap promptly
# — the shell-test/CI container — every one of these 10 iterations would report
# the reaped forwarder as still alive and this assertion would fail 100% of the
# time, which is exactly the "old forwarder pid ... still alive after restart"
# failure this PR set out to fix. See Test 5 for the standalone proof.
PID1_GONE=0
for _ in $(seq 1 10); do
  # `if`, not `pred && { ... }`: under `set -e` a bare `cmd && list` STATEMENT
  # exits the shell when cmd returns non-zero, which here is the ordinary
  # "not gone yet" path.
  if _forward_pid_gone "$PID1"; then PID1_GONE=1; break; fi
  sleep 0.1
done
if [[ "$PID1_GONE" != "1" ]]; then
  # Fail LOUDLY with the evidence needed to tell the three causes apart:
  #   - stop never ran (pid-file/identity gate)  -> restart output says "not running"
  #   - stop ran but the process survived        -> state is R/S/D
  #   - stop ran and it is defunct               -> state is Z (predicate regression)
  echo "FAIL: old forwarder pid $PID1 still alive after restart"
  echo "  restart output : ${HOT_OUT:-<empty>}"
  echo "  kill -0        : $(kill -0 "$PID1" 2>/dev/null && echo succeeds || echo fails)"
  echo "  ps state       : [$(ps -o state= -p "$PID1" 2>/dev/null)] (rc=$?)"
  echo "  ps command     : [$(ps -o command= -p "$PID1" 2>/dev/null)]"
  echo "  _forward_pid_gone: $(_forward_pid_gone "$PID1" && echo gone || echo not-gone)"
  echo "  pid file       : [$(cat "$FORWARD_PID_FILE" 2>/dev/null)]"
  exit 1
fi

# --- Test 4: two back-to-back restarts both exit 0 (idempotent) ---
run_monitor forward-restart >/dev/null || { echo "FAIL: 1st back-to-back restart exit != 0"; exit 1; }
run_monitor forward-restart >/dev/null || { echo "FAIL: 2nd back-to-back restart exit != 0"; exit 1; }
PID3="$(cat "$FORWARD_PID_FILE")"
kill -0 "$PID3" 2>/dev/null || { echo "FAIL: forwarder not alive after back-to-back restarts"; exit 1; }

# --- Test 5: a DEFUNCT process reads as gone, and `kill -0` proves it cannot ---
#
# The non-vacuity guard for the whole fix (Codex #3172 P1). Tests 1-4 exercise only
# the happy path where the stub forwarder is genuinely reaped, so they would keep
# passing even if the stop path reverted to polling `kill -0` — the zombie case
# manifests only under a PID 1 that does not reap promptly, which is the CI
# container and never a dev machine. Without this test the fix is unguarded.
#
# The subject is a REAL, genuinely-running process, so `kill -0` unambiguously
# succeeds on it; only its reported STATE is stubbed to `Z`. That is the exact
# shape of the bug — a pid that `kill -0` swears is alive but which is in fact
# dead — and it isolates the thing actually under test: how _forward_pid_gone
# INTERPRETS the process state.
#
# Deliberately NOT manufacturing a real zombie (fork a child, never wait()): whether
# it stays defunct depends on the host's init and on bash reaping opportunistically
# via waitpid(-1) while blocked in a foreground command. It proved unreliable even
# locally. Adding a host-dependent test to fix a host-dependent flake would just
# trade one flake for another.
PSBIN="$TMP/psbin"; mkdir -p "$PSBIN"
cat > "$PSBIN/ps" <<'SH'
#!/usr/bin/env bash
# Stub: report ONE nominated pid as defunct; delegate everything else to the real
# ps so unrelated callers (e.g. _forward_pid_is_ours) keep working normally.
fmt=""; want=""; args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) fmt="$2"; args+=("$1" "$2"); shift 2 ;;
    -p) want="$2"; args+=("$1" "$2"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
if [[ "$fmt" == "state=" && -n "${FAKE_ZOMBIE_PID:-}" && "$want" == "$FAKE_ZOMBIE_PID" ]]; then
  echo "Z"
  exit 0
fi
exec /bin/ps "${args[@]}"
SH
chmod +x "$PSBIN/ps"

# A real, running process to stand in for the reparented forwarder.
sleep 30 &
ZPID=$!

# (a) The blind spot itself: kill -0 MUST report this pid as alive. If that ever
#     stopped holding, the predicate below would not be load-bearing and this test
#     would be vacuous — so assert it positively rather than assuming it.
if ! kill -0 "$ZPID" 2>/dev/null; then
  echo "FAIL: subject pid $ZPID not visible to kill -0 — test cannot prove the gap"; exit 1
fi

# (b) The fix: with the state reported as defunct, the predicate must call it gone —
#     even though kill -0 (asserted above) still says alive.
OLD_PATH="$PATH"
export PATH="$PSBIN:$PATH" FAKE_ZOMBIE_PID="$ZPID"
if ! _forward_pid_gone "$ZPID"; then
  export PATH="$OLD_PATH"; unset FAKE_ZOMBIE_PID
  echo "FAIL: _forward_pid_gone reported a defunct (state=Z) pid $ZPID as still running"; exit 1
fi

# (c) The other half of the predicate: with the SAME pid reported by the real ps
#     (running), it must read as NOT gone. Without this, a trivial "always gone"
#     implementation would satisfy (b).
export PATH="$OLD_PATH"; unset FAKE_ZOMBIE_PID
if _forward_pid_gone "$ZPID"; then
  echo "FAIL: _forward_pid_gone reported live pid $ZPID as gone"; exit 1
fi

# (d) A pid that does not exist at all must read as gone.
kill -9 "$ZPID" 2>/dev/null || true
wait "$ZPID" 2>/dev/null || true
if ! _forward_pid_gone "$ZPID"; then
  echo "FAIL: _forward_pid_gone reported reaped pid $ZPID as still running"; exit 1
fi

echo "PASS: forward-restart cold-start, hot-swap, and idempotent back-to-back restarts + wiring"
echo "PASS: defunct pid reads as gone (kill -0 cannot see it); live and reaped pids read correctly"
