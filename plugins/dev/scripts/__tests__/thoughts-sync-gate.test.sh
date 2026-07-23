#!/usr/bin/env bash
# CTL-866: tests for plugins/dev/scripts/lib/thoughts-sync-gate.sh
# Run: bash plugins/dev/scripts/__tests__/thoughts-sync-gate.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
GATE="${REPO_ROOT}/plugins/dev/scripts/lib/thoughts-sync-gate.sh"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

# --------------------------------------------------------------------------
# Helpers: build a temp workspace with injectable hosts.json + fakes
# --------------------------------------------------------------------------
setup_workdir() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "${dir}/.catalyst"
  echo "$dir"
}

# Write hosts.json to the workdir's .catalyst/
write_hosts() {
  local workdir="$1" json="$2"
  printf '%s\n' "$json" > "${workdir}/.catalyst/hosts.json"
}

# Create a fake humanlayer on PATH that exits with given code.
# Optionally touch a sentinel file on invocation.
make_fake_humanlayer() {
  local bindir="$1" exit_code="$2" sentinel="${3:-}"
  cat > "${bindir}/humanlayer" <<EOF
#!/usr/bin/env bash
[ -n "${sentinel:-}" ] && touch "${sentinel}"
exit ${exit_code}
EOF
  chmod +x "${bindir}/humanlayer"
}

# Create a fake phase-agent-emit-complete that logs args to a file.
make_fake_emit() {
  local bindir="$1" logfile="$2"
  cat > "${bindir}/phase-agent-emit-complete" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${logfile}"
exit 0
EOF
  chmod +x "${bindir}/phase-agent-emit-complete"
}

# --------------------------------------------------------------------------
# Test 1: single-host roster → exit 0, humanlayer NOT invoked
# --------------------------------------------------------------------------
echo "Test: single-host roster → exit 0, humanlayer not invoked"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/humanlayer_called"
  write_hosts "$WD" '["mini"]'
  make_fake_humanlayer "$BINDIR" 0 "$SENTINEL"
  make_fake_emit "$BINDIR" "${WD}/emit.log"
  rc=0
  env PATH="${BINDIR}:${PATH}" \
      CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
      CATALYST_EMIT_COMPLETE="${BINDIR}/phase-agent-emit-complete" \
      bash "$GATE" --phase research --ticket CTL-TEST || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "single-host roster: gate exited $rc, want 0"
  elif [[ -f "$SENTINEL" ]]; then
    fail "single-host roster: humanlayer was invoked (sentinel present)"
  else
    pass "single-host roster → exit 0, humanlayer not invoked"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 2: absent hosts.json → treated as single-host → exit 0, no sync
# --------------------------------------------------------------------------
echo "Test: absent hosts.json → single-host no-op"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/humanlayer_called"
  # No hosts.json written
  make_fake_humanlayer "$BINDIR" 0 "$SENTINEL"
  make_fake_emit "$BINDIR" "${WD}/emit.log"
  rc=0
  env PATH="${BINDIR}:${PATH}" \
      CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
      CATALYST_EMIT_COMPLETE="${BINDIR}/phase-agent-emit-complete" \
      bash "$GATE" --phase research --ticket CTL-TEST || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "absent hosts.json: gate exited $rc, want 0"
  elif [[ -f "$SENTINEL" ]]; then
    fail "absent hosts.json: humanlayer was invoked (sentinel present)"
  else
    pass "absent hosts.json → exit 0, no sync"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 3: malformed hosts.json → treated as single-host → exit 0, no sync
# --------------------------------------------------------------------------
echo "Test: malformed hosts.json → single-host no-op"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/humanlayer_called"
  write_hosts "$WD" 'not-valid-json'
  make_fake_humanlayer "$BINDIR" 0 "$SENTINEL"
  make_fake_emit "$BINDIR" "${WD}/emit.log"
  rc=0
  env PATH="${BINDIR}:${PATH}" \
      CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
      CATALYST_EMIT_COMPLETE="${BINDIR}/phase-agent-emit-complete" \
      bash "$GATE" --phase research --ticket CTL-TEST || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "malformed hosts.json: gate exited $rc, want 0"
  elif [[ -f "$SENTINEL" ]]; then
    fail "malformed hosts.json: humanlayer was invoked (sentinel present)"
  else
    pass "malformed hosts.json → exit 0, no sync"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 4: multi-host roster + sync success → exit 0
