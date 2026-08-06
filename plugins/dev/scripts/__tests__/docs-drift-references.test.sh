#!/usr/bin/env bash
# Smoke test: docs reference the new config-drift flow (CTL-489).
# Run: bash plugins/dev/scripts/__tests__/docs-drift-references.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FAILURES=0
PASSES=0

assert_doc_has() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$REPO_ROOT/$file"; then
    PASSES=$((PASSES+1)); echo "  PASS: $label"
  else
    FAILURES=$((FAILURES+1)); echo "  FAIL: $label (missing in $file): $needle"
  fi
}

assert_doc_has "orchestrator-overview mentions check-config-drift.sh" \
  "docs/orchestrator-overview.md" "check-config-drift.sh"
assert_doc_has "setup-health-check doc covers Config-template drift" \
  "website/src/content/docs/reference/setup-health-check.md" "Config-template drift"
assert_doc_has "configuration ref links to drift behavior" \
  "website/src/content/docs/reference/configuration.md" "check-config-drift.sh"
# CTL-665: the configuration reference documents the committed execution-core
# worker-slot concurrency knob.
assert_doc_has "configuration ref documents executionCore.maxParallel (CTL-665)" \
  "website/src/content/docs/reference/configuration.md" "executionCore.maxParallel"
# CTL-1488: the configuration reference documents the coordination-substrate rollout knobs.
assert_doc_has "configuration ref documents CATALYST_COORDINATION_MODE (CTL-1488)" \
  "website/src/content/docs/reference/configuration.md" "CATALYST_COORDINATION_MODE"
assert_doc_has "configuration ref documents catalyst.coordination.hubUrl (CTL-1488)" \
  "website/src/content/docs/reference/configuration.md" "catalyst.coordination.hubUrl"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
