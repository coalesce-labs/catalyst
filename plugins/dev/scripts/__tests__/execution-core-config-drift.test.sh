#!/usr/bin/env bash
# Tests config.template.json's orchestration config surface so check-config-drift.sh
# has a structural baseline.
#
# CTL-582 (D4) removed the per-repo executionCore *eligibleQuery* — enrolled
# projects live in the central registry.json — so the template must never carry
# eligibleQuery back in.
#
# CTL-665 refined this guard: the template's executionCore now DOES carry the
# committed worker-slot concurrency knobs (maxParallel/minParallel/
# maxParallelCeiling), which are legitimately templated config (unlike the
# central eligibleQuery). The guard's real intent is preserved by asserting
# executionCore carries the three concurrency keys AND explicitly does NOT carry
# eligibleQuery, plus that the committed default maxParallel stays 4.
# Run: bash plugins/dev/scripts/__tests__/execution-core-config-drift.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TEMPLATE="${REPO_ROOT}/plugins/dev/templates/config.template.json"
PROJECT_CONFIG="${REPO_ROOT}/.catalyst/config.json"

FAILURES=0
PASSES=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
  fi
}

echo "execution-core config drift tests"

check "config.template.json exists" test -f "$TEMPLATE"

check "template carries orchestration.dispatchMode" \
  jq -e '.catalyst.orchestration.dispatchMode' "$TEMPLATE"

# CTL-665: the template's executionCore carries the three committed concurrency
# knobs (the legitimately-templated worker-slot config).
check "template executionCore carries maxParallel/minParallel/maxParallelCeiling" \
  jq -e '.catalyst.orchestration.executionCore
         | .maxParallel and .minParallel and .maxParallelCeiling' "$TEMPLATE"

# CTL-582 (D4) intent preserved: eligibleQuery is central (registry.json), so the
# template's executionCore must NOT carry it back in.
check "template executionCore does NOT carry eligibleQuery (CTL-582 intent)" \
  jq -e '.catalyst.orchestration.executionCore | has("eligibleQuery") | not' "$TEMPLATE"

# CTL-665: the committed default stays 4 (the operator bump to 10 is gated on
# CTL-661/662/663 and is a separate config edit, not this plumbing).
check "project config executionCore.maxParallel equals the documented default 4" \
  jq -e '.catalyst.orchestration.executionCore.maxParallel == 4' "$PROJECT_CONFIG"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILURES" = 0 ]; then
  echo "All $PASSES tests passed"
  exit 0
else
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
