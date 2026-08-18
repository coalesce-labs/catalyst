#!/usr/bin/env bash
# Tests for health-responder.sh (CTL-1509) — stateless periodic cloud-sync
# writer watchdog: bounded kickstart + one-shot escalation + re-arm.
#
# Run: bash plugins/dev/scripts/__tests__/health-responder.test.sh
#
# The suite must NEVER touch real launchd / real processes: launchctl and pgrep
# are PATH-shadowed mocks (MOCKBIN is prepended to PATH; the responder appends
# its own script dir, so mocks always win), and every kickstart is asserted via
# the KICKSTART_LOG recorder — same mock strategy as orphan-sweep.test.sh.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RESPONDER="${REPO_ROOT}/plugins/dev/scripts/health-responder.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
# The installer's ephemeral guard (CTL-1306) rejects /var/folders + /tmp roots,
# which is exactly where mktemp -d puts SCRATCH — so the installer-phase bake
# dir must live under the REAL home (same trick as install-orphan-sweep-guard).
BAKE_SCRATCH="$(mktemp -d "${HOME}/.ctl1509-hr-test.XXXXXX")"
trap 'rm -rf "$SCRATCH" "$BAKE_SCRATCH"' EXIT

export HOME="${SCRATCH}/home"
mkdir -p "$HOME"
MOCKBIN="${SCRATCH}/bin"
mkdir -p "$MOCKBIN"
export PATH="${MOCKBIN}:${PATH}"

# CTL-1968: launchctl above is a PATH-shadowed mock and HOME is a scratch dir, so
# this suite deliberately exercises the bootstrap path. The product now refuses to
# mutate gui/<uid> from a foreign HOME (a scratch HOME does NOT sandbox launchd —
# two full gates re-bound the live cloud-sync label on 2026-08-18). Declaring the
# seal is how a test opts back in; a suite that FORGOT to seal is what refuses.
export CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1
export RESPONDER_RUN_ID="testrun"

# All responder inputs live in scratch — nothing on the real host is probed.
export CATALYST_LAUNCHAGENTS_DIR="${SCRATCH}/LaunchAgents"
export CATALYST_REPLICA_DB="${SCRATCH}/replica/catalyst-replica.db"
export RESPONDER_STATE_DIR="${SCRATCH}/state"
export RESPONDER_SELFHEAL_FILE="${SCRATCH}/cloud-sync.selfheal.json"
export RESPONDER_KICKSTART_WAIT_SECS=0
mkdir -p "$CATALYST_LAUNCHAGENTS_DIR" "${SCRATCH}/replica"

PLIST="${CATALYST_LAUNCHAGENTS_DIR}/ai.coalesce.catalyst-cloud-sync.plist"
LOCK="${CATALYST_REPLICA_DB}.writer.lock"
export MOCK_LOCK_FILE="$LOCK" # launchctl mock's freshen target (T38)

# ─── harness ────────────────────────────────────────────────────────────────

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

