#!/usr/bin/env bash
# CTL-764: smoke test that the two-axis model docs are present.
# Run: bash plugins/dev/scripts/__tests__/ctl-764-docs.test.sh
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

assert_doc_has_re() {
  local label="$1" file="$2" pattern="$3"
  if grep -qiE -- "$pattern" "$REPO_ROOT/$file"; then
    PASSES=$((PASSES+1)); echo "  PASS: $label"
  else
    FAILURES=$((FAILURES+1)); echo "  FAIL: $label (regex not found in $file): $pattern"
  fi
}

# event-schema.md: worker.transition event registered
assert_doc_has "event-schema.md registers worker.transition" \
  "plugins/dev/references/event-schema.md" "worker.transition"

# event-schema.md: catalyst.worker.to_disposition attribute documented
assert_doc_has "event-schema.md names catalyst.worker.to_disposition" \
  "plugins/dev/references/event-schema.md" "catalyst.worker.to_disposition"

# architecture.md: two-axis model documented
assert_doc_has_re "architecture.md documents two orthogonal axes" \
  "docs/architecture.md" "two.axis|two-axis|two orthogonal"

# architecture.md: recordWorkerTransition documented
assert_doc_has "architecture.md mentions recordWorkerTransition" \
  "docs/architecture.md" "recordWorkerTransition"

# architecture.md: resolution-gated clearing documented
assert_doc_has_re "architecture.md documents resolution-gated clearing" \
  "docs/architecture.md" "resolution-gated|tick.?converge"

# adrs.md: ADR-026 registered (next available after ADR-025; ADR-022 is the belief engine)
assert_doc_has "adrs.md contains ADR-026" \
  "docs/adrs.md" "ADR-026"

# adrs.md: worker-status mentioned in ADR-026
assert_doc_has "adrs.md names worker-status in ADR-026 context" \
  "docs/adrs.md" "worker-status"

# configuration.md: worker-status labels section
assert_doc_has "configuration.md references worker-status group" \
  "website/src/content/docs/reference/configuration.md" "worker-status"

# configuration.md: setup-execution-core-states.sh referenced
assert_doc_has "configuration.md references setup-execution-core-states.sh" \
  "website/src/content/docs/reference/configuration.md" "setup-execution-core-states.sh"

# operator page exists and names all four disposition values
OPERATOR_PAGE="website/src/content/docs/autonomous-workflow/worker-status-labels.md"
assert_doc_has "operator page names queued disposition" \
  "$OPERATOR_PAGE" "queued"
assert_doc_has "operator page names blocked disposition" \
  "$OPERATOR_PAGE" "blocked"
assert_doc_has "operator page names needs-input disposition" \
  "$OPERATOR_PAGE" "needs-input"
assert_doc_has "operator page names needs-human disposition" \
  "$OPERATOR_PAGE" "needs-human"

# config.template.json is valid JSON
CONFIG_TEMPLATE="plugins/dev/templates/config.template.json"
if [ -f "$REPO_ROOT/$CONFIG_TEMPLATE" ]; then
  if jq -e . "$REPO_ROOT/$CONFIG_TEMPLATE" >/dev/null 2>&1; then
    PASSES=$((PASSES+1)); echo "  PASS: config.template.json is valid JSON"
  else
    FAILURES=$((FAILURES+1)); echo "  FAIL: config.template.json is not valid JSON"
  fi
else
  PASSES=$((PASSES+1)); echo "  PASS: config.template.json not present (skipped)"
fi

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
