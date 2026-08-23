#!/usr/bin/env bash
# Tests config.template.json's orchestration config surface so check-config-drift.sh
# has a structural baseline.
#
# CTL-582 (D4) removed the per-repo executionCore *eligibleQuery* — enrolled
# projects live in the central registry.json — so the template must never carry
# eligibleQuery back in.
#
# CTL-665 refined this guard: the template's executionCore then DID carry the
# committed worker-slot concurrency knobs (maxParallel/minParallel/
# maxParallelCeiling), asserted alongside the absence of eligibleQuery.
#
# ⚠️ CTL-1214 INVERTS the first half. `orchestration.{dispatchMode,executionCore}`
# are node-scoped and have relocated to ~/.config/catalyst/node.json, so a
# template or committed config that still carries them is now the DEFECT, not the
# baseline. The three assertions written for the old contract went red the moment
# the slimming landed — and because this suite is not on the CI allowlist
# (execution-core-tests.yml runs an explicit list, no glob runner), nothing
# surfaced it. The checks below assert the CURRENT contract, and each one is
# paired with a positive control so an absent/unreadable file can never be read as
# a clean pass: `jq -e ... | not` returns true for BOTH "key absent" and "file
# absent", which is exactly how the old eligibleQuery check kept reporting PASS
# after the stanza it inspected had ceased to exist.
#
# CTL-582 (D4)'s intent — eligibleQuery is central (registry.json) and must never
# be templated back in — survives the relocation and is asserted at both layers.
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
check "project .catalyst/config.json exists" test -f "$PROJECT_CONFIG"

# POSITIVE CONTROLS. Every assertion below is an ABSENCE, and an absence over an
# unreadable file is not evidence. Prove jq really parses each file first, by
# reading a key that must be there.
check "positive control: jq reads the template (linear.teamKey present)" \
  jq -e '.catalyst.linear.teamKey' "$TEMPLATE"
check "positive control: jq reads the project config (linear.teamKey present)" \
  jq -e '.catalyst.linear.teamKey' "$PROJECT_CONFIG"

# CTL-1214: both relocated node-scoped orchestration stanzas must be GONE from
# the shipped template — it is what every new repo starts from, so one left here
# re-leaks into every future config no matter how well the migration works.
check "template does NOT carry orchestration.dispatchMode (relocated, CTL-1214)" \
  jq -e '.catalyst.orchestration.dispatchMode == null' "$TEMPLATE"

check "template does NOT carry orchestration.executionCore (relocated, CTL-1214)" \
  jq -e '.catalyst.orchestration.executionCore == null' "$TEMPLATE"

# CTL-582 (D4) intent, restated for the post-relocation world: eligibleQuery is
# central (registry.json) and is DROPPED by the migration, never re-homed — so it
# must not appear anywhere under catalyst.orchestration in either file.
check "template carries no eligibleQuery anywhere under orchestration (CTL-582)" \
  jq -e '[.catalyst.orchestration // {} | .. | objects | has("eligibleQuery")] | any | not' "$TEMPLATE"

check "project config carries no eligibleQuery anywhere under orchestration (CTL-582)" \
  jq -e '[.catalyst.orchestration // {} | .. | objects | has("eligibleQuery")] | any | not' "$PROJECT_CONFIG"

# CTL-1214: the committed config is project identity only. maxParallel's operator
# value now lives in node.json (re-homed to executionCore.targetParallel, since a
# node.json maxParallel would shadow the autotuner's runtime mirror).
check "project config does NOT carry orchestration.executionCore (slimmed, CTL-1214)" \
  jq -e '.catalyst.orchestration.executionCore == null' "$PROJECT_CONFIG"

check "project config declares schemaVersion >= 1 (opted into the slimmed contract)" \
  jq -e '(.catalyst.schemaVersion | type == "number") and (.catalyst.schemaVersion >= 1)' "$PROJECT_CONFIG"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILURES" = 0 ]; then
  echo "All $PASSES tests passed"
  exit 0
else
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