run_fail() {
  local name="$1"; shift
  if ! "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name (expected non-zero exit)"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

expect_contains() {
  local file="$1" needle="$2"
  grep -qF "$needle" "$file"
}

expect_not_contains() {
  local file="$1" needle="$2"
  ! grep -qF "$needle" "$file"
}

# ─── mocks ──────────────────────────────────────────────────────────────────
#
# pgrep: "alive" iff MOCK_ALIVE_FILE exists — so a scenario flips liveness by
# touching/removing one file, and the kickstart mock can "revive" the writer.
export MOCK_ALIVE_FILE="${SCRATCH}/writer-alive"
export PGREP_LOG="${SCRATCH}/pgrep.log"
cat > "$MOCKBIN/pgrep" <<'EOF'
#!/usr/bin/env bash
# Records its args (T39 pins the scoped pattern) and answers liveness from
# MOCK_ALIVE_FILE regardless of pattern.
echo "$@" >> "${PGREP_LOG:-/tmp/pgrep.log}"
[[ -e "${MOCK_ALIVE_FILE:-/nonexistent}" ]] && exit 0
exit 1
EOF
chmod +x "$MOCKBIN/pgrep"

# launchctl: record every invocation; optionally "revive" the writer on
# kickstart (MOCK_KICKSTART_REVIVES=1) so the recovered path is testable.
export KICKSTART_LOG="${SCRATCH}/kickstart.log"
cat > "$MOCKBIN/launchctl" <<'EOF'
#!/usr/bin/env bash
# `list` probes (the intentional-exit gate) answer from MOCK_LAST_EXIT and are
# NOT recorded — only kickstart invocations land in KICKSTART_LOG, so
# `! test -s KICKSTART_LOG` assertions stay meaningful.
if [[ "${1:-}" == "list" ]]; then
  [[ -n "${MOCK_LAST_EXIT:-}" ]] && echo "\"LastExitStatus\" = ${MOCK_LAST_EXIT};"
  exit 0
fi
echo "$@" >> "${KICKSTART_LOG:-/tmp/kickstart.log}"
if [[ "${1:-}" == "kickstart" ]]; then
  # revive: the writer process comes back; freshen: the SDK heartbeat resumes
  # (rewrites the writer.lock) — T38 distinguishes the two.
  [[ "${MOCK_KICKSTART_REVIVES:-0}" == "1" ]] && touch "${MOCK_ALIVE_FILE:-/tmp/writer-alive}"
  [[ "${MOCK_KICKSTART_FRESHENS:-0}" == "1" && -n "${MOCK_LOCK_FILE:-}" ]] && touch "${MOCK_LOCK_FILE}"
fi
exit 0
EOF
chmod +x "$MOCKBIN/launchctl"

# otel recorder (fail-open contract asserted via presence/absence in the log)
cat > "$MOCKBIN/emit-otel-event.sh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${SCRATCH_OTEL_LOG:-/tmp/otel.log}"
exit 0
EOF
chmod +x "$MOCKBIN/emit-otel-event.sh"
export SCRATCH_OTEL_LOG="${SCRATCH}/otel.log"

# Scenario helpers: reset all mutable state between phases.
_reset() {
  rm -rf "$RESPONDER_STATE_DIR"
  rm -f "$MOCK_ALIVE_FILE" "$KICKSTART_LOG" "$SCRATCH_OTEL_LOG" "$RESPONDER_SELFHEAL_FILE" "$PLIST" "$LOCK" "$PGREP_LOG"
  unset MOCK_KICKSTART_REVIVES MOCK_KICKSTART_FRESHENS MOCK_LAST_EXIT 2>/dev/null || true
}

_fresh_lock() { touch "$LOCK"; }
_stale_lock() { touch -t 202501010000 "$LOCK"; }

# ─── Phase 1: skeleton (T1–T4) ──────────────────────────────────────────────

run "T1: script exists and is executable" test -x "$RESPONDER"

run "T2: --help exits 0 and prints usage" bash "$RESPONDER" --help
run "T2b: --help output mentions health-responder" \
  bash -c "bash '$RESPONDER' --help | grep -q 'health-responder'"

run_fail "T3: unknown flag exits non-zero" bash "$RESPONDER" --bogus-flag-xyz

# T4: bash -n clean (belt-and-suspenders; also run by CI conventions)
run "T4: bash -n clean" bash -n "$RESPONDER"

# ─── Phase 2: healthy → no action + heartbeat (T5–T7) ───────────────────────

_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _fresh_lock

run "T5: healthy run exits 0" bash "$RESPONDER"
run "T5b: healthy run emits grep-stable heartbeat" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=healthy'"
run "T5c: healthy run performs no kickstart" \
  bash -c "bash '$RESPONDER' >/dev/null && ! test -s '${KICKSTART_LOG}'"

# T6: not-on-tier (no plist, no process) → healthy no-op, never a kickstart
_reset
run "T6: no plist + no process is healthy (not our patient)" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=healthy' && ! test -s '${KICKSTART_LOG}'"

# T7: telemetry fail-open — emit binary removed, still exits 0
_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _fresh_lock
mv "$MOCKBIN/emit-otel-event.sh" "${SCRATCH}/emit-parked"
run "T7: runs clean without emit-otel-event.sh on PATH" bash "$RESPONDER"
mv "${SCRATCH}/emit-parked" "$MOCKBIN/emit-otel-event.sh"

# ─── Phase 3: dead-writer → kickstart (T8–T10) ──────────────────────────────

_reset
touch "$PLIST"   # installed, but no alive-file → dead-writer

run "T8: dead-writer run exits 0" bash "$RESPONDER"
run "T8b: kickstart hit the cloud-sync label" \
  expect_contains "$KICKSTART_LOG" "kickstart -k gui/$(id -u)/ai.coalesce.catalyst-cloud-sync"
run "T8c: heartbeat reports dead_writer=1 still-down" \
  bash -c "bash '$RESPONDER' | grep -q 'dead_writer=1'"
run "T8d: attempt marker recorded" \
  bash -c "ls '${RESPONDER_STATE_DIR}'/attempt.* >/dev/null"

# T9: recovered path — kickstart revives the writer, heartbeat says recovered
_reset
touch "$PLIST"
export MOCK_KICKSTART_REVIVES=1
run "T9: kickstart that revives reports recovered" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=recovered'"
unset MOCK_KICKSTART_REVIVES

# T10: kickstart-failed still counts (launchctl nonzero) — never crash-loops
_reset
touch "$PLIST"
cat > "$MOCKBIN/launchctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${KICKSTART_LOG:-/tmp/kickstart.log}"
exit 1
EOF
chmod +x "$MOCKBIN/launchctl"
run "T10: failed kickstart exits 0 and still records the attempt" \
  bash -c "bash '$RESPONDER' >/dev/null && ls '${RESPONDER_STATE_DIR}'/attempt.* >/dev/null"
# restore the succeeding launchctl mock
cat > "$MOCKBIN/launchctl" <<'EOF'
#!/usr/bin/env bash
# `list` probes (the intentional-exit gate) answer from MOCK_LAST_EXIT and are
# NOT recorded — only kickstart invocations land in KICKSTART_LOG, so
# `! test -s KICKSTART_LOG` assertions stay meaningful.
if [[ "${1:-}" == "list" ]]; then
  [[ -n "${MOCK_LAST_EXIT:-}" ]] && echo "\"LastExitStatus\" = ${MOCK_LAST_EXIT};"
  exit 0
fi
echo "$@" >> "${KICKSTART_LOG:-/tmp/kickstart.log}"
if [[ "${1:-}" == "kickstart" ]]; then
  # revive: the writer process comes back; freshen: the SDK heartbeat resumes
  # (rewrites the writer.lock) — T38 distinguishes the two.
  [[ "${MOCK_KICKSTART_REVIVES:-0}" == "1" ]] && touch "${MOCK_ALIVE_FILE:-/tmp/writer-alive}"
  [[ "${MOCK_KICKSTART_FRESHENS:-0}" == "1" && -n "${MOCK_LOCK_FILE:-}" ]] && touch "${MOCK_LOCK_FILE}"
fi
exit 0
EOF
chmod +x "$MOCKBIN/launchctl"

# ─── Phase 4: stale-lock → kickstart; fresh lock → not (T11–T12) ────────────

_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _stale_lock
run "T11: stale writer.lock (process alive) kickstarts" \
  bash -c "bash '$RESPONDER' | grep -q 'stale_lock=1' && test -s '${KICKSTART_LOG}'"

_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _fresh_lock
run "T12: fresh writer.lock (quiet feed) does NOT kickstart" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=healthy' && ! test -s '${KICKSTART_LOG}'"

# T12b: absent lock + alive process is NOT stale (can't tell; degrade)
_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"
run "T12b: absent writer.lock does NOT trigger stale-writer" \
  bash -c "bash '$RESPONDER' | grep -q 'stale_lock=0' && ! test -s '${KICKSTART_LOG}'"

# ─── Phase 5: CTL-1508 breadcrumb no-respawn (T13–T15) ──────────────────────

# T13: expectRestart:true + old ts + no process + agent installed → kickstart.
# (Installed-gated since the adversarial-verify fix — the plist is part of the
# legitimate scenario; the no-plist case is pinned by T30 as a no-op.)
_reset
touch "$PLIST"
OLD_TS="$(( $(date +%s) - 600 ))"
printf '{"ts":%s,"cursor":"c1","stalledMs":90000,"sdkStatus":"wedged","expectRestart":true}\n' "$OLD_TS" > "$RESPONDER_SELFHEAL_FILE"
run "T13: no-respawn breadcrumb kickstarts" \
  bash -c "bash '$RESPONDER' | grep -q 'no_respawn=1' && test -s '${KICKSTART_LOG}'"

# T14: breadcrumb within the grace window → SETTLING holds EVERYTHING back,
# including dead-writer — the writer exited on purpose expecting a launchd
# relaunch; a kickstart -k now would race/kill the legitimately-settling one.
_reset
touch "$PLIST" # installed + no process — dead-writer would fire w/o the grace
NOW_TS="$(date +%s)"
printf '{"ts":%s,"expectRestart":true}\n' "$NOW_TS" > "$RESPONDER_SELFHEAL_FILE"
run "T14: fresh breadcrumb within grace does NOT kickstart (settling)" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=settling' && ! test -s '${KICKSTART_LOG}'"
run "T14b: settling reports dead_writer=0 no_respawn=0" \
  bash -c "bash '$RESPONDER' | grep -q 'dead_writer=0 stale_lock=0 no_respawn=0'"

# T15: expectRestart:false / malformed breadcrumb → NOT a settling hold and NOT
# a no-respawn — but a dead writer is still a dead writer: the generic
# condition fires and kickstarts (the breadcrumb only ever refines, never
# suppresses, the generic response).
_reset
touch "$PLIST"
printf '{"ts":%s,"expectRestart":false}\n' "$OLD_TS" > "$RESPONDER_SELFHEAL_FILE"
run "T15: expectRestart=false breadcrumb does not suppress dead-writer" \
  bash -c "bash '$RESPONDER' | grep -q 'no_respawn=0' && test -s '${KICKSTART_LOG}'"
_reset
touch "$PLIST"
echo 'not-json{{{' > "$RESPONDER_SELFHEAL_FILE"
run "T15b: malformed breadcrumb no crash — dead-writer still handled" \
  bash -c "bash '$RESPONDER' | grep -q 'dead_writer=1' && test -s '${KICKSTART_LOG}'"

# ─── Phase 6: attempt cap → escalation (T16–T19) ────────────────────────────
#
# RESPONDER_MAX_ATTEMPTS=2: run1 kick, run2 kick, run3 = third strike →
# escalate (marker + otel + ERROR line, no further kickstarts).

_reset
touch "$PLIST"   # dead-writer persists across all runs
export RESPONDER_MAX_ATTEMPTS=2

run "T16: strike 1 kickstarts" bash "$RESPONDER"
run "T16b: strike 2 kickstarts" bash "$RESPONDER"
run "T16c: two kickstarts recorded so far" \
  bash -c "test \"\$(grep -c kickstart '${KICKSTART_LOG}')\" -eq 2"

run "T17: third strike escalates (heartbeat status=escalated)" \
  bash -c "bash '$RESPONDER' > '${SCRATCH}/esc-out' 2>&1; grep -q 'heartbeat status=escalated' '${SCRATCH}/esc-out'"
run "T17a: escalation logged an ERROR-severity line for Alloy/Loki" \
  expect_contains "${SCRATCH}/esc-out" "ERROR: escalated"
run "T17b: ESCALATED one-shot marker written" \
  test -f "${RESPONDER_STATE_DIR}/ESCALATED.cloud-sync"
run "T17c: escalation emitted catalyst.responder.escalated (fail-open otel)" \
  expect_contains "$SCRATCH_OTEL_LOG" "catalyst.responder.escalated"
run "T17d: no third kickstart happened" \
  bash -c "test \"\$(grep -c kickstart '${KICKSTART_LOG}')\" -eq 2"

# T18: escalated + condition persists → hold, no re-emit, no kickstart
run "T18: escalated hold — no further kickstart" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=escalated' && test \"\$(grep -c kickstart '${KICKSTART_LOG}')\" -eq 2"
run "T18b: escalation otel emitted exactly once (one-shot guard)" \
  bash -c "test \"\$(grep -c 'catalyst.responder.escalated' '${SCRATCH_OTEL_LOG}')\" -eq 1"

# ─── Phase 7: condition clears → re-arm (T19) ───────────────────────────────

touch "$MOCK_ALIVE_FILE"; _fresh_lock   # writer is back
run "T19: cleared condition prunes markers and re-arms" \
  bash -c "bash '$RESPONDER' | grep -q 're-armed'"
run "T19b: ESCALATED marker removed" \
  bash -c "! test -f '${RESPONDER_STATE_DIR}/ESCALATED.cloud-sync'"
run "T19c: attempt markers removed" \
  bash -c "! ls '${RESPONDER_STATE_DIR}'/attempt.* >/dev/null 2>&1"
run "T19d: next healthy run is a plain healthy heartbeat" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=healthy'"
unset RESPONDER_MAX_ATTEMPTS

# ─── Phase 8: window pruning (T20) ──────────────────────────────────────────

_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _fresh_lock
mkdir -p "$RESPONDER_STATE_DIR"
: > "${RESPONDER_STATE_DIR}/attempt.1000000000.99"   # ancient epoch, way past window
run "T20: attempt markers older than the window are pruned" \
  bash -c "bash '$RESPONDER' >/dev/null && ! test -e '${RESPONDER_STATE_DIR}/attempt.1000000000.99'"

# ─── Phase 9: kill-switch + dry-run (T21–T22) ───────────────────────────────

_reset
touch "$PLIST"   # dead-writer condition present
run "T21: RESPONDER_ENABLED=0 takes no action" \
  bash -c "RESPONDER_ENABLED=0 bash '$RESPONDER' | grep -q 'heartbeat status=disabled' && ! test -s '${KICKSTART_LOG}'"

_reset
touch "$PLIST"
run "T22: --dry-run logs would-kickstart, touches nothing" \
  bash -c "bash '$RESPONDER' --dry-run | grep -q 'would kickstart' && ! test -s '${KICKSTART_LOG}'"
run "T22b: --dry-run records no attempt markers" \
  bash -c "! ls '${RESPONDER_STATE_DIR}'/attempt.* >/dev/null 2>&1"
run "T22c: --dry-run still heartbeats" \
  bash -c "bash '$RESPONDER' --dry-run | grep -q 'heartbeat status=dry-run'"

# ─── Phase 10: heartbeat-on-every-path (T23) ────────────────────────────────
#
# Stale-copy-reports-healthy rule: EVERY exit path emits the heartbeat token.

_reset
run "T23a: heartbeat on healthy path" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status='"
_reset; touch "$PLIST"
run "T23b: heartbeat on acting path" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status='"
run "T23c: heartbeat on disabled path" \
  bash -c "RESPONDER_ENABLED=0 bash '$RESPONDER' | grep -q 'heartbeat status='"

# ─── Phase 11: installer (T24–T27) ──────────────────────────────────────────

INSTALLER="${REPO_ROOT}/plugins/dev/scripts/install-health-responder.sh"

run "T24: installer exists and is executable" test -x "$INSTALLER"
run "T24b: installer --help exits 0" bash "$INSTALLER" --help
run "T24c: installer bash -n clean" bash -n "$INSTALLER"

# T25: --print-only substitutes tokens. The bake dir must be NON-ephemeral
# (guard fires even for --print-only), so it lives under the real home
# (BAKE_SCRATCH) — SCRATCH itself is under /var/folders and would be refused.
BAKE="${BAKE_SCRATCH}/pristine/scripts"
mkdir -p "${BAKE}/orch-monitor/dist"
cp "${REPO_ROOT}/plugins/dev/scripts/orch-monitor/dist/ai.coalesce.catalyst-health-responder.plist" \
   "${BAKE}/orch-monitor/dist/"
touch "${BAKE}/health-responder.sh"
run "T25: --print-only emits a fully-substituted plist" \
  bash -c "CATALYST_FORCE_BAKE_DIR='${BAKE}' bash '$INSTALLER' --print-only | grep -q '${BAKE}/health-responder.sh'"
run "T25b: no REPLACE_ tokens survive substitution" \
  bash -c "CATALYST_FORCE_BAKE_DIR='${BAKE}' bash '$INSTALLER' --print-only | { ! grep -q 'REPLACE_'; }"
run "T25c: default interval is 180 (no config on the walk-up path)" \
  bash -c "cd / && CATALYST_FORCE_BAKE_DIR='${BAKE}' bash '$INSTALLER' --print-only | grep -q '<integer>180</integer>'"

# T26: interval clamp — config-driven value out of range clamps to 60–900
CFGROOT="${SCRATCH}/cfgproj"
mkdir -p "${CFGROOT}/.catalyst"
echo '{"catalyst":{"responder":{"intervalSeconds":5}}}' > "${CFGROOT}/.catalyst/config.json"
run "T26: intervalSeconds=5 clamps to 60" \
  bash -c "cd '${CFGROOT}' && CATALYST_FORCE_BAKE_DIR='${BAKE}' bash '$INSTALLER' --print-only | grep -q '<integer>60</integer>'"
echo '{"catalyst":{"responder":{"intervalSeconds":10000}}}' > "${CFGROOT}/.catalyst/config.json"
run "T26b: intervalSeconds=10000 clamps to 900" \
  bash -c "cd '${CFGROOT}' && CATALYST_FORCE_BAKE_DIR='${BAKE}' bash '$INSTALLER' --print-only | grep -q '<integer>900</integer>'"
echo '{"catalyst":{"responder":{"intervalSeconds":300}}}' > "${CFGROOT}/.catalyst/config.json"
run "T26c: in-range intervalSeconds passes through" \
  bash -c "cd '${CFGROOT}' && CATALYST_FORCE_BAKE_DIR='${BAKE}' bash '$INSTALLER' --print-only | grep -q '<integer>300</integer>'"

# T27: ephemeral-path hard refusal — a /tmp-shaped bake dir must be rejected
# even for --print-only (the CTL-1306 rule; full matrix lives in
# install-orphan-sweep-guard.test.sh and applies identically here).
run_fail "T27: refuses to bake a /tmp path" \
  bash -c "CATALYST_FORCE_BAKE_DIR='/tmp/fake-scripts' CATALYST_LAYER2_CONFIG_FILE=/dev/null bash '$INSTALLER' --print-only"
run_fail "T27a: refuses a /var/folders temp path" \
  bash -c "CATALYST_FORCE_BAKE_DIR='${SCRATCH}/pristine/scripts' CATALYST_LAYER2_CONFIG_FILE=/dev/null bash '$INSTALLER' --print-only"

# T27b: non-Darwin exits 0 without touching launchctl
rm -f "$KICKSTART_LOG"
run "T27b: non-Darwin early-exits 0" \
  bash -c "CATALYST_FORCE_OS=Linux bash '$INSTALLER' && ! test -s '${KICKSTART_LOG}'"

# T27c: --uninstall is safe when not installed (and never needs a bake dir)
run "T27c: --uninstall from anywhere exits 0" \
  bash -c "cd /tmp && bash '$INSTALLER' --uninstall"

# ─── Phase 9: adversarial-verify caveat fixes (T28–T30) ─────────────────────

# T28: FAIL-SAFE cap — an unwritable state dir must refuse to kickstart
# entirely. If the attempt cannot be counted, the cap cannot bound us, and an
# unwritable dir would otherwise degrade into unbounded interval-paced
# kickstarts — the exact storm the cap exists to prevent.
_reset
touch "$PLIST" # installed, no alive-file → dead-writer condition
touch "${SCRATCH}/state-blocker" # a FILE where the state dir's parent should be
run "T28: unwritable state dir refuses to kickstart (fail-safe)" \
  bash -c "RESPONDER_STATE_DIR='${SCRATCH}/state-blocker/state' bash '$RESPONDER' | grep -q 'refusing to kickstart' && ! test -s '${KICKSTART_LOG}'"
run "T28b: degraded heartbeat still emitted (never silent)" \
  bash -c "RESPONDER_STATE_DIR='${SCRATCH}/state-blocker/state' bash '$RESPONDER' | grep -q 'heartbeat status=degraded'"
rm -f "${SCRATCH}/state-blocker"

# T29: --dry-run is READ-ONLY — the healthy-path re-arm must not clear markers,
# prune must not delete expired ones, and the state dir must not be created.
_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _fresh_lock
mkdir -p "$RESPONDER_STATE_DIR"
touch "${RESPONDER_STATE_DIR}/attempt.1.999" # ancient — a real run would prune it
run "T29: dry-run healthy run reports but preserves attempt markers" \
  bash -c "bash '$RESPONDER' --dry-run | grep -q 'would re-arm' && test -e '${RESPONDER_STATE_DIR}/attempt.1.999'"
run "T29b: real healthy run removes them (prune or re-arm)" \
  bash -c "bash '$RESPONDER' >/dev/null && ! ls '${RESPONDER_STATE_DIR}'/attempt.* 2>/dev/null"
_reset
run "T29c: dry-run never creates the state dir" \
  bash -c "bash '$RESPONDER' --dry-run >/dev/null && ! test -d '${RESPONDER_STATE_DIR}'"

# T30: no-respawn is installed-gated — a stale CTL-1508 breadcrumb on a node
# whose cloud-sync agent was uninstalled must not kickstart or escalate.
_reset
printf '{"ts":1,"expectRestart":true}' > "$RESPONDER_SELFHEAL_FILE" # ancient breadcrumb
run "T30: breadcrumb without the plist is healthy (not our patient)" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=healthy' && ! test -s '${KICKSTART_LOG}'"
run "T30b: heartbeat reports no_respawn=0 without the plist" \
  bash -c "bash '$RESPONDER' | grep -q 'no_respawn=0'"

# ─── Phase 10: Codex-review remediations (T31–T39) ──────────────────────────

# T31 (P1): settling must NOT re-arm the attempt budget — a crash-looping
# writer that keeps dropping fresh breadcrumbs would otherwise refill its own
# hourly cap every loop and never escalate.
_reset
touch "$PLIST" # installed, no process
printf '{"ts":%s,"expectRestart":true}\n' "$(date +%s)" > "$RESPONDER_SELFHEAL_FILE"
mkdir -p "$RESPONDER_STATE_DIR"
touch "${RESPONDER_STATE_DIR}/attempt.$(date +%s).777"
run "T31: settling preserves the attempt budget (no re-arm)" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=settling' && ls '${RESPONDER_STATE_DIR}'/attempt.* >/dev/null"

# T32 (P2): stale-writer is installed-gated — orphaned matching process + old
# lock on a node without the plist must not kickstart an unloaded label.
_reset
touch "$MOCK_ALIVE_FILE"; _stale_lock # NO plist
run "T32: stale lock without the plist is healthy (not our patient)" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=healthy' && ! test -s '${KICKSTART_LOG}'"

# T33 (P2): a zero/garbage attempt window is clamped — markers survive pruning
# and the cap still escalates instead of kickstarting every sweep forever.
_reset
touch "$PLIST" # dead-writer
mkdir -p "$RESPONDER_STATE_DIR"
for i in 1 2 3; do touch "${RESPONDER_STATE_DIR}/attempt.$(date +%s).$i"; done
run "T33: window=0 clamps — cap still escalates (no kickstart)" \
  bash -c "RESPONDER_ATTEMPT_WINDOW_SECS=0 bash '$RESPONDER' | grep -q 'ERROR: escalated' && ! test -s '${KICKSTART_LOG}'"

# T34 (P1): a HUNG launchctl is bounded — the sweep must finish, count the
# attempt, and heartbeat rather than becoming a wedged watcher itself.
_reset
touch "$PLIST" # dead-writer
mv "$MOCKBIN/launchctl" "${SCRATCH}/launchctl-real-mock"
cat > "$MOCKBIN/launchctl" <<'EOF'
#!/usr/bin/env bash
# Hang ONLY on kickstart — the intentional-exit gate's `list` probe must
# answer instantly or the test measures the wrong call.
[[ "${1:-}" == "list" ]] && exit 0
sleep 60
EOF
chmod +x "$MOCKBIN/launchctl"
run "T34: hung kickstart times out, sweep completes with heartbeat" \
  bash -c "RESPONDER_KICKSTART_TIMEOUT_SECS=1 RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' | grep -q 'kickstart TIMED OUT' "
run "T34b: the timed-out attempt still counted" \
  bash -c "ls '${RESPONDER_STATE_DIR}'/attempt.* >/dev/null"
mv "${SCRATCH}/launchctl-real-mock" "$MOCKBIN/launchctl"

# T35 (P2): GNU-stat semantics (`-f %m` prints junk AND fails) must not poison
# the `-c` fallback — stale-lock detection still works.
_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"
cat > "$MOCKBIN/stat" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == "-f" ]]; then
  echo "  File: \\"whatever\\" — GNU fs info spam"
  exit 1
