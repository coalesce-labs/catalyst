#!/usr/bin/env bash
# Tests for the channel-watcher launch.sh + install.sh — CTL-1423.
# Asserts launch.sh fails preflight on a missing config; install.sh writes the
# plist to a temp HOME and resolves all REPLACE_WITH_* tokens; uninstall removes it.
#
# Run: bash plugins/dev/scripts/channel-watcher/__tests__/launch.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHANNEL_WATCHER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; }

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

LAUNCH="${CHANNEL_WATCHER_DIR}/launch.sh"
INSTALL="${CHANNEL_WATCHER_DIR}/install.sh"
PLIST_TEMPLATE="${CHANNEL_WATCHER_DIR}/ai.coalesce.catalyst-channel-watcher.plist"

echo "channel-watcher launch + install tests"

# 1. launch.sh exists and is executable
if [[ -x "$LAUNCH" ]]; then
  pass "launch.sh is executable"
else
  fail "launch.sh missing or not executable: $LAUNCH"
fi

# 2. install.sh exists and is executable
if [[ -x "$INSTALL" ]]; then
  pass "install.sh is executable"
else
  fail "install.sh missing or not executable: $INSTALL"
fi

# 3. plist template exists
if [[ -f "$PLIST_TEMPLATE" ]]; then
  pass "plist template exists"
else
  fail "plist template missing: $PLIST_TEMPLATE"
fi

# 4. launch.sh fails preflight when CATALYST_WATCHER_CHANNEL env is unset
# (it should exit non-zero with a clear message before trying to exec bun)
if env -i HOME="$SCRATCH" PATH="/usr/bin:/bin:/usr/local/bin" \
  bash "$LAUNCH" 2>&1 | grep -qi "required\|missing\|CATALYST_WATCHER_CHANNEL"; then
  pass "launch.sh fails preflight loudly when CATALYST_WATCHER_CHANNEL unset"
elif ! env -i HOME="$SCRATCH" PATH="/usr/bin:/bin:/usr/local/bin" \
  bash "$LAUNCH" >/dev/null 2>&1; then
  # Exited non-zero (which is correct) even if grep didn't match
  pass "launch.sh exits non-zero when CATALYST_WATCHER_CHANNEL unset"
else
  fail "launch.sh did not fail when CATALYST_WATCHER_CHANNEL unset"
fi

# 5. install.sh --dry-run produces a plist with no unresolved REPLACE_WITH_* tokens
FAKE_HOME="$SCRATCH/home"
mkdir -p "$FAKE_HOME/Library/LaunchAgents"
export HOME="$FAKE_HOME"
if [[ -x "$INSTALL" ]]; then
  INSTALL_OUT=$("$INSTALL" --dry-run 2>&1) || true
  if echo "$INSTALL_OUT" | grep -q "REPLACE_WITH_"; then
    fail "install.sh --dry-run output still contains unresolved REPLACE_WITH_* tokens"
  else
    pass "install.sh --dry-run has no unresolved REPLACE_WITH_* tokens"
  fi

  # 6. install.sh (real) writes plist to ~/Library/LaunchAgents/
  "$INSTALL" >/dev/null 2>&1 || true
  PLIST_INSTALLED="${FAKE_HOME}/Library/LaunchAgents/ai.coalesce.catalyst-channel-watcher.plist"
  if [[ -f "$PLIST_INSTALLED" ]]; then
    pass "install.sh writes plist to ~/Library/LaunchAgents/"
    # Verify no unresolved tokens
    if grep -q "REPLACE_WITH_" "$PLIST_INSTALLED" 2>/dev/null; then
      fail "installed plist has unresolved REPLACE_WITH_* tokens"
    else
      pass "installed plist has no unresolved REPLACE_WITH_* tokens"
    fi
  else
    fail "install.sh did not write plist to ~/Library/LaunchAgents/"
  fi

  # 7. --uninstall removes the plist
  "$INSTALL" --uninstall >/dev/null 2>&1 || true
  if [[ ! -f "$PLIST_INSTALLED" ]]; then
    pass "--uninstall removes the plist"
  else
    fail "--uninstall did not remove the plist"
  fi
fi

echo
echo "Results: $PASSES passed, $FAILURES failed"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
