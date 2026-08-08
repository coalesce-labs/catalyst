#!/usr/bin/env bash
# Shell unit tests for the CTL-1502 forwarder/watchdog supervision surface in
# plugins/dev/scripts/catalyst-monitor.sh. Covers the three Codex P1 fixes that
# live in bash (the JS-side ones are covered by the bun suites):
#
#   1. Node-class gating — catalyst-stack starts the STANDALONE watchdog on a
#      monitor node (otel-forward without execution-core) and never on a worker
#      (where startDaemon arms the in-daemon probe), so exactly one supervisor
#      exists per forwarder in either topology.
#   2. PID identity — read_forward_pid / read_watchdog_pid must not report a
#      RECYCLED pid as live, or an enforced restart would SIGTERM/SIGKILL an
#      unrelated same-user process. Fails CLOSED when ps cannot answer.
#   3. Lock discipline — the forwarder mutation lock is atomic (mkdir), reaps a
#      dead owner's stale lock, and its INT/TERM handler EXITS rather than
#      returning (a returning handler lets an aborted restart resume into the
#      start half and relaunch the forwarder after shutdown was requested).
#
# Follows the __tests__/catalyst-deployment-mode.test.sh conventions
# (ok/fail/expect_eq, PASSES/FAILURES exit code).
#
# Run: bash plugins/dev/scripts/__tests__/daemon-watchdog-supervision.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
MONITOR_SH="${REPO_ROOT}/plugins/dev/scripts/catalyst-monitor.sh"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"
RUNNER="${REPO_ROOT}/plugins/dev/scripts/execution-core/daemon-watchdog-run.mjs"

FAILURES=0
PASSES=0

ok()   { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; }
check() { if [[ "$1" == "yes" ]]; then ok "$2"; else fail "$2"; fi; }

# ── 0. the pieces exist and parse ───────────────────────────────────────────
[[ -f "$RUNNER" ]] && ok "standalone runner exists (daemon-watchdog-run.mjs)" \
                   || fail "standalone runner missing"
bash -n "$MONITOR_SH" 2>/dev/null && ok "catalyst-monitor.sh parses" \
                                  || fail "catalyst-monitor.sh syntax error"
bash -n "$STACK" 2>/dev/null && ok "catalyst-stack parses" \
                             || fail "catalyst-stack syntax error"

# ── 1. node-class gating (static assertions over catalyst-stack) ────────────
# The standalone watchdog must be started ONLY for node_class == monitor. A
# worker arms the probe inside startDaemon; a developer runs no forwarder.
if grep -q 'node_class" == "monitor" \]\]' "$STACK" \
   && grep -A2 'node_class" == "monitor" \]\]' "$STACK" | grep -q 'start_daemon_watchdog'; then
  ok "catalyst-stack starts the standalone watchdog on a monitor node"
else
  fail "catalyst-stack does not gate start_daemon_watchdog on node_class=monitor"
fi

# It must NOT be started under the worker branch (that would double-supervise).
if grep -A3 'node_class" == "worker" \]\]' "$STACK" | grep -q 'start_daemon_watchdog'; then
  fail "worker branch also starts the standalone watchdog (double supervision)"
else
  ok "worker node does NOT start the standalone watchdog (no double supervision)"
fi

# Shutdown must stop the watchdog BEFORE the forwarder it supervises.
wd_line="$(grep -n '^  stop_daemon_watchdog' "$STACK" | head -1 | cut -d: -f1)"
fw_line="$(grep -n '^  stop_forward' "$STACK" | head -1 | cut -d: -f1)"
if [[ -n "$wd_line" && -n "$fw_line" && "$wd_line" -lt "$fw_line" ]]; then
  ok "cmd_stop stops the watchdog before the forwarder"
else
  fail "cmd_stop ordering wrong (watchdog must stop before forwarder)"
fi

# ── 2. pid identity: a recycled pid must NOT be reported live ───────────────
TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T"' EXIT

# An unrelated live process (stand-in for a recycled pid) written into both
# pid files. Neither reader may claim it, and neither stop may signal it.
sleep 30 &
IMPOSTER=$!

echo "$IMPOSTER" > "${TMPDIR_T}/otel-forward.pid"
echo "$IMPOSTER" > "${TMPDIR_T}/daemon-watchdog.pid"

