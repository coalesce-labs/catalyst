#!/usr/bin/env bash
# CTL-846: assert docs + template warn against sourcing execution-core.env interactively.
# Run: bash plugins/dev/scripts/__tests__/execution-core-proxy-docs.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TEMPLATE="${REPO_ROOT}/plugins/dev/templates/execution-core.env.example"
CONFIG_DOC="${REPO_ROOT}/docs/configuration.md"

FAILURES=0; PASSES=0
pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; }

grep -qi 'do not[^\n]*source\|never[^\n]*source\|not.*interactive shell' "$TEMPLATE" \
  && pass "template warns against interactive sourcing" \
  || fail "template warns against interactive sourcing"

grep -qi 'interactive shell' "$CONFIG_DOC" \
  && pass "configuration.md warns against interactive sourcing" \
  || fail "configuration.md warns against interactive sourcing"

echo ""; echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
