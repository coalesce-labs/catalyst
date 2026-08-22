#!/usr/bin/env bash
# architecture-armsecret-claim.test.sh — CTL-2147. docs/architecture.md used to state
# "No production call site invokes armSecret today", which was already false (daemon.mjs
# calls it live at three sites) and is the exact premise CTL-2147 builds on (SIGHUP triggers
# one of those calls on demand). This is always-loaded context (@docs/architecture.md), so a
# stale claim there actively misleads the next agent — guard it with a grep assertion.
#
# Run: bash plugins/dev/scripts/__tests__/architecture-armsecret-claim.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DOC="${REPO_ROOT}/docs/architecture.md"
DAEMON="${REPO_ROOT}/plugins/dev/scripts/execution-core/daemon.mjs"

FAILURES=0
PASSES=0
ok() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail_t() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
check() {
  local name="$1"; shift
  if "$@"; then ok "$name"; else fail_t "$name"; fi
}

echo "architecture.md armSecret claim (CTL-2147) tests"

t_no_stale_armsecret_claim() {
  ! /usr/bin/grep -q "No production call site invokes .armSecret. today" "$DOC"
}
check "architecture.md no longer claims armSecret has no production caller" t_no_stale_armsecret_claim

t_armsecret_callers_are_real() {
  # Positive control: the claim was false because these callers exist. Assert they do, so
  # this test fails loudly if the callers are ever removed rather than silently blessing a
  # doc that would then be correct again.
  [[ "$(/usr/bin/grep -c 'armSecret(' "$DAEMON")" -ge 3 ]]
}
check "daemon.mjs retains its armSecret call sites (positive control)" t_armsecret_callers_are_real

t_doc_mentions_soft_rotation() {
  /usr/bin/grep -q -- "--soft" "$DOC"
}
check "architecture.md documents claude-account switch/sync --soft" t_doc_mentions_soft_rotation

echo ""
TOTAL=$((PASSES + FAILURES))
echo "architecture-armsecret-claim: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
