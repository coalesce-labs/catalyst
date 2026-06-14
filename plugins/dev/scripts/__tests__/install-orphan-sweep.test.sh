#!/usr/bin/env bash
# Tests for install-orphan-sweep.sh (CTL-1030 Phase 6).
#
# Run: bash plugins/dev/scripts/__tests__/install-orphan-sweep.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALLER="${REPO_ROOT}/plugins/dev/scripts/install-orphan-sweep.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Test harness
run() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
  fi
}

run_output() {
  local name="$1" pattern="$2"; shift 2
  local out
  out="$("$@" 2>&1 || true)"
  if echo "$out" | grep -qiE "$pattern"; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name (pattern '$pattern' not found in output)"
    echo "    command: $*"
    echo "    output:  $out"
  fi
}

# MOCKBIN setup — fake launchctl and uname
MOCKBIN="${SCRATCH}/mockbin"
mkdir -p "$MOCKBIN"

LAUNCHCTL_LOG="${SCRATCH}/launchctl.log"

cat > "$MOCKBIN/launchctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "${LAUNCHCTL_LOG}"
# Accept everything unless the caller sets MOCK_LAUNCHCTL_BOOTOUT_RC
subcmd="${1:-}"
if [[ "$subcmd" == "bootout" && "${MOCK_LAUNCHCTL_BOOTOUT_RC:-0}" != "0" ]]; then
  exit "${MOCK_LAUNCHCTL_BOOTOUT_RC}"
fi
exit 0
EOF
chmod +x "$MOCKBIN/launchctl"

cat > "$MOCKBIN/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-s" ]]; then
  echo "${MOCK_UNAME:-Darwin}"
else
  command uname "$@"
fi
EOF
chmod +x "$MOCKBIN/uname"

export PATH="${MOCKBIN}:${PATH}"
export LAUNCHCTL_LOG

# Override HOME so we don't touch the real ~/Library/LaunchAgents
FAKE_HOME="${SCRATCH}/home"
mkdir -p "${FAKE_HOME}/Library/LaunchAgents"
export HOME="$FAKE_HOME"

# ─── I1: installer exists and is executable ───────────────────────────────────
run "I1: install-orphan-sweep.sh exists and is executable" test -x "$INSTALLER"

# ─── I2: --help exits 0 ──────────────────────────────────────────────────────
run "I2: --help exits 0" bash "$INSTALLER" --help

# ─── helpers: install with DARWIN forced ──────────────────────────────────────
_install() {
  rm -f "$LAUNCHCTL_LOG"
  CATALYST_FORCE_OS=Darwin bash "$INSTALLER" "$@"
}
DEST="${FAKE_HOME}/Library/LaunchAgents/ai.coalesce.catalyst-orphan-sweep.plist"

# ─── I3: no REPLACE_* tokens in installed plist ───────────────────────────────
_install
run "I3: no REPLACE_WITH_ABSOLUTE token in installed plist" \
  bash -c "! grep -q 'REPLACE_WITH_ABSOLUTE' '${DEST}'"
run "I3b: no REPLACE_HOME token in installed plist" \
  bash -c "! grep -q 'REPLACE_HOME' '${DEST}'"
run "I3c: no REPLACE_START_INTERVAL token in installed plist" \
  bash -c "! grep -q 'REPLACE_START_INTERVAL' '${DEST}'"

# ─── I4: installed plist passes plutil -lint (or SKIP) ───────────────────────
if command -v plutil >/dev/null 2>&1; then
  run "I4: installed plist passes plutil -lint" plutil -lint "$DEST"
else
  echo "  SKIP: I4: plutil not available on this platform"
  PASSES=$((PASSES+1))
fi

# ─── I5: ProgramArguments contains the real absolute orphan-sweep.sh path ────
SCRIPTS_DIR="$(cd "$(dirname "$INSTALLER")" && pwd)"
run "I5: ProgramArguments references absolute orphan-sweep.sh" \
  grep -q "${SCRIPTS_DIR}/orphan-sweep.sh" "$DEST"

# ─── I6: Standard*Path resolved to $HOME (no REPLACE_HOME) ─────────────────
run "I6: StandardOutPath references real HOME, no REPLACE_HOME" \
  bash -c "grep 'StandardOutPath' -A1 '${DEST}' | grep -q '${FAKE_HOME}'"

# ─── I7: interval map ────────────────────────────────────────────────────────

_install_with_config() {
  local config_json="$1"
  local proj="${SCRATCH}/proj_$RANDOM"
  mkdir -p "${proj}/.catalyst"
  printf '%s\n' "$config_json" > "${proj}/.catalyst/config.json"
  rm -f "$LAUNCHCTL_LOG"
  (cd "$proj" && CATALYST_FORCE_OS=Darwin bash "$INSTALLER")
}

_installed_interval() {
  grep 'StartInterval' -A1 "$DEST" | grep '<integer>' | grep -oE '[0-9]+'
}