fi
# -c %Y fallback: an epoch 2000s in the past → stale (> 900s threshold)
echo \$(( \$(date +%s) - 2000 ))
EOF
chmod +x "$MOCKBIN/stat"
run "T35: GNU stat fallback stays clean — stale lock still detected" \
  bash -c "bash '$RESPONDER' | grep -q 'stale_lock=1' && test -s '${KICKSTART_LOG}'"
rm -f "$MOCKBIN/stat"

# T36 (P2): unknown installer flags are rejected before any lifecycle action.
run_fail "T36: installer rejects a typo'd flag (--uninstalll)" \
  bash "$INSTALLER" --uninstalll
run_fail "T36b: installer rejects --print-onl" \
  bash "$INSTALLER" --print-onl

# T37 (P2): --print-only works on non-Darwin (plist preview needs no launchctl).
run "T37: non-Darwin --print-only renders the plist" \
  bash -c "cd / && CATALYST_FORCE_OS=Linux CATALYST_FORCE_BAKE_DIR='${BAKE}' bash '$INSTALLER' --print-only | grep -q '<integer>180</integer>'"

# T38 (P2): "recovered" after a stale-writer incident requires the SDK
# heartbeat to RESUME, not merely a matching process (which was alive all along).
_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _stale_lock
run "T38: stale incident + lock still stale => still-down, not recovered" \
  bash -c "RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' | grep -q 'heartbeat status=still-down'"