# --------------------------------------------------------------------------
echo "Test: multi-host roster + sync success → exit 0"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/humanlayer_called"
  write_hosts "$WD" '["mini","mac-studio"]'
  make_fake_humanlayer "$BINDIR" 0 "$SENTINEL"
  make_fake_emit "$BINDIR" "${WD}/emit.log"
  rc=0
  env PATH="${BINDIR}:${PATH}" \
      CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
      CATALYST_EMIT_COMPLETE="${BINDIR}/phase-agent-emit-complete" \
      bash "$GATE" --phase research --ticket CTL-TEST || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "multi-host + sync success: gate exited $rc, want 0"
  elif [[ ! -f "$SENTINEL" ]]; then
    fail "multi-host + sync success: humanlayer was NOT invoked"
  else
    pass "multi-host roster + sync success → exit 0"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 5: multi-host + sync failure → exits non-zero, emit-complete called
#         with --reason thoughts_sync_failed
# --------------------------------------------------------------------------
echo "Test: multi-host + sync failure → non-zero exit, emit-complete called"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  EMIT_LOG="${WD}/emit.log"
  mkdir -p "$BINDIR"
  write_hosts "$WD" '["mini","mac-studio"]'
  make_fake_humanlayer "$BINDIR" 1 ""
  make_fake_emit "$BINDIR" "$EMIT_LOG"
  rc=0
  env PATH="${BINDIR}:${PATH}" \
      CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
      CATALYST_EMIT_COMPLETE="${BINDIR}/phase-agent-emit-complete" \
      bash "$GATE" --phase research --ticket CTL-TEST || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    fail "multi-host + sync failure: gate exited 0, want non-zero"
  elif [[ ! -f "$EMIT_LOG" ]]; then
    fail "multi-host + sync failure: emit-complete was not called"
  elif ! grep -q "thoughts_sync_failed" "$EMIT_LOG"; then
    fail "multi-host + sync failure: emit-complete not called with --reason thoughts_sync_failed" \
      "emit log: $(cat "$EMIT_LOG")"
  else
    pass "multi-host + sync failure → non-zero exit, emit-complete with thoughts_sync_failed"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# CTL-1490: Mode-aware gate tests (T6-T9).
# These require lib/phase-artifact-sync-mode.sh to exist.
# --------------------------------------------------------------------------

# Helper: current YYYY-MM for events log filename
events_month_file() {
  local dir="$1"
  printf '%s' "${dir}/events/$(date -u +%Y-%m).jsonl"
}

# --------------------------------------------------------------------------
# T6: mode=off explicit, roster=1 → exit 0, humanlayer NOT invoked
#     (off == byte-identical to today on single-host: roster guard fires first)
# --------------------------------------------------------------------------
echo "T6: mode=off explicit, single-host → exit 0, humanlayer not invoked"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/humanlayer_called"
  write_hosts "$WD" '["mini"]'
  make_fake_humanlayer "$BINDIR" 0 "$SENTINEL"
  make_fake_emit "$BINDIR" "${WD}/emit.log"
  rc=0
  env PATH="${BINDIR}:${PATH}" \
      CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
      CATALYST_EMIT_COMPLETE="${BINDIR}/phase-agent-emit-complete" \
      CATALYST_PHASE_ARTIFACT_SYNC_MODE=off \
      bash "$GATE" --phase research --ticket CTL-TEST || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "T6: mode=off single-host: gate exited $rc, want 0"
  elif [[ -f "$SENTINEL" ]]; then
    fail "T6: mode=off single-host: humanlayer was invoked (sentinel present)"
  else
    pass "T6: mode=off single-host → exit 0, humanlayer not invoked"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# T7: mode=shadow, roster=1, sync FAIL → exit 0 (never blocks) AND