_install_with_config '{"catalyst":{"sweep":{"intervalHours":1}}}'
run "I7a: intervalHours=1 -> StartInterval=3600" \
  bash -c "[[ \"$(_installed_interval)\" == '3600' ]]"

_install_with_config '{"catalyst":{"sweep":{"intervalHours":2}}}'
run "I7b: intervalHours=2 -> StartInterval=7200" \
  bash -c "[[ \"$(_installed_interval)\" == '7200' ]]"

_install_with_config '{"catalyst":{"sweep":{"intervalHours":3}}}'
run "I7c: intervalHours=3 -> StartInterval=10800" \
  bash -c "[[ \"$(_installed_interval)\" == '10800' ]]"

# absent: should default to 1 → 3600
_install_with_config '{"catalyst":{}}'
run "I7d: intervalHours absent -> StartInterval=3600 (default)" \
  bash -c "[[ \"$(_installed_interval)\" == '3600' ]]"

# out-of-range 5: clamp to 3 → 10800
_install_with_config '{"catalyst":{"sweep":{"intervalHours":5}}}'
run "I7e: intervalHours=5 (out-of-range) -> clamped to 3 -> StartInterval=10800" \
  bash -c "[[ \"$(_installed_interval)\" == '10800' ]]"

# ─── I8: launchctl invoked as bootout THEN bootstrap ─────────────────────────
rm -f "$LAUNCHCTL_LOG"
_install
BOOTOUT_LINE="$(grep -n 'bootout' "$LAUNCHCTL_LOG" 2>/dev/null | head -1 | cut -d: -f1)"
BOOTSTRAP_LINE="$(grep -n 'bootstrap' "$LAUNCHCTL_LOG" 2>/dev/null | head -1 | cut -d: -f1)"
run "I8a: launchctl bootout was called" bash -c "grep -q 'bootout' '${LAUNCHCTL_LOG}'"
run "I8b: launchctl bootstrap was called" bash -c "grep -q 'bootstrap' '${LAUNCHCTL_LOG}'"
run "I8c: bootout appears before bootstrap in log" \
  bash -c "[[ -n '${BOOTOUT_LINE}' && -n '${BOOTSTRAP_LINE}' && '${BOOTOUT_LINE}' -lt '${BOOTSTRAP_LINE}' ]]"
run "I8d: launchctl called with gui/<uid> domain (not a bare user)" \
  bash -c "grep -qE 'gui/[0-9]+' '${LAUNCHCTL_LOG}'"

# ─── I9: idempotent re-install: second run exits 0, DEST byte-identical ──────
_install
FIRST_HASH="$(md5 -q "$DEST" 2>/dev/null || md5sum "$DEST" 2>/dev/null | awk '{print $1}')"
_install
SECOND_HASH="$(md5 -q "$DEST" 2>/dev/null || md5sum "$DEST" 2>/dev/null | awk '{print $1}')"
run "I9: second install exits 0 and DEST is byte-identical" \
  bash -c "[[ '${FIRST_HASH}' == '${SECOND_HASH}' ]]"

# ─── I10: bootout failure tolerated ─────────────────────────────────────────
run "I10: bootout failure tolerated (bootstrap still runs)" \
  bash -c "MOCK_LAUNCHCTL_BOOTOUT_RC=1 CATALYST_FORCE_OS=Darwin bash '${INSTALLER}' && grep -q 'bootstrap' '${LAUNCHCTL_LOG}'"

# ─── I11: --uninstall boots out + removes DEST, idempotent ──────────────────
_install
rm -f "$LAUNCHCTL_LOG"
run "I11a: --uninstall exits 0" bash -c "CATALYST_FORCE_OS=Darwin bash '${INSTALLER}' --uninstall"
run "I11b: --uninstall removes DEST" bash -c "[[ ! -f '${DEST}' ]]"
run "I11c: --uninstall called launchctl bootout" \
  bash -c "grep -q 'bootout' '${LAUNCHCTL_LOG}'"
# second --uninstall is also safe
run "I11d: second --uninstall is idempotent (exits 0)" \
  bash -c "CATALYST_FORCE_OS=Darwin bash '${INSTALLER}' --uninstall"

# ─── I12: non-macOS -> follow-up notice, exits 0, no launchctl call ─────────
rm -f "$LAUNCHCTL_LOG"
run "I12a: CATALYST_FORCE_OS=linux -> exits 0" \
  bash -c "CATALYST_FORCE_OS=linux bash '${INSTALLER}'"
run "I12b: non-macOS -> no launchctl call" \
  bash -c "[[ ! -s '${LAUNCHCTL_LOG}' ]]"
run_output "I12c: non-macOS -> prints follow-up/notice message" \
  "follow-up|ctf|notice|linux|platform" \
  bash -c "CATALYST_FORCE_OS=linux bash '${INSTALLER}'"

# ─── results ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
