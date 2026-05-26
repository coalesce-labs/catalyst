#!/usr/bin/env bash
# CTL-618: phase-emit-complete.sh must be sourceable AND runnable under zsh, not
# just bash. The existing phase-agent-emit-complete.test.sh sources the lib under
# `bash -c`, so it cannot catch the zsh-only failures (BASH_SOURCE unset →
# sibling-source 127; `local status` → read-only collision). This test drives the
# lib through `zsh -c` from a foreign cwd to reproduce + guard both.
#
# Run: bash plugins/dev/scripts/__tests__/phase-emit-complete-zsh.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/phase-emit-complete.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-emit-zsh-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
assert_eq() {
  if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 — expected '$1', got '$2'"; fi
}

[[ -f "$LIB" ]] || { echo "FATAL: lib missing at $LIB" >&2; exit 1; }

if ! command -v zsh >/dev/null 2>&1; then
  echo "SKIP: zsh not available on this host — zsh source-safety not exercised"
  exit 0
fi

# Run the lib under zsh from a foreign cwd ("/"), the exact condition that broke:
# BASH_SOURCE is unset for sourced files under zsh, so a bare ${BASH_SOURCE[0]}
# would resolve to "/" and fail to find the sibling.
run_under_zsh() {  # $1 = events file ; emits one phase event
  # set -uo pipefail mirrors the real consumer skill bodies (phase-triage /
  # phase-monitor-deploy run under `set -u`); without it, an un-renamed bare
  # $status would silently use zsh's $? special var instead of erroring.
  ( cd / && CATALYST_EVENTS_FILE="$1" \
      CATALYST_ORCHESTRATOR_ID="orch-zsh" CATALYST_SESSION_ID="sess_zsh" \
      zsh -c "set -uo pipefail; . '$LIB' && emit_phase_complete --phase triage --ticket CTL-618 --status complete" ) 2>&1
}

echo "Test 1: lib sources + emits cleanly under zsh from a foreign cwd"
EVENTS="${SCRATCH}/zsh-emit.jsonl"
OUT="$(run_under_zsh "$EVENTS")"; RC=$?
assert_eq "0" "$RC" "emit_phase_complete returns 0 under zsh"
if [[ "$OUT" == *"read-only variable: status"* ]]; then
  fail "no 'read-only variable: status' error under zsh — got: $OUT"
else
  pass "no 'read-only variable: status' error under zsh"
fi
if [[ "$OUT" == *"no such file or directory"*canonical-event* || "$OUT" == *"canonical-event.sh"*"no such file"* ]]; then
  fail "sibling canonical-event.sh resolved under zsh — got: $OUT"
else
  pass "sibling canonical-event.sh resolved under zsh"
fi
if [[ -s "$EVENTS" ]]; then
  EVENT_NAME="$(jq -r '.attributes."event.name"' "$EVENTS" | tail -n 1)"
  assert_eq "phase.triage.complete.CTL-618" "$EVENT_NAME" "zsh emit wrote canonical phase event"
else
  fail "zsh emit wrote no event line to $EVENTS"
fi

echo ""
echo "Test 2 (regression): lib still sources + emits cleanly under bash from a foreign cwd"
# set -uo pipefail mirrors the real skill-body invocation. This is the path that
# catches a bare $status left un-renamed: under bash `set -u`, $status is an
# unbound variable (unlike zsh, where $status is always defined as $?).
EVENTS_B="${SCRATCH}/bash-emit.jsonl"
BASH_OUT="$( cd / && CATALYST_EVENTS_FILE="$EVENTS_B" CATALYST_ORCHESTRATOR_ID="orch-bash" \
    CATALYST_SESSION_ID="sess_bash" \
    bash -c "set -uo pipefail; . '$LIB' && emit_phase_complete --phase triage --ticket CTL-618 --status complete" 2>&1 )"
if [[ "$BASH_OUT" == *"unbound variable"* ]]; then
  fail "no 'unbound variable' under bash set -u — got: $BASH_OUT"
else
  pass "no 'unbound variable' under bash set -u"
fi
if [[ -s "$EVENTS_B" ]]; then
  EVENT_NAME_B="$(jq -r '.attributes."event.name"' "$EVENTS_B" | tail -n 1)"
  assert_eq "phase.triage.complete.CTL-618" "$EVENT_NAME_B" "bash emit still writes canonical phase event"
else
  fail "bash emit wrote no event line (regression)"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "phase-emit-complete-zsh: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -gt 0 ]] && exit 1
exit 0
