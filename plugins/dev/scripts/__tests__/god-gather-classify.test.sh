#!/usr/bin/env bash
# Tests for god-gather.sh — classify_worktree() function (CTL-373).
# Run: bash plugins/dev/scripts/__tests__/god-gather-classify.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
GOD="${REPO_ROOT}/plugins/dev/scripts/god-gather.sh"

# god-gather.sh runs work at top level when sourced. Extract just the
# classify_worktree() function body and eval it in a fresh subshell.

FN_BODY=$(awk '/^classify_worktree\(\) \{/,/^}/' "$GOD")
if [[ -z $FN_BODY ]]; then
	echo "FAIL: could not extract classify_worktree from $GOD" >&2
	exit 1
fi

classify() {
	bash -c "$FN_BODY"$'\n'"classify_worktree \"\$1\"" _ "$1"
}

FAILURES=0
PASSES=0
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -ge 2 ] && echo "    $2"
}

check() {
	local name="$1" expected="$2" got
	got=$(classify "$name")
	if [[ $got == "$expected" ]]; then
		pass "$name → $expected"
	else
		fail "$name → $expected" "got: $got"
	fi
}

echo "▶ new format (o-*)"
check "o-adv-931-932-933" orchestrator
check "o-ctl-373" orchestrator
check "o-cycle-1" orchestrator
check "o-adv-931-CTL-99" worker
check "o-ctl-373-CTL-373" worker

echo "▶ legacy format (orch-*)"
check "orch-adv-931-2026-05-12" orchestrator
check "orch-adv-931-2026-05-12-CTL-99" worker
check "orch-foo-2026-05-12" orchestrator

echo "▶ other"
check "CTL-373" oneshot
check "PM" pm
check "main" other
check "random" other

echo ""
echo "PASSES=$PASSES FAILURES=$FAILURES"
[[ $FAILURES -eq 0 ]] || exit 1
