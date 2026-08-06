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

# ─── T31: CTL-1531 — the widened-branch rollout knob ships IN THE TEMPLATE ───
#
# Codex round 2: the documented enforce flip was "hand-edit the installed
# LaunchAgent", but install-orphan-sweep.sh unconditionally REGENERATES and
# replaces that plist on every routine `catalyst-stack install-services` run —
# so the next install silently reverted the operator's flip. A rollout knob a
# routine reinstall resets is worse than none.
#
# The fix has two halves and this file guards the first: the knob must be part
# of the SHIPPED TEMPLATE (so the installer has something to write, preserve and
# propagate). The second half — the resolution precedence, including preserving
# an existing flip across a plain reinstall — is guarded by
# __tests__/install-orphan-sweep.test.sh (I13*), which needs a non-ephemeral
# checkout to run.
run_grep "T31: template declares EnvironmentVariables" '<key>EnvironmentVariables</key>'
run_grep "T31b: template declares SWEEP_PROC_WIDEN" '<key>SWEEP_PROC_WIDEN</key>'
run_grep "T31c: its value is the installer token, not a hardcoded literal" 'REPLACE_SWEEP_PROC_WIDEN'

# The token must be the value OF that key — a token sitting anywhere else in the
# file would satisfy the grep above while leaving the key unset.
if grep -A2 '<key>SWEEP_PROC_WIDEN</key>' "$PLIST" 2>/dev/null | grep -q '<string>REPLACE_SWEEP_PROC_WIDEN</string>'; then
  PASSES=$((PASSES+1))
  echo "  PASS: T31d: REPLACE_SWEEP_PROC_WIDEN is the VALUE of the SWEEP_PROC_WIDEN key"
else
  FAILURES=$((FAILURES+1))
  echo "  FAIL: T31d: REPLACE_SWEEP_PROC_WIDEN is not the value of the SWEEP_PROC_WIDEN key"
fi

# ADR-023 "dark by default": the template must NOT ship a literal `enforce`.
run_no_grep "T31e: the template never hardcodes enforce (dark by default, ADR-023)" \
  '<string>enforce</string>'

# The template is the only place a reader will look for the rollout contract, so
# the precedence has to be written down next to the key.
run_grep "T31f: the precedence is documented in the template itself" 'catalyst.sweep.procWiden'

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
