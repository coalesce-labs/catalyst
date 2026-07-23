#!/usr/bin/env bash
# CTL-1236: tests for plugins/dev/scripts/lib/thoughts-pull-sync-gate.sh
# Run: bash plugins/dev/scripts/__tests__/thoughts-pull-sync-gate.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
GATE="${REPO_ROOT}/plugins/dev/scripts/lib/thoughts-pull-sync-gate.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
setup_workdir() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "${dir}/.catalyst"
  echo "$dir"
}

write_hosts() {
  local workdir="$1" json="$2"
  printf '%s\n' "$json" > "${workdir}/.catalyst/hosts.json"
}

# Create a fake pull-sync script that touches a sentinel file when invoked.
make_fake_pull_sync() {
  local bindir="$1" exit_code="$2" sentinel="${3:-}"
  cat > "${bindir}/thoughts-pull-sync" <<EOF
#!/usr/bin/env bash
[ -n "${sentinel:-}" ] && touch "${sentinel}"
exit ${exit_code}
EOF
  chmod +x "${bindir}/thoughts-pull-sync"
}

# --------------------------------------------------------------------------
# Test 1: single-host roster (hosts.json with 1 entry) → exit 0, pull NOT invoked
# --------------------------------------------------------------------------
echo "Test: single-host roster → exit 0, pull not invoked"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/pull_called"
  write_hosts "$WD" '["mini"]'
  make_fake_pull_sync "$BINDIR" 0 "$SENTINEL"
  rc=0
  CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
  CATALYST_PULL_SYNC_CMD="${BINDIR}/thoughts-pull-sync" \
    bash "$GATE" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "single-host roster: gate exited $rc, want 0"
  elif [[ -f "$SENTINEL" ]]; then
    fail "single-host roster: pull script was invoked (sentinel present)"
  else
    pass "single-host roster → exit 0, pull not invoked"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 2: absent hosts.json → treated as single-host → exit 0, not invoked
# --------------------------------------------------------------------------
echo "Test: absent hosts.json → single-host no-op"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/pull_called"
  # No hosts.json written
  make_fake_pull_sync "$BINDIR" 0 "$SENTINEL"
  rc=0
  CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
  CATALYST_PULL_SYNC_CMD="${BINDIR}/thoughts-pull-sync" \
    bash "$GATE" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "absent hosts.json: gate exited $rc, want 0"
  elif [[ -f "$SENTINEL" ]]; then
    fail "absent hosts.json: pull script was invoked"
  else
    pass "absent hosts.json → exit 0, not invoked"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 3: malformed hosts.json → treated as single-host → exit 0, not invoked
# --------------------------------------------------------------------------
echo "Test: malformed hosts.json → single-host no-op"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/pull_called"
  write_hosts "$WD" 'not-valid-json'
  make_fake_pull_sync "$BINDIR" 0 "$SENTINEL"
  rc=0
  CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
  CATALYST_PULL_SYNC_CMD="${BINDIR}/thoughts-pull-sync" \
    bash "$GATE" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "malformed hosts.json: gate exited $rc, want 0"
  elif [[ -f "$SENTINEL" ]]; then
    fail "malformed hosts.json: pull script was invoked"
  else
    pass "malformed hosts.json → exit 0, not invoked"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 4: multi-host roster → pull script IS invoked, gate exits 0
# --------------------------------------------------------------------------
echo "Test: multi-host roster → pull invoked, exit 0"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/pull_called"
  write_hosts "$WD" '["mini","mac-studio"]'
  make_fake_pull_sync "$BINDIR" 0 "$SENTINEL"
  rc=0
  CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
  CATALYST_PULL_SYNC_CMD="${BINDIR}/thoughts-pull-sync" \
    bash "$GATE" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "multi-host: gate exited $rc, want 0"
  elif [[ ! -f "$SENTINEL" ]]; then
    fail "multi-host: pull script was NOT invoked"
  else
    pass "multi-host roster → pull invoked, exit 0"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 5: NON-FATAL — multi-host + pull script exits non-zero → gate STILL exits 0