out="$(CATALYST_DIR="$TMPDIR_T" bash "$MONITOR_SH" forward-status 2>/dev/null)"
[[ "$out" == *"not running"* ]] \
  && ok "forward-status rejects a recycled pid (identity check)" \
  || fail "forward-status accepted a recycled pid: $out"

out="$(CATALYST_DIR="$TMPDIR_T" bash "$MONITOR_SH" watchdog-status 2>/dev/null)"
[[ "$out" == *"not running"* ]] \
  && ok "watchdog-status rejects a recycled pid (identity check)" \
  || fail "watchdog-status accepted a recycled pid: $out"

# The critical safety property: stop must not kill the unrelated process.
echo "$IMPOSTER" > "${TMPDIR_T}/otel-forward.pid"
CATALYST_DIR="$TMPDIR_T" bash "$MONITOR_SH" forward-stop >/dev/null 2>&1
if ps -p "$IMPOSTER" >/dev/null 2>&1; then
  ok "forward-stop did NOT signal the unrelated process"
else
  fail "forward-stop KILLED an unrelated process (recycled-pid hazard)"
fi

echo "$IMPOSTER" > "${TMPDIR_T}/daemon-watchdog.pid"
CATALYST_DIR="$TMPDIR_T" bash "$MONITOR_SH" watchdog-stop >/dev/null 2>&1
if ps -p "$IMPOSTER" >/dev/null 2>&1; then
  ok "watchdog-stop did NOT signal the unrelated process"
else
  fail "watchdog-stop KILLED an unrelated process (recycled-pid hazard)"
fi

kill "$IMPOSTER" 2>/dev/null || true
wait "$IMPOSTER" 2>/dev/null || true

# ── 3. lock discipline (assertions over the extracted implementation) ───────
# A dead owner's lock is debris and must be reaped, else every future forwarder
# mutation wedges forever.
LOCKDIR="${TMPDIR_T}/otel-forward.lock"
mkdir -p "$LOCKDIR"
echo "999999" > "${LOCKDIR}/owner"   # a pid that cannot be alive
out="$(CATALYST_DIR="$TMPDIR_T" bash "$MONITOR_SH" forward-status 2>&1)"
CATALYST_DIR="$TMPDIR_T" bash "$MONITOR_SH" forward-stop >/dev/null 2>&1
if [[ ! -d "$LOCKDIR" ]]; then
  ok "a dead owner's stale lock is reaped (no permanent wedge)"
else
  fail "stale lock survived — forwarder mutations would wedge forever"
fi

# The INT/TERM handler must EXIT, not return. A handler that only releases the
# lock lets bash resume the interrupted function — an aborted restart would
# continue into the start half and relaunch the forwarder after shutdown.
if grep -q '_forward_lock_signal_exit' "$MONITOR_SH" \
   && grep -A4 '^_forward_lock_signal_exit()' "$MONITOR_SH" | grep -q 'exit 143'; then
  ok "INT/TERM handler exits (143) instead of returning"
else
  fail "INT/TERM handler does not exit — an aborted restart could resume"
fi

# EXIT must NOT share the exiting handler (that would turn every clean return
# into a 143) — the traps are deliberately split.
if grep -q 'trap release_forward_lock EXIT$' "$MONITOR_SH" \
   && grep -q 'trap _forward_lock_signal_exit INT TERM' "$MONITOR_SH"; then
  ok "EXIT and INT/TERM traps are split (clean exits stay clean)"
else
  fail "traps are not split as expected"
fi

# forward-restart must hold ONE lock across both halves; two independent locks
# would reopen the concurrent-start gap between stop and start.
if grep -A12 '^cmd_forward_restart()' "$MONITOR_SH" | grep -q 'acquire_forward_lock' \
   && grep -A14 '^cmd_forward_restart()' "$MONITOR_SH" | grep -q '_forward_stop_impl' \
   && grep -A14 '^cmd_forward_restart()' "$MONITOR_SH" | grep -q '_forward_start_impl'; then
  ok "forward-restart holds one lock across stop+start (single transaction)"
else
  fail "forward-restart does not hold a single lock across both halves"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]]
