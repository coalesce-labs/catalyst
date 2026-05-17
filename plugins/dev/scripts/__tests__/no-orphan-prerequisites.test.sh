#!/usr/bin/env bash
# Regression test: plugins/dev/scripts/check-prerequisites.sh stays deleted (CTL-489).
# The dev plugin had no callers for this script — pm-ops and meta keep their own
# copies, which are used by their respective skills.
# Run: bash plugins/dev/scripts/__tests__/no-orphan-prerequisites.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FAILURES=0
PASSES=0

if [[ -f "$REPO_ROOT/plugins/dev/scripts/check-prerequisites.sh" ]]; then
  echo "  FAIL: plugins/dev/scripts/check-prerequisites.sh exists — should be deleted (CTL-489)"
  FAILURES=$((FAILURES+1))
else
  PASSES=$((PASSES+1))
  echo "  PASS: dev plugin's orphaned check-prerequisites.sh is absent"
fi

# pm-ops + meta copies must STILL be present (negative scope check — only the dev copy was orphaned)
for keep in plugins/pm-ops/scripts/check-prerequisites.sh plugins/meta/scripts/check-prerequisites.sh; do
  if [[ -f "$REPO_ROOT/$keep" ]]; then
    PASSES=$((PASSES+1))
    echo "  PASS: $keep is retained"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $keep was deleted but should be kept"
  fi
done

# plugins/dev/README.md should not list check-prerequisites.sh among the dev plugin's
# scripts (it was an orphaned entry — the dev plugin never invoked this script).
if grep -q 'check-prerequisites' "$REPO_ROOT/plugins/dev/README.md" 2>/dev/null; then
  FAILURES=$((FAILURES+1))
  echo "  FAIL: plugins/dev/README.md still references check-prerequisites"
else
  PASSES=$((PASSES+1))
  echo "  PASS: plugins/dev/README.md no longer references check-prerequisites"
fi

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
