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
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