# (key divergence from the write-side thoughts-sync-gate.sh)
# --------------------------------------------------------------------------
echo "Test: multi-host + pull failure → gate STILL exits 0 (non-fatal)"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  write_hosts "$WD" '["mini","mac-studio"]'
  make_fake_pull_sync "$BINDIR" 1 ""  # pull fails with exit 1
  rc=0
  CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
  CATALYST_PULL_SYNC_CMD="${BINDIR}/thoughts-pull-sync" \
    bash "$GATE" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "non-fatal: gate exited $rc when pull failed — must always exit 0"
  else
    pass "multi-host + pull failure → gate STILL exits 0 (non-fatal)"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# CTL-1490: Mode-aware pull gate tests.
# Pull failures are ALWAYS non-fatal (exit 0) in all modes — this is the
# deliberate divergence from the write-side gate (research F2/F6).
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# T6: mode=off explicit, roster=1 → pull NOT invoked (today's roster no-op)
# --------------------------------------------------------------------------
echo "T6: mode=off, roster=1 → pull not invoked"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/pull_called"
  write_hosts "$WD" '["mini"]'
  make_fake_pull_sync "$BINDIR" 0 "$SENTINEL"
  rc=0
  CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
  CATALYST_PULL_SYNC_CMD="${BINDIR}/thoughts-pull-sync" \
  CATALYST_PHASE_ARTIFACT_SYNC_MODE=off \
    bash "$GATE" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "T6: mode=off roster=1: gate exited $rc, want 0"
  elif [[ -f "$SENTINEL" ]]; then
    fail "T6: mode=off roster=1: pull was invoked (should be roster no-op)"
  else
    pass "T6: mode=off roster=1 → pull NOT invoked"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# T7: mode=shadow, roster=1 → pull invoked (roster guard removed), fail exit 0
# --------------------------------------------------------------------------
echo "T7: mode=shadow, roster=1 → pull invoked, failure still exit 0"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/pull_called"
  write_hosts "$WD" '["mini"]'
  make_fake_pull_sync "$BINDIR" 1 "$SENTINEL"   # pull fails
  rc=0
  CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
  CATALYST_PULL_SYNC_CMD="${BINDIR}/thoughts-pull-sync" \
  CATALYST_PHASE_ARTIFACT_SYNC_MODE=shadow \
    bash "$GATE" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "T7: mode=shadow pull fail: gate exited $rc, want 0 (read side always non-fatal)"
  elif [[ ! -f "$SENTINEL" ]]; then
    fail "T7: mode=shadow roster=1: pull was NOT invoked (roster guard should be bypassed)"
  else
    pass "T7: mode=shadow roster=1 → pull invoked, failure exit 0"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# T8: mode=enforce, roster=1 → pull invoked, failure STILL exit 0
#     (read side never blocks in any mode — diverges from write side by design)
# --------------------------------------------------------------------------
echo "T8: mode=enforce, roster=1 → pull invoked, failure still exit 0"
{
  WD="$(setup_workdir)"
  BINDIR="${WD}/bin"
  mkdir -p "$BINDIR"
  SENTINEL="${WD}/pull_called"
  write_hosts "$WD" '["mini"]'
  make_fake_pull_sync "$BINDIR" 1 "$SENTINEL"   # pull fails
  rc=0
  CATALYST_CONFIG_FILE="${WD}/.catalyst/config.json" \
  CATALYST_PULL_SYNC_CMD="${BINDIR}/thoughts-pull-sync" \
  CATALYST_PHASE_ARTIFACT_SYNC_MODE=enforce \
    bash "$GATE" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "T8: mode=enforce pull fail: gate exited $rc, want 0 (read side never blocks)"
  elif [[ ! -f "$SENTINEL" ]]; then
    fail "T8: mode=enforce roster=1: pull was NOT invoked (roster guard should be bypassed)"
  else
    pass "T8: mode=enforce roster=1 → pull invoked, failure exit 0"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
