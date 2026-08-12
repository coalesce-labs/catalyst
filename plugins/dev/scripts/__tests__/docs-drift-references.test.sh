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

# CAT-73: the inverse — a claim a doc must NO LONGER make. A corrected statement is only
# corrected once the wrong one is gone; assert_doc_has alone cannot see a leftover copy.
assert_doc_lacks() {
  local label="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$REPO_ROOT/$file"; then
    FAILURES=$((FAILURES+1)); echo "  FAIL: $label (still present in $file): $needle"
  else
    PASSES=$((PASSES+1)); echo "  PASS: $label"
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

# CAT-73: the seed-before-flip runbook must name the RESOLVED token variable, not
# hardcode CATALYST_CLOUD_TOKEN — a host using the escape hatch is left unauthenticated.
assert_doc_has "configuration runbook names the resolved token variable (CAT-73)" \
  "website/src/content/docs/reference/configuration.md" 'TOKEN_VAR='
assert_doc_has "configuration runbook cross-links the token-name escape hatch (CAT-73)" \
  "website/src/content/docs/reference/configuration.md" 'CATALYST_CLOUD_TOKEN_ENV'
# CAT-73: the documented pre-flip seed condition must require the sync_meta cursor, not
# just issues rows — both production readers do (replica_fresh, SEED_COMPLETE_SELECT).
assert_doc_has "linear-replica seed condition requires the sync_meta cursor (CAT-73)" \
  "docs/linear-replica.md" "key='cursor'"
assert_doc_has "linear-replica routes the seed check through verify-cloud-sync (CAT-73)" \
  "docs/linear-replica.md" "verify-cloud-sync"
# CAT-73: service_namespace is a stream label too (AGENTS.md is the authority).
assert_doc_has "linear-replica names service_namespace a stream label (CAT-73)" \
  "docs/linear-replica.md" "service_namespace"
assert_doc_lacks "linear-replica no longer claims service_name is the only stream label (CAT-73)" \
  "docs/linear-replica.md" "is the only stream label"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