_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _stale_lock
export MOCK_KICKSTART_FRESHENS=1
run "T38b: kickstart that freshens the lock => recovered" \
  bash -c "RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' | grep -q 'heartbeat status=recovered'"
unset MOCK_KICKSTART_FRESHENS

# T39 (P2): the liveness probe is scoped — launchd-shaped invocation, this uid.
_reset
touch "$PLIST"
run "T39: pgrep pattern is the scoped launchd shape, uid-constrained" \
  bash -c "bash '$RESPONDER' >/dev/null; grep -q -- '-U .* bun .*execution-core/cloud-sync' '${PGREP_LOG}'"

# ─── Phase 11: Codex round-2 remediations (T40–T42) ─────────────────────────

# T40 (P1): in cmd_adopt_cloud_sync the responder must install BEFORE the
# tokenless early-return — a dev/monitor node adopted without its token gets
# the writer now and the token later, and that writer needs its recovery layer.
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"
run "T40: adopt-cloud-sync installs the responder before the tokenless return" \
  bash -c "a=\$(awk '/^cmd_adopt_cloud_sync\(\) \{/,/^\}/' '$STACK' | grep -n 'install-health-responder.sh' | head -1 | cut -d: -f1); b=\$(awk '/^cmd_adopt_cloud_sync\(\) \{/,/^\}/' '$STACK' | grep -n 'awaiting token' | head -1 | cut -d: -f1); [ -n \"\$a\" ] && [ -n \"\$b\" ] && [ \"\$a\" -lt \"\$b\" ]"

# T41 (P2): CATALYST_PLUGIN_DIRS precedence is actually honored — the resolver
# populates RESOLVED_PLUGIN_DIRS (no stdout), so a subshell capture would
# silently ignore it and fall back to SCRIPT_DIR.
FAKE_PD="${BAKE_SCRATCH}/fake-plugins-dev"
mkdir -p "${FAKE_PD}/scripts/orch-monitor/dist"
cp "$RESPONDER" "${FAKE_PD}/scripts/health-responder.sh"
cp "${REPO_ROOT}/plugins/dev/scripts/orch-monitor/dist/ai.coalesce.catalyst-health-responder.plist" \
   "${FAKE_PD}/scripts/orch-monitor/dist/"
run "T41: CATALYST_PLUGIN_DIRS env checkout is baked (resolver variable read)" \
  bash -c "cd / && CATALYST_PLUGIN_DIRS='${FAKE_PD}' bash '$INSTALLER' --print-only | grep -q '${FAKE_PD}/scripts/health-responder.sh'"

# T42 (P2): garbage/negative detection thresholds must not crash the sweep
# (set -u unbound-variable in arithmetic) nor stale-classify a fresh lock.
_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _fresh_lock
run "T42: RESPONDER_LOCK_STALE_SECS=abc still heartbeats healthy (no crash)" \
  bash -c "RESPONDER_LOCK_STALE_SECS=abc RESPONDER_SELFHEAL_GRACE_SECS=xyz bash '$RESPONDER' | grep -q 'heartbeat status=healthy'"
run "T42b: negative lock threshold clamps — fresh lock is NOT stale" \
  bash -c "RESPONDER_LOCK_STALE_SECS=-5 bash '$RESPONDER' | grep -q 'stale_lock=0' && ! test -s '${KICKSTART_LOG}'"

# ─── Phase 12: Codex round-3 remediations (T43–T46) ─────────────────────────

# T43 (P1): a tokenless writer idles by DESIGN (exit 0) — the responder must
# not kickstart it into a false escalation, nor fight a manual SIGTERM stop.
_reset
touch "$PLIST" # installed, no process
export MOCK_LAST_EXIT=0
run "T43: last-exit-0 idle writer is not a fault (no kickstart)" \
  bash -c "bash '$RESPONDER' | grep -q 'idle by design' && ! test -s '${KICKSTART_LOG}'"
run "T43b: last-exit-0 suppresses no-respawn from a leftover breadcrumb too" \
  bash -c "printf '{\"ts\":1,\"expectRestart\":true}' > '$RESPONDER_SELFHEAL_FILE'; bash '$RESPONDER' | grep -q 'no_respawn=0' && ! test -s '${KICKSTART_LOG}'"
export MOCK_LAST_EXIT=1
run "T43c: nonzero last exit is a genuine dead-writer (kickstarts)" \
  bash -c "rm -f '$RESPONDER_SELFHEAL_FILE'; bash '$RESPONDER' | grep -q 'dead_writer=1' && test -s '${KICKSTART_LOG}'"
unset MOCK_LAST_EXIT

# T44 (P2): a failed marker cleanup must not report "re-armed" — the durable
# ESCALATED marker survived, so degrade loudly and keep the escalated state.
# Root ignores directory permissions (Codex round 4 reproduced the failure in
# a root container), so skip there — the perm mechanism cannot bind root.
if [[ "$(id -u)" -ne 0 ]]; then
  _reset
  touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _fresh_lock # healthy probe
  mkdir -p "$RESPONDER_STATE_DIR"
  touch "${RESPONDER_STATE_DIR}/ESCALATED.cloud-sync"
  chmod 500 "$RESPONDER_STATE_DIR"
  run "T44: unremovable markers => degraded, never a false re-arm" \
    bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=degraded' && test -e '${RESPONDER_STATE_DIR}/ESCALATED.cloud-sync'"
  chmod 700 "$RESPONDER_STATE_DIR"
else
  echo "  SKIP: T44 (running as root — chmod cannot make markers unremovable)"
fi

# T45 (P1): CATALYST_DIR override resolves the lock/breadcrumb/state paths the
# same way the writer's catalystDir() does — no $HOME/catalyst hardcode.
_reset
ALT_DIR="${SCRATCH}/altcat"
mkdir -p "$ALT_DIR"
touch -t 202501010000 "${ALT_DIR}/catalyst-replica.db.writer.lock" # stale
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"
run "T45: CATALYST_DIR-resolved stale lock is detected (kickstart)" \
  bash -c "env -u CATALYST_REPLICA_DB -u RESPONDER_SELFHEAL_FILE -u RESPONDER_STATE_DIR CATALYST_DIR='${ALT_DIR}' RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' | grep -q 'stale_lock=1' && test -s '${KICKSTART_LOG}'"

# T46 (P1): zero-padded overrides must not silently octal-break the cap.
_reset
touch "$PLIST" # dead-writer
mkdir -p "$RESPONDER_STATE_DIR"
for i in 1 2 3 4 5 6 7 8; do touch "${RESPONDER_STATE_DIR}/attempt.$(date +%s).$i"; done
run "T46: RESPONDER_MAX_ATTEMPTS=08 is base-10 — cap still escalates" \
  bash -c "RESPONDER_MAX_ATTEMPTS=08 bash '$RESPONDER' | grep -q 'ERROR: escalated' && ! test -s '${KICKSTART_LOG}'"

# T46b (round 4): the zero-padded value must be HONORED as base-10, not
# silently replaced by the default — normalization must precede the range
# check. With MAX=09 and only 3 attempts recorded, the cap is NOT exhausted
# (3 < 9 → kickstart); a fall-to-default-3 would have escalated instead.
_reset
touch "$PLIST"
mkdir -p "$RESPONDER_STATE_DIR"
for i in 1 2 3; do touch "${RESPONDER_STATE_DIR}/attempt.$(date +%s).$i"; done
run "T46b: zero-padded MAX_ATTEMPTS=09 is honored (kickstart, not escalate)" \
  bash -c "RESPONDER_MAX_ATTEMPTS=09 RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' | grep -qv 'ERROR: escalated' && test -s '${KICKSTART_LOG}'"