#     thoughts.sync.failed.<phase>.<ticket> appended to events log
# --------------------------------------------------------------------------
echo "T7: mode=shadow, roster=1, sync FAIL → exit 0 + event appended"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  CATALYST_DIR_T7="${WD}/catalyst"
  mkdir -p "$BINDIR" "${CATALYST_DIR_T7}/events"
  write_hosts "$WD" '["mini"]'
  make_fake_humanlayer "$BINDIR" 1 ""   # sync fails
  make_fake_emit "$BINDIR" "${WD}/emit.log"
  rc=0
  env PATH="${BINDIR}:${PATH}" \
      CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
      CATALYST_EMIT_COMPLETE="${BINDIR}/phase-agent-emit-complete" \
      CATALYST_PHASE_ARTIFACT_SYNC_MODE=shadow \
      CATALYST_DIR="${CATALYST_DIR_T7}" \
      bash "$GATE" --phase verify --ticket CTL-T7 || rc=$?
  EVENTS_FILE="$(events_month_file "${CATALYST_DIR_T7}")"
  if [[ "$rc" -ne 0 ]]; then
    fail "T7: shadow + sync fail: gate exited $rc, want 0 (shadow never blocks)"
  elif [[ ! -f "$EVENTS_FILE" ]]; then
    fail "T7: shadow + sync fail: events log not created at $EVENTS_FILE"
  elif ! grep -q "thoughts.sync.failed" "$EVENTS_FILE" 2>/dev/null; then
    fail "T7: shadow + sync fail: events log missing thoughts.sync.failed entry" \
      "log contents: $(cat "$EVENTS_FILE" 2>/dev/null || echo '<empty>')"
  else
    pass "T7: mode=shadow + sync fail → exit 0 + event appended"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# T8: mode=enforce, roster=1, sync FAIL → non-zero exit (11), emit-complete
#     called with reason=thoughts_sync_failed (fires even at roster=1)
# --------------------------------------------------------------------------
echo "T8: mode=enforce, roster=1, sync FAIL → exit 11, emit-complete called"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  EMIT_LOG="${WD}/emit.log"
  mkdir -p "$BINDIR"
  write_hosts "$WD" '["mini"]'
  make_fake_humanlayer "$BINDIR" 1 ""   # sync fails
  make_fake_emit "$BINDIR" "$EMIT_LOG"
  rc=0
  env PATH="${BINDIR}:${PATH}" \
      CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
      CATALYST_EMIT_COMPLETE="${BINDIR}/phase-agent-emit-complete" \
      CATALYST_PHASE_ARTIFACT_SYNC_MODE=enforce \
      bash "$GATE" --phase verify --ticket CTL-T8 || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    fail "T8: enforce + sync fail: gate exited 0, want non-zero"
  elif [[ ! -f "$EMIT_LOG" ]]; then
    fail "T8: enforce + sync fail: emit-complete was not called"
  elif ! grep -q "thoughts_sync_failed" "$EMIT_LOG"; then
    fail "T8: enforce + sync fail: emit-complete not called with thoughts_sync_failed" \
      "emit log: $(cat "$EMIT_LOG")"
  else
    pass "T8: mode=enforce + sync fail → exit 11, emit-complete with thoughts_sync_failed"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# T9: mode=enforce, roster=1, sync OK → exit 0, humanlayer invoked
#     (roster guard bypassed for enforce mode)
# --------------------------------------------------------------------------
echo "T9: mode=enforce, roster=1, sync OK → exit 0, humanlayer invoked"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  SENTINEL="${WD}/humanlayer_called"
  mkdir -p "$BINDIR"
  write_hosts "$WD" '["mini"]'
  make_fake_humanlayer "$BINDIR" 0 "$SENTINEL"   # sync succeeds
  make_fake_emit "$BINDIR" "${WD}/emit.log"
  rc=0
  env PATH="${BINDIR}:${PATH}" \
      CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
      CATALYST_EMIT_COMPLETE="${BINDIR}/phase-agent-emit-complete" \
      CATALYST_PHASE_ARTIFACT_SYNC_MODE=enforce \
      bash "$GATE" --phase verify --ticket CTL-T9 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "T9: enforce + sync OK: gate exited $rc, want 0"
  elif [[ ! -f "$SENTINEL" ]]; then
    fail "T9: enforce + sync OK: humanlayer was NOT invoked (roster guard should be bypassed)"
  else
    pass "T9: mode=enforce + sync OK → exit 0, humanlayer invoked at roster=1"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
