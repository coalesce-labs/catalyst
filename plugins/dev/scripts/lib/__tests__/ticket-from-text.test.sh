#!/usr/bin/env bash
# Unit tests for plugins/dev/scripts/lib/ticket-from-text.sh (CTL-2306).
#
# Subject: catalyst_ticket_from_text, the one branch-name → ticket rule
# catalyst-claude.sh uses. CTL-2306 removed the workflow-context fallback that
# used to supply an uppercased ticket for lowercase branches (worktree init
# stored it), so the branch match itself must now be case-insensitive and
# normalized — otherwise `ryan/ctl-26-feature` starts sessions with no ticket
# and loses DB/telemetry attribution (Codex review on #4132).
#
# The rule mirrors resolve-ticket.sh: an uppercase match wins, else the FIRST
# case-insensitive match, uppercased. First, not last: `ryan/ctl-26-phase-2`
# names CTL-26, not PHASE-2.
#
# Run: bash plugins/dev/scripts/lib/__tests__/ticket-from-text.test.sh
# Bash-3.2 safe.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../ticket-from-text.sh"
WRAPPER="${SCRIPT_DIR}/../../catalyst-claude.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

[ -f "$WRAPPER" ] || { echo "FATAL: subject not found: $WRAPPER" >&2; exit 1; }
if [ ! -f "$HELPER" ]; then
  fail "lib/ticket-from-text.sh exists" "not found: $HELPER"
  echo ""
  echo "PASS: $PASS  FAIL: $FAIL"
  exit 1
fi
# shellcheck source=../ticket-from-text.sh
. "$HELPER"

expect() {
  local input="$1" want="$2" got
  got="$(catalyst_ticket_from_text "$input")"
  if [ "$got" = "$want" ]; then
    ok "'${input}' → '${want}'"
  else
    fail "'${input}' → '${want}'" "got '${got}'"
  fi
}

echo "catalyst_ticket_from_text (CTL-2306)"
expect "feature/CTL-2306-dev-bundle" "CTL-2306"
expect "ryan/ctl-26-feature" "CTL-26"
expect "ryan/ctl-26-phase-2" "CTL-26"
expect "orch-data-import-ADV-220" "ADV-220"
expect "CTL-2306" "CTL-2306"
expect "main" ""
expect "" ""

echo ""
echo "catalyst-claude.sh uses the shared rule for its branch ticket"
if grep -qF 'catalyst_ticket_from_text "$BRANCH"' "$WRAPPER"; then
  ok "catalyst-claude.sh derives TICKET via catalyst_ticket_from_text"
else
  fail "catalyst-claude.sh derives TICKET via catalyst_ticket_from_text" "the wrapper still uses its own case-sensitive regex"
fi

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