# T47 (round 4): a HUNG `launchctl list` probe is bounded too — the sweep
# still heartbeats and (treating the writer as dead) still recovers.
_reset
touch "$PLIST" # dead-writer shape
mv "$MOCKBIN/launchctl" "${SCRATCH}/launchctl-real-mock2"
cat > "$MOCKBIN/launchctl" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "list" ]] && sleep 60
echo "$@" >> "${KICKSTART_LOG:-/tmp/kickstart.log}"
exit 0
EOF
chmod +x "$MOCKBIN/launchctl"
# Capture-then-grep (NOT `| grep -q`): the WARN is the sweep's FIRST output
# line, so a short-circuiting grep -q would close the pipe and SIGPIPE-kill
# the responder before it reaches the kickstart this test asserts.
run "T47: hung launchctl list times out — sweep proceeds to kickstart" \
  bash -c "out=\$(RESPONDER_LIST_TIMEOUT_SECS=1 RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' 2>&1); printf '%s' \"\$out\" | grep -q 'launchctl list timed out' && test -s '${KICKSTART_LOG}'"
mv "${SCRATCH}/launchctl-real-mock2" "$MOCKBIN/launchctl"

# T48 (round 5): a FUTURE breadcrumb timestamp must not hold a dead writer in
# settling forever — it is invalid, and dead-writer recovery proceeds.
_reset
touch "$PLIST" # dead-writer shape
FUTURE_TS=$(( $(date +%s) + 999999 ))
printf '{"ts":%s,"expectRestart":true}\n' "$FUTURE_TS" > "$RESPONDER_SELFHEAL_FILE"
run "T48: future-timestamp breadcrumb is invalid — dead-writer still recovers" \
  bash -c "RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' | grep -q 'dead_writer=1' && test -s '${KICKSTART_LOG}'"

# ─── Phase 12: CTL-1510 hardening (T49–T56) ─────────────────────────────────

# T49 (item 0): exit-0 + token file PRESENT is the failed-bounce signature —
# recovery applies (the live mini-2 incident: bootout SIGTERM → exit 0 →
# bootstrap never stuck; the old gate held the writer down forever).
_reset
touch "$PLIST"
export MOCK_LAST_EXIT=0
mkdir -p "${HOME}/.config/catalyst"
# Codex P1 round 3: a token FILE existing is not the same as a token being
# PROVISIONED — an adopted-but-not-yet-provisioned node's cloud-sync.env can
# be present and readable while empty (or set an unrelated var), and that
# must stay idle-by-design, never kickstart. Only a file that actually sets
# the resolved token variable (CATALYST_CLOUD_TOKEN with no Layer-2 config in
# this scratch HOME — bun/config.mjs are real, not mocked, here) counts.
printf 'export SOME_UNRELATED_VAR=1\n' > "${HOME}/.config/catalyst/cloud-sync.env"
run "T49: an EMPTY/irrelevant token file stays idle-by-design (no kickstart)" \
  bash -c "bash '$RESPONDER' | grep -q 'idle by design' && ! test -s '${KICKSTART_LOG}'"
printf 'export CATALYST_CLOUD_TOKEN=test-token-value\n' > "${HOME}/.config/catalyst/cloud-sync.env"
run "T49x: a REAL provisioned token is treated as a failed bounce (kickstarts)" \
  bash -c "out=\$(RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER'); printf '%s' \"\$out\" | grep -q 'failed-bounce signature' && printf '%s' \"\$out\" | grep -q 'dead_writer=1' && test -s '${KICKSTART_LOG}'"
rm -f "${HOME}/.config/catalyst/cloud-sync.env"
rm -f "$KICKSTART_LOG"
run "T49b: no token file at all stays idle-by-design (no kickstart)" \
  bash -c "bash '$RESPONDER' | grep -q 'idle by design' && ! test -s '${KICKSTART_LOG}'"
# Codex P1: the launcher sources cluster.env TOO (CTL-1307 shared-token
# projection) — a REAL token provisioned only there must equally defeat the
# gate (an empty cluster.env must NOT).
printf 'export CATALYST_CLOUD_TOKEN=test-token-value\n' > "${HOME}/.config/catalyst/cluster.env"
run "T49c: a real token via cluster.env alone also defeats the exit-0 gate" \
  bash -c "RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' | grep -q 'failed-bounce signature' && test -s '${KICKSTART_LOG}'"
rm -f "${HOME}/.config/catalyst/cluster.env" "$KICKSTART_LOG"
unset MOCK_LAST_EXIT

# T50 (item 5): whole-sweep reservation — a held lock skips the run (visible
# heartbeat, no probe/act), a stale lock is broken, and a finished sweep
# releases its lock.
_reset
touch "$PLIST" # dead-writer shape: without the lock skip, this WOULD kickstart
mkdir -p "${RESPONDER_STATE_DIR}/sweep.lock"
run "T50: contended sweep lock skips the run (heartbeat, no kickstart, foreign lock preserved)" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=skipped' && ! test -s '${KICKSTART_LOG}' && test -d '${RESPONDER_STATE_DIR}/sweep.lock'"
run "T50b: a stale sweep lock is broken and the sweep proceeds" \
  bash -c "touch -t 202501010000 '${RESPONDER_STATE_DIR}/sweep.lock'; out=\$(RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER'); printf '%s' \"\$out\" | grep -q 'broke stale sweep lock' && test -s '${KICKSTART_LOG}'"
run "T50c: the lock is released when the sweep exits" \
  bash -c "! test -d '${RESPONDER_STATE_DIR}/sweep.lock'"
_reset
run "T50d: dry-run never creates the sweep lock (read-only contract)" \
  bash -c "bash '$RESPONDER' --dry-run >/dev/null && ! test -e '${RESPONDER_STATE_DIR}/sweep.lock'"

# T50e (Codex P2 round 2): the stale-lock CLAIM must be atomic — only ONE of
# two sweeps racing the SAME stale lock may successfully rename it aside
# (health-responder.sh's _claim_stale_lock). A racing pair calling `mv
# "$SWEEP_LOCK_DIR" <distinct-tmp>` on the SAME source: the first succeeds and
# the source is now gone, so the second's `mv` of that same (now-nonexistent)
# source path MUST fail — it can never reach the unconditional `rm -rf` that
# used to delete a concurrently-reacquired fresh lock out from under its owner.
_reset
mkdir -p "${RESPONDER_STATE_DIR}/sweep.lock"
run "T50e: only the first of two racing claims on the same stale lock succeeds" \
  bash -c "mv '${RESPONDER_STATE_DIR}/sweep.lock' '${RESPONDER_STATE_DIR}/sweep.lock.stale.first' 2>/dev/null && ! mv '${RESPONDER_STATE_DIR}/sweep.lock' '${RESPONDER_STATE_DIR}/sweep.lock.stale.second' 2>/dev/null"
rm -rf "${RESPONDER_STATE_DIR}/sweep.lock.stale.first"

# T50f (Codex P2 round 3): claim-then-verify — a lock that is FRESH when
# claimed (not actually stale; models the instance-swap window where a
# different contender already broke+recreated it between another sweep's
# check and act) must be PUT BACK, not destroyed. Every "found a directory at
# SWEEP_LOCK_DIR" path now goes through the same claim-then-verify, so a
# fresh lock exercises the exact protection the instance-swap bug needed.
_reset
touch "$PLIST" # dead-writer shape: without protection, this WOULD kickstart
mkdir -p "${RESPONDER_STATE_DIR}/sweep.lock" # freshly created — NOT stale
echo -n "someone-elses-token" > "${RESPONDER_STATE_DIR}/sweep.lock/owner"
run "T50f: a fresh (non-stale) lock is put back intact, never destroyed" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=skipped' && ! test -s '${KICKSTART_LOG}' && [ \"\$(cat '${RESPONDER_STATE_DIR}/sweep.lock/owner')\" = 'someone-elses-token' ]"
rm -rf "${RESPONDER_STATE_DIR}/sweep.lock"

# T51 (item 4): unprunable expired markers degrade EXPLICITLY — and a cap
# built on that unreliable count refuses to escalate. Root ignores directory
# permissions (same T44 reasoning, Codex P2 round 2: reproduced failing in a
# root container) — chmod 555 cannot make markers unremovable for root, so
# skip there; the permission mechanism cannot bind root.
if [[ "$(id -u)" -ne 0 ]]; then
  _reset
  touch "$PLIST" # dead-writer condition
  mkdir -p "$RESPONDER_STATE_DIR"
  for i in 1 2 3; do : > "${RESPONDER_STATE_DIR}/attempt.100000000${i}.t"; done # expired (year 2001)
  chmod 555 "$RESPONDER_STATE_DIR"
  run "T51: unprunable expired markers log the over-count ERROR" \
    bash -c "bash '$RESPONDER' | grep -q 'could not be pruned'"
  run "T51b: cap-on-unreliable-count refuses to escalate (degraded, no kickstart)" \
    bash -c "out=\$(bash '$RESPONDER'); printf '%s' \"\$out\" | grep -q 'refusing to escalate on unreliable state' && printf '%s' \"\$out\" | grep -q 'heartbeat status=degraded' && ! test -s '${KICKSTART_LOG}'"
  chmod 755 "$RESPONDER_STATE_DIR"
else
  echo "  SKIP: T51 (running as root — chmod cannot make markers unremovable)"
  echo "  SKIP: T51b (running as root — chmod cannot make markers unremovable)"
fi

# T52 (item 3): a bake path containing '&' must survive substitution — XML-
# escaped in the plist (sed's whole-match metacharacter would otherwise mangle
# the program path into a silent exit-127 loop).
BAKE_AMP="${BAKE_SCRATCH}/amp & dir/scripts"
mkdir -p "${BAKE_AMP}/orch-monitor/dist"
cp "${REPO_ROOT}/plugins/dev/scripts/orch-monitor/dist/ai.coalesce.catalyst-health-responder.plist" \
   "${BAKE_AMP}/orch-monitor/dist/"
