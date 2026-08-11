#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RUNBOOK="$REPO_ROOT/docs/runbooks/linear-app-actor-secret-rotation.md"
ARCHITECTURE="$REPO_ROOT/docs/architecture.md"
CONFIGURATION="$REPO_ROOT/website/src/content/docs/reference/configuration.md"
FAILURES=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }
assert_file() { [[ -f "$1" ]] && pass "$2" || fail "$2"; }
assert_contains() { grep -Fq -- "$2" "$1" && pass "$3" || fail "$3"; }

assert_file "$RUNBOOK" "rotation runbook exists"
if [[ -f "$RUNBOOK" ]]; then
  [[ "$(sed -n '1p' "$RUNBOOK")" == "---" ]] && pass "runbook has frontmatter" || fail "runbook has frontmatter"
  for actor in orchestrator worker linearis; do
    assert_contains "$RUNBOOK" "$actor" "runbook names $actor actor"
  done
  assert_contains "$RUNBOOK" "--verify-app-actors" "runbook contains verification command"
  assert_contains "$RUNBOOK" "cluster-bots.sops.json" "runbook covers SOPS distribution"
  assert_contains "$RUNBOOK" '~/.config/catalyst/config.json' "runbook covers node-local distribution"
fi
assert_contains "$ARCHITECTURE" "linear-app-actor-secret-rotation" "architecture links the runbook"
assert_contains "$CONFIGURATION" "linear-app-actor-secret-rotation" "configuration reference links the runbook"

if [[ "$FAILURES" -gt 0 ]]; then
  printf '%s assertion(s) failed\n' "$FAILURES" >&2
  exit 1
fi
printf 'All rotation runbook assertions passed.\n'
