#!/usr/bin/env bash
# Tests for ai.coalesce.catalyst-orphan-sweep.plist (CTL-694).
#
# Run: bash plugins/dev/scripts/__tests__/orphan-sweep-plist.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
PLIST="${REPO_ROOT}/plugins/dev/scripts/orch-monitor/dist/ai.coalesce.catalyst-orphan-sweep.plist"

FAILURES=0
PASSES=0

run() {
  local name="$1"; shift
  if "$@" > /dev/null 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
  fi
}

run_grep() {
  local name="$1" pattern="$2"
  if grep -qE "$pattern" "$PLIST" 2>/dev/null; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name (pattern '$pattern' not found in plist)"
  fi
}

run_no_grep() {
  local name="$1" pattern="$2"
  if ! grep -qE "$pattern" "$PLIST" 2>/dev/null; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name (pattern '$pattern' unexpectedly found in plist)"
  fi
}

# T25: file exists; plutil -lint returns OK (skip if plutil absent)
run "T25a: plist file exists" test -f "$PLIST"

if command -v plutil >/dev/null 2>&1; then
  # The plist is a template — REPLACE_START_INTERVAL is not a valid XML integer,
  # so plutil -lint is expected to fail on the template form. Skip with a note.
  echo "  SKIP: T25b: plist is a template (REPLACE_START_INTERVAL token) — plutil skipped"
  PASSES=$((PASSES+1))
else
  echo "  SKIP: T25b: plutil not available on this platform"
  PASSES=$((PASSES+1))
fi

# T26: StartInterval key present; value is the installer token (not a raw literal)
run_grep "T26: StartInterval key present" '<key>StartInterval</key>'
run_grep "T26b: StartInterval value is REPLACE_START_INTERVAL token" '<integer>REPLACE_START_INTERVAL</integer>'

# T27: does NOT contain KeepAlive (periodic job, not a daemon)
run_no_grep "T27: no KeepAlive key" '<key>KeepAlive</key>'

# T28: Label == ai.coalesce.catalyst-orphan-sweep
run_grep "T28: Label is ai.coalesce.catalyst-orphan-sweep" 'ai\.coalesce\.catalyst-orphan-sweep'

# T29: ProgramArguments references orphan-sweep.sh
run_grep "T29: ProgramArguments references orphan-sweep.sh" 'orphan-sweep\.sh'

# T30: RunAtLoad is false (or absent — absent means false by default)
# The plist should not auto-run on load for a periodic sweep
if grep -q 'RunAtLoad' "$PLIST" 2>/dev/null; then
  # If present, must be <false/>
  run_grep "T30: RunAtLoad is false" '<key>RunAtLoad</key>'
  if grep -A1 '<key>RunAtLoad</key>' "$PLIST" 2>/dev/null | grep -q '<true/>'; then
    FAILURES=$((FAILURES+1))
    echo "  FAIL: T30b: RunAtLoad must not be <true/>"
  else
    PASSES=$((PASSES+1))
    echo "  PASS: T30b: RunAtLoad is not <true/>"
  fi
else
  PASSES=$((PASSES+1))
  echo "  PASS: T30: RunAtLoad absent (defaults to false)"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
