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

_wd_bounded() { # _wd_bounded <deadline_secs> <outfile> <cmd...>
  local limit="$1" out="$2"; shift 2
  local mark cpid wpid rc
  mark="$(mktemp -u)"
  "$@" > "$out" 2>&1 &
  cpid=$!
  ( sleep "$limit"; : > "$mark"; kill -9 "$cpid" 2>/dev/null ) >/dev/null 2>&1 &
  wpid=$!
  wait "$cpid"; rc=$?
  kill -9 "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null
  if [[ -e "$mark" ]]; then
    rm -f "$mark"
    echo "OVERRAN the ${limit}s deadline" >> "$out"
    return 124
  fi
  return "$rc"
}

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
trap 'rm -rf "$TMPDIR_T" "${CFG_OFF:-}" "${CFG_DECOY:-}"' EXIT

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
echo "5999999" > "${LOCKDIR}/owner"   # a pid that cannot be alive
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
if grep -q 'trap _release_all_catalyst_locks EXIT' "$MONITOR_SH" \
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

# ── 4. standalone runner honors Layer-1 config ─────────────────────────────
# readDaemonWatchdogConfig() with NO path makes readDaemonWatchdogConfigLayer1
# return {} unconditionally, silently ignoring every documented Layer-1 knob.
# On a monitor node this runner is the ONLY watchdog host, so that would strand
# its forwarder shadow-only while workers honored the same config file.
if grep -q 'CATALYST_CONFIG_FILE' "$RUNNER" \
   && grep -q 'readDaemonWatchdogConfig(configPath)' "$RUNNER"; then
  ok "standalone runner resolves + passes a Layer-1 config path"
else
  fail "standalone runner ignores Layer-1 config (no configPath threaded)"
fi

# The explicit argv tier must beat the ambient environment tier. A separate
# isolated check below covers the cwd fallback. CATALYST_DIR is a runtime-state
# lever and deliberately does not participate in Layer-1 config resolution.
CFG_OFF="$(mktemp -d)"
mkdir -p "${CFG_OFF}/.catalyst"
cat > "${CFG_OFF}/.catalyst/config.json" <<'JSON'
{"catalyst":{"orchestration":{"daemonWatchdog":{"mode":"off"}}}}
JSON
CFG_DECOY="$(mktemp -d)"
mkdir -p "${CFG_DECOY}/.catalyst"
cat > "${CFG_DECOY}/.catalyst/config.json" <<'JSON'
{"catalyst":{"orchestration":{"daemonWatchdog":{"mode":"shadow"}}}}
JSON
if command -v bun >/dev/null 2>&1; then
  OUT="$(mktemp)"
  if _wd_bounded 15 "$OUT" env CATALYST_CONFIG_FILE="${CFG_DECOY}/.catalyst/config.json" \
       bun run "$RUNNER" --config "${CFG_OFF}/.catalyst/config.json" \
     && grep -q 'disabled by config' "$OUT"; then
    ok "--config outranks an ambient CATALYST_CONFIG_FILE"
  else
    fail "--config did not win over the ambient env: $(cat "$OUT")"
  fi
  grep -q '"configSource":"argv"\|configSource.*argv' "$OUT" \
    && ok "runner reports which config tier won" \
    || fail "no configSource in the runner's disabled-path log line"

  if _wd_bounded 15 "$OUT" env CATALYST_CONFIG_FILE="${CFG_DECOY}/.catalyst/config.json" \
       bun run "$RUNNER" --config "${CFG_OFF}/.catalyst/nope.json"; then
    fail "an unreadable --config silently fell through to another tier"
  else
    rc=$?
    [[ "$rc" == 2 ]] && grep -q 'config file not found' "$OUT" \
      && ok "an unreadable --config exits 2 with a clear message" \
      || fail "expected rc=2 + a clear message, got rc=${rc}: $(cat "$OUT")"
  fi

  if _wd_bounded 15 "$OUT" bun run "$RUNNER" --config; then
    fail "--config without a value silently fell through"
  else
    rc=$?
    [[ "$rc" == 2 ]] && grep -q -- '--config requires a path argument' "$OUT" \
      && ok "--config without a value exits 2 with a clear message" \
      || fail "expected rc=2 for valueless --config, got rc=${rc}: $(cat "$OUT")"
  fi

  # Functional: mode=off must shut down through the cwd tier too. The old form
  # inherited host config and waited forever; this invocation isolates and bounds.
  if _wd_bounded 15 "$OUT" \
       env -u CATALYST_CONFIG_FILE -u CATALYST_CONFIG_PATH \
         sh -c 'cd "$1" && exec bun run "$2"' _ "$CFG_OFF" "$RUNNER" \
     && grep -q 'disabled by config' "$OUT"; then
    ok "cwd fallback resolves Layer-1 when no env override is present"
  else
    fail "cwd fallback did not honor the fixture: $(cat "$OUT")"
  fi
  rm -f "$OUT"