touch "${BAKE_AMP}/health-responder.sh"
run "T52: '&' in the bake path is XML-escaped, not sed-mangled" \
  bash -c "CATALYST_FORCE_BAKE_DIR='${BAKE_AMP}' bash '$INSTALLER' --print-only | grep -qF 'amp &amp; dir/scripts/health-responder.sh'"
run "T52b: orphan-sweep installer carries the same escaping helper (parity)" \
  bash -c "grep -q '_escape_repl' '${REPO_ROOT}/plugins/dev/scripts/install-orphan-sweep.sh'"
# Codex P1: the plist/cron runtime is /bin/bash 3.2 on macOS, where the old
# parameter-expansion escaping dropped its backslash. Pin the fix by running
# the SAME substitution under /bin/bash (3.2 on Darwin; still valid elsewhere).
run "T52c: escaping survives /bin/bash 3.2 semantics" \
  bash -c "CATALYST_FORCE_BAKE_DIR='${BAKE_AMP}' /bin/bash '$INSTALLER' --print-only | grep -qF 'amp &amp; dir/scripts/health-responder.sh'"

# T53 (item 6): the cron backstop — installed tagged + idempotent, preserves
# foreign lines, removed on uninstall. crontab is a PATH-shadowed mock; the
# install path is forced to Darwin so it runs anywhere (launchctl is mocked).
export MOCK_CRONTAB_FILE="${SCRATCH}/crontab.mock"
cat > "$MOCKBIN/crontab" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -l) [[ -f "${MOCK_CRONTAB_FILE:-/nonexistent}" ]] && cat "$MOCK_CRONTAB_FILE"; exit 0 ;;
  -r) rm -f "${MOCK_CRONTAB_FILE:-/nonexistent}"; exit 0 ;;
  *)  cat > "${MOCK_CRONTAB_FILE:-/tmp/crontab.mock}"; exit 0 ;;
esac
EOF
chmod +x "$MOCKBIN/crontab"
CRON_INSTALL="CATALYST_FORCE_OS=Darwin CATALYST_FORCE_BAKE_DIR='${BAKE}' bash '$INSTALLER'"
run "T53: install writes the tagged cron backstop line" \
  bash -c "rm -f '$MOCK_CRONTAB_FILE'; eval $CRON_INSTALL >/dev/null && grep -q 'health-responder backstop CTL-1510' '$MOCK_CRONTAB_FILE' && grep -q '^\*/3 ' '$MOCK_CRONTAB_FILE'"
run "T53b: reinstall is idempotent (exactly one tagged line)" \
  bash -c "eval $CRON_INSTALL >/dev/null && [ \"\$(grep -c 'CTL-1510' '$MOCK_CRONTAB_FILE')\" -eq 1 ]"
run "T53c: foreign crontab lines survive install" \
  bash -c "printf '%s\n' '30 4 * * * /usr/bin/true keepme' > '$MOCK_CRONTAB_FILE'; eval $CRON_INSTALL >/dev/null && grep -q keepme '$MOCK_CRONTAB_FILE' && grep -q 'CTL-1510' '$MOCK_CRONTAB_FILE'"
run "T53d: uninstall removes the tagged line and keeps foreign lines" \
  bash -c "bash '$INSTALLER' --uninstall >/dev/null && grep -q keepme '$MOCK_CRONTAB_FILE' && ! grep -q 'CTL-1510' '$MOCK_CRONTAB_FILE'"
# Codex P2: cron's /bin/sh re-expands $ ` \ inside double quotes — the command
# paths must be single-quoted. Assert the written line single-quotes the
# responder path and the PATH env value.
run "T53e: cron command paths are single-quoted (no sh re-expansion)" \
  bash -c "rm -f '$MOCK_CRONTAB_FILE'; eval $CRON_INSTALL >/dev/null && grep -qF \"/bin/bash '${BAKE}/health-responder.sh'\" '$MOCK_CRONTAB_FILE' && grep -q \"PATH='\" '$MOCK_CRONTAB_FILE'"

# T54 (item 1): the WRITER's plist persists CATALYST_DIR like the responder's
# does — text-level structural check on the render function (same idiom as T40).
run "T54: render_cloud_sync_plist persists CATALYST_DIR" \
  bash -c "awk '/^render_cloud_sync_plist\(\) \{/,/^\}/' '$STACK' | grep -q '<key>CATALYST_DIR</key>'"

# T55 (item 7): the log-shipper launcher pre-creates every tailed log file —
# Alloy's static file targets never discover a file created after start, so a
# missing-at-start log means a permanently dark stream (the mini-2 incident).
LAUNCH="${REPO_ROOT}/plugins/dev/scripts/log-shipper/launch.sh"
cat > "$MOCKBIN/alloy" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCKBIN/alloy"
ALLOY_DIR="${SCRATCH}/alloy-home"
run "T55: launch.sh touches all tailed logs before exec'ing alloy" \
  bash -c "CATALYST_DIR='${ALLOY_DIR}' bash '$LAUNCH' --storage '${ALLOY_DIR}/storage' >/dev/null 2>&1; test -f '${ALLOY_DIR}/health-responder.log' && test -f '${ALLOY_DIR}/cloud-sync.log' && test -f '${ALLOY_DIR}/execution-core/daemon.log' && test -f '${ALLOY_DIR}/broker.log' && test -f '${ALLOY_DIR}/monitor.log' && test -f '${ALLOY_DIR}/updater.log' && test -f '${ALLOY_DIR}/otel-forward.log'"

# T56: sweep-lock + cron-backstop composition — two back-to-back sweeps (the
# launchd+cron overlap this design accepts) never double-kickstart within one
# reservation: the second run during a held lock skips.
_reset
touch "$PLIST"
mkdir -p "${RESPONDER_STATE_DIR}/sweep.lock"
run "T56: overlapped sweep is skipped, then a later sweep acts once" \
  bash -c "bash '$RESPONDER' | grep -q 'status=skipped' && rmdir '${RESPONDER_STATE_DIR}/sweep.lock' && RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' >/dev/null && [ \"\$(grep -c kickstart '${KICKSTART_LOG}')\" -eq 1 ]"

# ─── Phase 13: CTL-1510 round-4 remediations (T57–T60) ──────────────────────
#
# T57-T59: when bun is unavailable, _token_provisioned must replicate
# resolveNodeCloudTokenEnv's OWN precedence (env override > Layer-2 > default)
# in pure bash rather than hardcoding CATALYST_CLOUD_TOKEN (Codex P2 round 4).
# Shadow `bun` with a failing mock — MOCKBIN wins over the real system bun
# since the responder APPENDS (never prepends) its own SCRIPT_DIR to PATH.
cat > "$MOCKBIN/bun" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$MOCKBIN/bun"

_reset
touch "$PLIST"
export MOCK_LAST_EXIT=0
mkdir -p "${HOME}/.config/catalyst"
printf 'export CATALYST_CLOUD_TOKEN_ENV=MY_CUSTOM_TOKEN\nexport MY_CUSTOM_TOKEN=real-value\n' > "${HOME}/.config/catalyst/cloud-sync.env"
run "T57: bun unavailable + an env-override token name resolves via that name" \
  bash -c "out=\$(RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER'); printf '%s' \"\$out\" | grep -q 'failed-bounce signature' && test -s '${KICKSTART_LOG}'"
rm -f "${HOME}/.config/catalyst/cloud-sync.env" "$KICKSTART_LOG"

printf 'export ANOTHER_CUSTOM_TOKEN=real-value\n' > "${HOME}/.config/catalyst/cloud-sync.env"
printf '{"catalyst":{"cloud":{"tokenEnv":"ANOTHER_CUSTOM_TOKEN"}}}' > "${SCRATCH}/layer2-config.json"
run "T58: bun unavailable + no env override falls back to the Layer-2 tokenEnv key" \
  bash -c "out=\$(CATALYST_LAYER2_CONFIG_FILE='${SCRATCH}/layer2-config.json' RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER'); printf '%s' \"\$out\" | grep -q 'failed-bounce signature' && test -s '${KICKSTART_LOG}'"
rm -f "${HOME}/.config/catalyst/cloud-sync.env" "$KICKSTART_LOG" "${SCRATCH}/layer2-config.json"

printf 'export CATALYST_CLOUD_TOKEN=real-value\n' > "${HOME}/.config/catalyst/cloud-sync.env"
run "T59: bun unavailable + no overrides at all falls back to CATALYST_CLOUD_TOKEN" \
  bash -c "out=\$(CATALYST_LAYER2_CONFIG_FILE=/dev/null RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER'); printf '%s' \"\$out\" | grep -q 'failed-bounce signature' && test -s '${KICKSTART_LOG}'"
rm -f "${HOME}/.config/catalyst/cloud-sync.env" "$KICKSTART_LOG" "$MOCKBIN/bun"
unset MOCK_LAST_EXIT

# T60 (Codex P2 round 4): the sweep-lock pre-check must never touch a FRESH
# lock at all — restoring the read-only mtime gate closes the round-3
# regression where EVERY contention (not just genuinely stale locks) briefly
# vacated the canonical path. Same observable contract as T50f (fresh lock
# survives intact) but explicit about the round-4 fix it pins.
_reset
touch "$PLIST"
mkdir -p "${RESPONDER_STATE_DIR}/sweep.lock"
echo -n "still-fresh-owner" > "${RESPONDER_STATE_DIR}/sweep.lock/owner"
run "T60: a fresh lock is never claimed/touched — pre-check gates before any mv" \
  bash -c "bash '$RESPONDER' | grep -q 'heartbeat status=skipped' && ! test -s '${KICKSTART_LOG}' && [ \"\$(cat '${RESPONDER_STATE_DIR}/sweep.lock/owner')\" = 'still-fresh-owner' ]"
rm -rf "${RESPONDER_STATE_DIR}/sweep.lock"

