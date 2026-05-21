#!/usr/bin/env bash
# Shape test for the CTL-564 Phase 5 config-template + documentation updates.
# Asserts the config template stays valid JSON and the reference docs document
# the central registry and the execution-core stateMap collapse.
#
# Run: bash plugins/dev/scripts/__tests__/execution-core-docs-shape.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

TEMPLATE="${REPO_ROOT}/plugins/dev/templates/config.template.json"
CONFIG_DOC="${REPO_ROOT}/website/src/content/docs/reference/configuration.md"
ARCH_DOC="${REPO_ROOT}/docs/architecture.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; }

check() {
  # check <name> <test-command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}

echo "execution-core docs shape tests"

# Template: jq-stripped (comments removed) must be valid JSON.
check "config.template.json is valid JSON" jq -e . "$TEMPLATE"

# Template: the executionCore _comment mentions the contract Ready state.
check "template executionCore comment mentions the contract" \
  grep -qi "execution-core state contract\|registry" "$TEMPLATE"

# configuration.md: documents the central registry.
check "configuration.md documents registry.json" \
  grep -qF "registry.json" "$CONFIG_DOC"

# configuration.md: documents the execution-core stateMap collapse.
check "configuration.md documents the execution-core state contract" \
  grep -qiE "execution-core state contract|9-phase" "$CONFIG_DOC"

# configuration.md: documents the new check-project-setup execution-core check.
check "configuration.md mentions the check-project-setup execution-core check" \
  grep -qF "setup-execution-core-states.sh" "$CONFIG_DOC"

# architecture.md: notes the registry as the D4/D8/D9 seam.
check "architecture.md documents the execution-core registry" \
  grep -qF "execution-core/registry.json" "$ARCH_DOC"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
