#!/usr/bin/env bash
# CTL-633: doc-invariant tests. Cheap grep-only assertions on the helper
# header and the linearis SKILL.md so the next-developer-touching-this can
# discover the two-mode design and the cache-refresh one-liner.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

echo "Test: linearis SKILL.md mentions the linear-team-keys cache file"
if grep -q 'linear-team-keys.json' "$REPO_ROOT/plugins/dev/skills/linearis/SKILL.md"; then
	pass "linearis SKILL.md references linear-team-keys.json"
else
	fail "linearis SKILL.md references linear-team-keys.json"
fi

echo "Test: linear-pr-skip.sh header documents both modes"
HELPER="$REPO_ROOT/plugins/dev/scripts/lib/linear-pr-skip.sh"
if grep -q 'linear_foreign_tokens_from_branch' "$HELPER" \
		&& grep -q 'linear_foreign_tokens_from_body' "$HELPER"; then
	pass "linear-pr-skip.sh documents both _from_branch and _from_body"
else
	fail "linear-pr-skip.sh documents both modes"
fi

echo "Test: linear-team-keys.sh header documents the manual refresh one-liner"
TK="$REPO_ROOT/plugins/dev/scripts/lib/linear-team-keys.sh"
if grep -q 'linearis teams list --json' "$TK"; then
	pass "linear-team-keys.sh documents refresh via linearis"
else
	fail "linear-team-keys.sh documents refresh via linearis"
fi

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
