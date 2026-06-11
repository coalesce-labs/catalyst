#!/usr/bin/env bash
# CTL-722: both templates must ship a stateMap whose VALUES satisfy the
# execution-core contract (mirrors check-project-setup.sh:181-183).
#
# Run: bash plugins/dev/scripts/__tests__/config-template-statemap.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

echo "config-template-statemap tests (CTL-722)"

CONTRACT='["Todo","Research","Plan","Implement","Validate","PR"]'

for tmpl in "plugins/dev/templates/config.template.json" ".claude/config.template.json"; do
  run "template $tmpl: stateMap values satisfy contract" \
    bash -c "jq -e --argjson c '$CONTRACT' \
      '[.catalyst.linear.stateMap | to_entries[].value] as \$v
       | \$c | all(. as \$s | \$v | index(\$s))' '${REPO_ROOT}/$tmpl'"
  run "template $tmpl: stateMap has 12 keys" \
    bash -c "jq -e '.catalyst.linear.stateMap | keys | length == 12' '${REPO_ROOT}/$tmpl'"
  run "template $tmpl: no archived Ready value" \
    bash -c "! jq -e '[.catalyst.linear.stateMap | to_entries[].value] | index(\"Ready\")' '${REPO_ROOT}/$tmpl' >/dev/null"
done

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