else
  ok "SKIP: bun unavailable — Layer-1 functional checks not run"
fi

# The runner's own <cwd>/.catalyst/config.json fallback is not enough under
# launchd: the stack LaunchAgent sets neither WorkingDirectory nor
# CATALYST_CONFIG_FILE, so after a reboot cwd is `/` and the fallback resolves
# /.catalyst/config.json — silently reverting a monitor node's only watchdog to
# shadow defaults. The spawn must PIN the path.
if grep -B12 'nohup bun run "\$WATCHDOG_SCRIPT"' "$MONITOR_SH" | grep -q 'wd_config' \
   && grep -q 'CATALYST_CONFIG_FILE="\$wd_config" nohup bun run "\$WATCHDOG_SCRIPT"' "$MONITOR_SH"; then
  ok "watchdog spawn pins CATALYST_CONFIG_FILE (survives a launchd cwd of /)"
else
  fail "watchdog spawn does not pin the Layer-1 config path"
fi

# ── 5. the watchdog lifecycle is serialized too ────────────────────────────
# Two concurrent watchdog-starts could otherwise both pass read_watchdog_pid
# before either wrote the pid file, leaving an untracked enforce-mode watchdog
# that watchdog-stop cannot terminate.
if grep -q 'acquire_watchdog_lock' "$MONITOR_SH" \
   && grep -A6 '^cmd_watchdog_start()' "$MONITOR_SH" | grep -q 'acquire_watchdog_lock' \
   && grep -A6 '^cmd_watchdog_stop()' "$MONITOR_SH" | grep -q 'acquire_watchdog_lock'; then
  ok "watchdog start/stop are serialized behind a lock"
else
  fail "watchdog lifecycle is not serialized"
fi

# The forwarder and watchdog locks must be DISTINCT dirs — sharing one would let
# a slow forward-restart block watchdog-status for no reason.
if grep -q 'WATCHDOG_LOCK_DIR=' "$MONITOR_SH" \
   && ! grep -q 'WATCHDOG_LOCK_DIR="\${FORWARD_LOCK_DIR}"' "$MONITOR_SH"; then
  ok "watchdog and forwarder use distinct lock dirs"
else
  fail "watchdog and forwarder share a lock dir"
fi

# bash keeps exactly ONE EXIT trap, so both acquirers must install the combined
# releaser — otherwise the second acquire silently discards the first's cleanup.
if grep -c 'trap _release_all_catalyst_locks EXIT' "$MONITOR_SH" | grep -q '^2$'; then
  ok "both lock acquirers install the combined EXIT releaser"
else
  fail "EXIT traps not unified — one lock's cleanup can clobber the other's"
fi

# ── 6. the watchdog log is one Alloy already tails, and is APPENDED ─────────
# A raised/escalated record written to a file no shipper knows about would never
# reach Loki — the exact failure the out-of-band sink exists to prevent. And it
# must never truncate: this is the shared execution-core daemon log.
if grep -q 'WATCHDOG_LOG="\${CATALYST_DAEMON_LOG:-\${CATALYST_DIR}/execution-core/daemon.log}"' "$MONITOR_SH"; then
  ok "watchdog log points at the Alloy-tailed execution-core/daemon.log"
else
  fail "watchdog log is not the already-shipped daemon log"
fi

if grep -A3 'nohup bun run "\$WATCHDOG_SCRIPT"' "$MONITOR_SH" | grep -q '>> "\$WATCHDOG_LOG"'; then
  ok "watchdog log is APPENDED (shared daemon log never truncated)"
else
  fail "watchdog start truncates the shared daemon log (> instead of >>)"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]]
