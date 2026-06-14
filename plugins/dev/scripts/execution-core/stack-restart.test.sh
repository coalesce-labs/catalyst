#!/usr/bin/env bash
# stack-restart.test.sh — CTL-1084 Phase 5 bash tests.
# 1. Restart order: monitor starts before broker in cmd_start.
# 2. Status: cmd_status renders governance section from node.boot fixture.
# 3. Mismatch: env-override flags print a warning line in status.
#
# Run: bash plugins/dev/scripts/execution-core/stack-restart.test.sh

set -uo pipefail
PASS=0; FAIL=0

ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; echo "       $2"; FAIL=$((FAIL+1)); }

# Resolve catalyst-stack script location (handles symlinks).
_SRC="${BASH_SOURCE[0]}"
while [[ -L $_SRC ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
STACK_SCRIPT="${SCRIPT_DIR}/../catalyst-stack"

# ── Test 1: monitor starts before broker in cmd_start ─────────────────────────
{
  # Source functions without running main by guarding with a fake arg.
  # We stub start_monitor and start_broker to record order.
  ORDER_FILE="$(mktemp)"
  # shellcheck source=/dev/null
  (
    set +u
    # Provide required vars that catalyst-stack references at top level
    CATALYST_DIR="${HOME}/catalyst"
    ASSUME_YES="yes"
    # Stub all external commands so sourcing doesn't fail
    catalyst-broker()  { :; }
    catalyst-monitor() { :; }
    catalyst-execution-core() { :; }
    start_broker()  { echo "broker"  >> "$ORDER_FILE"; }
    start_monitor() { echo "monitor" >> "$ORDER_FILE"; }
    start_daemon()  { echo "daemon"  >> "$ORDER_FILE"; }
    start_mitmproxy() { :; }
    stop_daemon()   { :; }
    stop_broker()   { :; }
    stop_monitor()  { :; }
    stop_mitmproxy() { :; }
    log()           { :; }
    cmd_status()    { :; }
    mitm_pid()      { echo ""; }
    pid_alive()     { return 1; }
    fail_fn()       { :; }
    # Source the script (main is guarded below by BASH_SOURCE check)
    export _STACK_TEST_MODE=1
    # Extract and eval just the cmd_start function by running a subshell
    # that defines stubs first, then sources the script body up to dispatch.
    eval "$(sed -n '/^cmd_start/,/^}/p' "$STACK_SCRIPT" | head -50)"
    cmd_start 2>/dev/null
    true
  )
  ORDER="$(cat "$ORDER_FILE" 2>/dev/null)"
  rm -f "$ORDER_FILE"
  MON_POS=$(echo "$ORDER" | grep -n "^monitor$" | cut -d: -f1 | head -1)
  BRK_POS=$(echo "$ORDER" | grep -n "^broker$"  | cut -d: -f1 | head -1)
  if [[ -n "$MON_POS" && -n "$BRK_POS" && "$MON_POS" -lt "$BRK_POS" ]]; then
    ok "restart order: monitor ($MON_POS) starts before broker ($BRK_POS)"
  else
    fail "restart order: expected monitor before broker" \
         "monitor pos=$MON_POS broker pos=$BRK_POS in: $(echo "$ORDER" | tr '\n' ' ')"
  fi
}

# ── Test 2: catalyst-stack status includes governance section ─────────────────
{
  TMPDIR_S="$(mktemp -d)"
  EVENTS_FILE="${TMPDIR_S}/events/2026-06.jsonl"
  mkdir -p "$(dirname "$EVENTS_FILE")"
  # Write a minimal node.boot fixture
  cat > "$EVENTS_FILE" <<'EOF'
{"ts":"2026-06-12T18:00:00Z","attributes":{"event.name":"node.boot"},"body":{"payload":{"host.name":"testhost","plugin_version":"12.6.0","effective_flags":{"beliefsShadow":true,"diagnostician":false,"intentsEnforce":false,"advanceShadowSummary":false,"stallJanitor":{"mode":"shadow"},"watchdog":{"mode":"shadow"},"unstuckSweep":{"mode":"off"}},"flag_sources":{"beliefsShadow":"config","diagnostician":"default","intentsEnforce":"default","advanceShadowSummary":"default"},"adopted_workers":2,"zombies_cleared":1,"rewalk_planned":3,"rewalk_dispatched":2}}}
EOF

  STATUS_OUT="$(CATALYST_DIR="$TMPDIR_S" bash "$STACK_SCRIPT" status 2>/dev/null || true)"
  rm -rf "$TMPDIR_S"

  if echo "$STATUS_OUT" | grep -q "plugin_version\|12.6.0\|governance\|beliefsShadow"; then
    ok "status: governance section rendered (contains plugin_version or flag names)"
  else
    fail "status: governance section missing from output" \
         "got: $(echo "$STATUS_OUT" | head -10)"
  fi
}

# ── Test 3: env-override mismatch line appears in status ─────────────────────
{
  TMPDIR_M="$(mktemp -d)"
  EVENTS_FILE_M="${TMPDIR_M}/events/2026-06.jsonl"
  mkdir -p "$(dirname "$EVENTS_FILE_M")"
  # flag_sources has beliefsShadow as env-override → mismatch warning expected
  cat > "$EVENTS_FILE_M" <<'EOF'
{"ts":"2026-06-12T18:00:00Z","attributes":{"event.name":"node.boot"},"body":{"payload":{"host.name":"testhost","plugin_version":"12.6.0","effective_flags":{"beliefsShadow":true,"diagnostician":false,"intentsEnforce":false,"advanceShadowSummary":false,"stallJanitor":{"mode":"shadow"},"watchdog":{"mode":"shadow"},"unstuckSweep":{"mode":"off"}},"flag_sources":{"beliefsShadow":"env-override","diagnostician":"default","intentsEnforce":"default","advanceShadowSummary":"default"},"adopted_workers":0,"zombies_cleared":0,"rewalk_planned":0,"rewalk_dispatched":0}}}
EOF

  STATUS_M="$(CATALYST_DIR="$TMPDIR_M" bash "$STACK_SCRIPT" status 2>/dev/null || true)"
  rm -rf "$TMPDIR_M"

  if echo "$STATUS_M" | grep -qiE "mismatch|override|ENV OVERRIDE"; then
    ok "status: env-override mismatch line rendered"
  else
    fail "status: expected mismatch/override warning in status output" \
         "got: $(echo "$STATUS_M" | head -10)"
  fi
}

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS pass, $FAIL fail"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