# T61 (Codex P2 round 5): the token-resolution `bun` subprocess must be
# bounded like the launchctl probes — a hung bun must not hold the sweep
# lock forever. Shadow `bun` with a mock that hangs past the configured
# timeout; the sweep must still complete (falls through to the pure-bash
# fallback) rather than wedge.
cat > "$MOCKBIN/bun" <<'EOF'
#!/usr/bin/env bash
sleep 60
EOF
chmod +x "$MOCKBIN/bun"
_reset
touch "$PLIST"
export MOCK_LAST_EXIT=0
mkdir -p "${HOME}/.config/catalyst"
printf 'export CATALYST_CLOUD_TOKEN=real-value\n' > "${HOME}/.config/catalyst/cloud-sync.env"
run "T61: a hung bun token-resolution probe is bounded — sweep still completes" \
  bash -c "start=\$(date +%s); out=\$(RESPONDER_TOKEN_RESOLVE_TIMEOUT_SECS=1 RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER'); elapsed=\$(( \$(date +%s) - start )); printf '%s' \"\$out\" | grep -q 'failed-bounce signature' && [ \"\$elapsed\" -lt 30 ]"
rm -f "${HOME}/.config/catalyst/cloud-sync.env" "$MOCKBIN/bun"
unset MOCK_LAST_EXIT

# T62 (Codex P2 round 5): a FUTURE-dated (clock-skew) lock must not
# permanently block recovery — a negative signed age would otherwise never
# exceed any positive stale threshold. touch -t with a far-future timestamp.
_reset
touch "$PLIST" # dead-writer shape: without the clamp, this WOULD stay skipped forever
mkdir -p "${RESPONDER_STATE_DIR}/sweep.lock"
FUTURE_STAMP="$(date -v+10y +%Y%m%d0000 2>/dev/null || date -d '+10 years' +%Y%m%d0000 2>/dev/null)"
touch -t "$FUTURE_STAMP" "${RESPONDER_STATE_DIR}/sweep.lock"
run "T62: a future-dated lock is treated as stale-eligible, not blocked forever" \
  bash -c "out=\$(RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER'); printf '%s' \"\$out\" | grep -q 'broke stale sweep lock' && test -s '${KICKSTART_LOG}'"

# T63 (Codex P2 round 6): the sweep-lock stale-threshold floor must include
# EVERY bounded subprocess this sweep can spend time in, including the
# token-resolve timeout added in round 5 — a structural check (same idiom as
# T54) since the computed RESPONDER_SWEEP_LOCK_STALE_SECS value has no other
# external observation point.
run "T63: sweep-lock floor formula includes the token-resolve timeout" \
  bash -c "grep -q 'RESPONDER_LIST_TIMEOUT_SECS + RESPONDER_TOKEN_RESOLVE_TIMEOUT_SECS + RESPONDER_KICKSTART_TIMEOUT_SECS' '$RESPONDER'"

# T64 (CTL-1510 hotfix, own discovery — NOT a Codex round): the ENTIRE
# script, run under /bin/bash (3.2 on Darwin — the actual interpreter
# launchd/cron invoke via the plist's/cron line's hardcoded path; every
# OTHER test in this suite invokes `bash "$RESPONDER"`, which resolves
# through PATH to a newer Homebrew bash and never exercises 3.2's parser).
# Found live on mini-2 in production: bash 3.2 has a defect where multi-line
# comments containing an unbalanced paren/quote/colon INSIDE a `$(...)`
# command substitution corrupt its paren-matching, surfacing as a bogus
# "unbound variable" for a variable that IS assigned. This exact scenario
# (a provisioned real token + a failed-bounce writer) crash-looped the
# responder every cron cycle for hours before being caught — the writer
# itself stayed down the whole time since the responder never completed a
# sweep to kickstart it. Same idiom as T52c (unconditional /bin/bash — exists
# everywhere; harmlessly passes trivially on a newer Linux /bin/bash).
_reset
touch "$PLIST"
export MOCK_LAST_EXIT=0
mkdir -p "${HOME}/.config/catalyst"
printf 'export CATALYST_CLOUD_TOKEN=real-value\n' > "${HOME}/.config/catalyst/cloud-sync.env"
run "T64: the full script runs clean under real /bin/bash with a provisioned token (production interpreter)" \
  bash -c "out=\$(RESPONDER_KICKSTART_WAIT_SECS=0 /bin/bash '$RESPONDER' 2>&1); printf '%s' \"\$out\" | grep -q 'unbound variable' && exit 1; printf '%s' \"\$out\" | grep -q 'failed-bounce signature' && test -s '${KICKSTART_LOG}'"
rm -f "${HOME}/.config/catalyst/cloud-sync.env"
unset MOCK_LAST_EXIT

# ─── Phase 14: CTL-1518 agent supervision (T65–T74) ─────────────────────────
#
# Second supervised target: the com.catalyst.agent host-metrics sampler. Its
# block runs BEFORE the cloud-sync detect (the cloud-sync act path `exit 0`s, so
# a block after it would be unreachable) and is INERT without the agent plist.
# Same PATH-shadowed launchctl/pgrep mocks — the agent kickstart lands in
# KICKSTART_LOG as `kickstart -k gui/<uid>/com.catalyst.agent`. Staleness is the
# breadcrumb mtime, falling back to the plist install-mtime when it is absent.

export AGENT_HEARTBEAT_FILE="${SCRATCH}/catalyst-agent.heartbeat"
AGENT_PLIST_FILE="${CATALYST_LAUNCHAGENTS_DIR}/com.catalyst.agent.plist"
AGENT_KICK="kickstart -k gui/$(id -u)/com.catalyst.agent"

# _agent_reset: the cloud-sync _reset PLUS the agent plist + breadcrumb (the
# state dir removal in _reset already drops any agent-attempt.*/ESCALATED marker).
_agent_reset() {
  _reset
  rm -f "$AGENT_PLIST_FILE" "$AGENT_HEARTBEAT_FILE"
}

# T65 (inert): no agent plist → no target=catalyst-agent line at all (this is
# what keeps the whole T1–T64 suite above inert — none of them install it).
_agent_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _fresh_lock  # cloud-sync healthy
run "T65: no agent plist is inert — no target=catalyst-agent line" \
  bash -c "bash '$RESPONDER' | { ! grep -q 'target=catalyst-agent'; }"

# T66 (fresh): agent plist + fresh breadcrumb → healthy, no kickstart.
_agent_reset
touch "$AGENT_PLIST_FILE"; touch "$AGENT_HEARTBEAT_FILE"
run "T66: fresh agent breadcrumb is healthy (no kickstart)" \
  bash -c "bash '$RESPONDER' | grep -q 'agent-supervision status=healthy target=catalyst-agent' && ! test -s '${KICKSTART_LOG}'"

# T66b (Codex P2): the agent line uses the distinct 'agent-supervision status='
# prefix, NOT 'heartbeat status=', so it can never be the terminal line doctor's
# `\bheartbeat status=` freshness anchor keys on — a partial sweep that dies after
# the agent block but before cloud-sync's heartbeat can't fool doctor.
_agent_reset
touch "$AGENT_PLIST_FILE"; touch "$AGENT_HEARTBEAT_FILE"
run "T66b: the agent supervision line does NOT match doctor's 'heartbeat status=' anchor" \
  bash -c "bash '$RESPONDER' | grep 'target=catalyst-agent' | { ! grep -q 'heartbeat status='; }"

# T67 (stale): agent plist + old breadcrumb → kickstart com.catalyst.agent, with
# its OWN attempt marker (never the cloud-sync attempt.* namespace).
_agent_reset
touch "$AGENT_PLIST_FILE"; touch -t 202501010000 "$AGENT_HEARTBEAT_FILE"
RESPONDER_KICKSTART_WAIT_SECS=0 bash "$RESPONDER" > "${SCRATCH}/agent-out" 2>&1 || true
run "T67: stale agent breadcrumb kickstarts com.catalyst.agent" \
  expect_contains "$KICKSTART_LOG" "$AGENT_KICK"
run "T67b: stale agent emits its own target=catalyst-agent heartbeat" \
  expect_contains "${SCRATCH}/agent-out" "target=catalyst-agent"
run "T67c: stale agent records an agent-scoped attempt marker" \
  bash -c "ls '${RESPONDER_STATE_DIR}'/agent-attempt.* >/dev/null"
run "T67d: the agent path did NOT touch the cloud-sync attempt.* namespace" \
  bash -c "! ls '${RESPONDER_STATE_DIR}'/attempt.* >/dev/null 2>&1"

# T68 (absent breadcrumb, OLD plist): never ticked but installed long ago →
# plist-mtime fallback is stale → kickstart.
_agent_reset
touch -t 202501010000 "$AGENT_PLIST_FILE"
run "T68: absent breadcrumb + old plist mtime is stale (kickstart)" \
  bash -c "RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' >/dev/null; grep -qF '$AGENT_KICK' '${KICKSTART_LOG}'"

# T69 (absent breadcrumb, FRESH plist): freshly installed, not yet ticked →
# plist-mtime fallback is fresh → NOT stale → no kickstart (give it time to tick).
_agent_reset
touch "$AGENT_PLIST_FILE"
run "T69: absent breadcrumb + fresh plist mtime is NOT stale (no kickstart)" \
  bash -c "bash '$RESPONDER' | grep -q 'agent-supervision status=healthy target=catalyst-agent' && ! test -s '${KICKSTART_LOG}'"

