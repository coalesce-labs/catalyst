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
  unset MOCK_KICKSTART_REVIVES MOCK_KICKSTART_FRESHENS 2>/dev/null || true
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

# ─── results ────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