# T70 (sub-kill-switch): RESPONDER_AGENT_ENABLED=0 disables the agent block even
# when stale.
_agent_reset
touch "$AGENT_PLIST_FILE"; touch -t 202501010000 "$AGENT_HEARTBEAT_FILE"
run "T70: RESPONDER_AGENT_ENABLED=0 disables the agent block (no kickstart)" \
  bash -c "RESPONDER_AGENT_ENABLED=0 bash '$RESPONDER' | grep -q 'agent-supervision status=disabled target=catalyst-agent' && ! test -s '${KICKSTART_LOG}'"

# T71 (cap → escalate): repeated stale → after MAX_ATTEMPTS, escalate with its
# own one-shot marker + fail-open otel, no further kickstart. MAX=2: kick, kick, escalate.
_agent_reset
touch "$AGENT_PLIST_FILE"; touch -t 202501010000 "$AGENT_HEARTBEAT_FILE"
export RESPONDER_MAX_ATTEMPTS=2
run "T71: agent strike 1 kickstarts (1 total)" \
  bash -c "RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' >/dev/null; [ \"\$(grep -cF '$AGENT_KICK' '${KICKSTART_LOG}')\" -eq 1 ]"
run "T71b: agent strike 2 kickstarts (2 total)" \
  bash -c "RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' >/dev/null; [ \"\$(grep -cF '$AGENT_KICK' '${KICKSTART_LOG}')\" -eq 2 ]"
run "T71c: agent third strike escalates (heartbeat + no third kickstart)" \
  bash -c "out=\$(RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER'); printf '%s' \"\$out\" | grep -q 'agent-supervision status=escalated target=catalyst-agent' && [ \"\$(grep -cF '$AGENT_KICK' '${KICKSTART_LOG}')\" -eq 2 ]"
run "T71d: agent ESCALATED.catalyst-agent one-shot marker written" \
  test -f "${RESPONDER_STATE_DIR}/ESCALATED.catalyst-agent"
run "T71e: agent escalation emitted fail-open otel with target=catalyst-agent" \
  expect_contains "$SCRATCH_OTEL_LOG" "target=catalyst-agent"
run "T71f: escalated hold — no re-emit (one-shot), no further kickstart" \
  bash -c "out=\$(bash '$RESPONDER'); printf '%s' \"\$out\" | grep -q 'agent-supervision status=escalated target=catalyst-agent' && [ \"\$(grep -c 'target=catalyst-agent' '${SCRATCH_OTEL_LOG}')\" -eq 1 ]"
unset RESPONDER_MAX_ATTEMPTS

# T72 (re-arm): a fresh breadcrumb after escalation clears the markers + re-arms.
_agent_reset
touch "$AGENT_PLIST_FILE"; touch "$AGENT_HEARTBEAT_FILE"
mkdir -p "$RESPONDER_STATE_DIR"
touch "${RESPONDER_STATE_DIR}/ESCALATED.catalyst-agent"
touch "${RESPONDER_STATE_DIR}/agent-attempt.$(date +%s).1"
run "T72: agent condition clears → re-arm" \
  bash -c "bash '$RESPONDER' | grep -q 're-armed'"
run "T72b: agent ESCALATED marker removed on re-arm" \
  bash -c "! test -f '${RESPONDER_STATE_DIR}/ESCALATED.catalyst-agent'"
run "T72c: agent attempt markers removed on re-arm" \
  bash -c "! ls '${RESPONDER_STATE_DIR}'/agent-attempt.* >/dev/null 2>&1"

# T73 (two plists): cloud-sync healthy + agent stale — the agent kickstart fires
# AND the sweep STILL ends with a completed cloud-sync `heartbeat status=` line
# (the doctor-freshness contract survives the second target running first).
_agent_reset
touch "$PLIST"; touch "$MOCK_ALIVE_FILE"; _fresh_lock
touch "$AGENT_PLIST_FILE"; touch -t 202501010000 "$AGENT_HEARTBEAT_FILE"
RESPONDER_KICKSTART_WAIT_SECS=0 bash "$RESPONDER" > "${SCRATCH}/two-out" 2>&1 || true
run "T73: two plists — the agent kickstart fires" \
  expect_contains "$KICKSTART_LOG" "$AGENT_KICK"
run "T73b: two plists — the agent emitted its own target=catalyst-agent heartbeat" \
  expect_contains "${SCRATCH}/two-out" "target=catalyst-agent"
run "T73c: two plists — the sweep still ENDS with a completed cloud-sync heartbeat (doctor freshness)" \
  bash -c "tail -1 '${SCRATCH}/two-out' | grep -q 'heartbeat status=healthy' && tail -1 '${SCRATCH}/two-out' | { ! grep -q 'target=catalyst-agent'; }"
run "T73d: two plists — the healthy cloud-sync writer was NOT kickstarted" \
  bash -c "! grep -q 'ai.coalesce.catalyst-cloud-sync' '${KICKSTART_LOG}'"

# T74 (bash 3.2): the FULL script with the agent block active runs clean under
# real /bin/bash (3.2 on Darwin — the production interpreter; same idiom as T64).
# No `unbound variable`, and the agent kickstart still fires.
_agent_reset
touch "$AGENT_PLIST_FILE"; touch -t 202501010000 "$AGENT_HEARTBEAT_FILE"
run "T74: the agent block runs clean under real /bin/bash (production interpreter)" \
  bash -c "out=\$(RESPONDER_KICKSTART_WAIT_SECS=0 /bin/bash '$RESPONDER' 2>&1); printf '%s' \"\$out\" | grep -q 'unbound variable' && exit 1; grep -qF '$AGENT_KICK' '${KICKSTART_LOG}'"

# ─── Phase 15: CTL-1616 PR5 — cloud-token fixture-matrix completion (T75–T77) ─
#
# T57-T59 (Phase 13, above) already cover the BASH-FALLBACK column of the design §9 PR5
# fixture matrix ({env-override, layer2, default} x {bun-path, bash-fallback}) with bun
# unavailable. T49x/T59 already cover the bun-path x default cell with REAL bun. T75-T76
# close the two remaining cells — bun-path x env-override and bun-path x layer2-override —
# with REAL bun (not mocked), completing all 6 matrix cells across this suite. No bun mock is
# installed here, so `_resolve_token_env_via_bun` exercises the real config.mjs
# resolveNodeCloudTokenEnv() delegate (which itself now folds onto lib/secret-contract.mjs's
# resolveCloudTokenName — CTL-1616 PR5).

_agent_reset
touch "$PLIST"
export MOCK_LAST_EXIT=0
mkdir -p "${HOME}/.config/catalyst"
printf 'export CATALYST_CLOUD_TOKEN_ENV=MY_CUSTOM_TOKEN\nexport MY_CUSTOM_TOKEN=real-value\n' > "${HOME}/.config/catalyst/cloud-sync.env"
run "T75: bun AVAILABLE + env-override token name resolves via the bun path (fixture-matrix cell)" \
  bash -c "out=\$(RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' 2>&1); printf '%s' \"\$out\" | grep -q 'failed-bounce signature' && test -s '${KICKSTART_LOG}' && printf '%s' \"\$out\" | grep -q 'token-env resolved via bun: MY_CUSTOM_TOKEN'"
rm -f "${HOME}/.config/catalyst/cloud-sync.env" "$KICKSTART_LOG"

printf 'export ANOTHER_CUSTOM_TOKEN=real-value\n' > "${HOME}/.config/catalyst/cloud-sync.env"
printf '{"catalyst":{"cloud":{"tokenEnv":"ANOTHER_CUSTOM_TOKEN"}}}' > "${SCRATCH}/layer2-config.json"
run "T76: bun AVAILABLE + Layer-2 tokenEnv override resolves via the bun path (fixture-matrix cell)" \
  bash -c "out=\$(CATALYST_LAYER2_CONFIG_FILE='${SCRATCH}/layer2-config.json' RESPONDER_KICKSTART_WAIT_SECS=0 bash '$RESPONDER' 2>&1); printf '%s' \"\$out\" | grep -q 'failed-bounce signature' && test -s '${KICKSTART_LOG}' && printf '%s' \"\$out\" | grep -q 'token-env resolved via bun: ANOTHER_CUSTOM_TOKEN'"
rm -f "${HOME}/.config/catalyst/cloud-sync.env" "$KICKSTART_LOG" "${SCRATCH}/layer2-config.json"
unset MOCK_LAST_EXIT

# T77 (bash 3.2, CTL-1616 PR5): the sourced lib/catalyst-secret-contract.sh + the new
# catalyst_secret_cloud_token_name call inside _token_provisioned's `probe="$(...)"` body must
# not reintroduce the T64 comment-in-subshell defect — the function CALL itself is the only
# thing textually inside that substitution (its definition lives in the separately-sourced
# file, parsed before the subshell is ever entered), but this pins the empirical guarantee
# under the real production interpreter with the bash-fallback path forced (bun mocked off).
cat > "$MOCKBIN/bun" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$MOCKBIN/bun"
_agent_reset
touch "$PLIST"
export MOCK_LAST_EXIT=0
mkdir -p "${HOME}/.config/catalyst"
printf 'export CATALYST_CLOUD_TOKEN=real-value\n' > "${HOME}/.config/catalyst/cloud-sync.env"
run "T77: bash-fallback path (bun unavailable) runs clean under real /bin/bash (production interpreter)" \
  bash -c "out=\$(RESPONDER_KICKSTART_WAIT_SECS=0 /bin/bash '$RESPONDER' 2>&1); printf '%s' \"\$out\" | grep -q 'unbound variable' && exit 1; printf '%s' \"\$out\" | grep -q 'failed-bounce signature' && test -s '${KICKSTART_LOG}'"
rm -f "${HOME}/.config/catalyst/cloud-sync.env" "$MOCKBIN/bun"
unset MOCK_LAST_EXIT

# ─── results ────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
