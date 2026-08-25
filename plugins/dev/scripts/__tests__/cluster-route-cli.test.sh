#!/usr/bin/env bash
# cluster-route-cli.test.sh — CTL-2116 Phase 3. Front-end reachability tests for
# `catalyst cluster route`.
#
# The verb must be reachable through the BASH front end (plugins/dev/scripts/
# catalyst-cluster), not merely exported from cli/cluster.mjs's main(). Positive
# control for the trap this guards against: `sync` and `ownership` are wired into
# cluster.mjs's main() switch but are NOT in catalyst-cluster's case statement, so
# they are unreachable via `catalyst cluster sync`/`ownership` today. This test
# asserts `route` is not a third silently-unreachable verb.
#
# Run: bash plugins/dev/scripts/__tests__/cluster-route-cli.test.sh

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CLUSTER="${REPO_ROOT}/plugins/dev/scripts/catalyst-cluster"
CLUSTER_MJS="${REPO_ROOT}/plugins/dev/scripts/execution-core/cli/cluster.mjs"
ROUTE_MJS="${REPO_ROOT}/plugins/dev/scripts/execution-core/cli/cluster-route.mjs"

PASS=0
FAIL=0

assert() {
	local desc="$1"
	shift
	if "$@" >/dev/null 2>&1; then
		PASS=$((PASS + 1))
		echo "PASS: ${desc}"
	else
		FAIL=$((FAIL + 1))
		echo "FAIL: ${desc} (cmd: $*)"
	fi
}

# 1. cluster-route.mjs exists and carries the CTL-1937 shell guard as line 1.
assert "cli/cluster-route.mjs exists" test -f "$ROUTE_MJS"
if [[ -f "$ROUTE_MJS" ]]; then
	first_line="$(head -n1 "$ROUTE_MJS")"
	if [[ "$first_line" == "//bin/true"* ]]; then
		PASS=$((PASS + 1))
		echo "PASS: cli/cluster-route.mjs line 1 is the CTL-1937 shell guard"
	else
		FAIL=$((FAIL + 1))
		echo "FAIL: cli/cluster-route.mjs line 1 is the CTL-1937 shell guard (got: ${first_line})"
	fi
fi

# 2. `route` is wired into cluster.mjs's main() switch.
assert "cli/cluster.mjs main() dispatches 'route'" grep -q '"route"' "$CLUSTER_MJS"

# 3. POSITIVE CONTROL for the trap: sync/ownership ARE in main() but NOT in the bash
#    case list — proves the assertion below (route present in the case) is a real
#    signal, not a vacuously-true grep.
assert "control: cluster.mjs main() dispatches 'sync' (known pre-existing case)" \
	grep -q '"sync"' "$CLUSTER_MJS"
if grep -Eq '^\s*status\|add\|remove\|rename\|set-anchor\|tune\|sync\|ownership\)' "$CLUSTER"; then
	FAIL=$((FAIL + 1))
	echo "FAIL: control assumption broken — sync/ownership are now IN the bash case list (update the positive control)"
else
	PASS=$((PASS + 1))
	echo "PASS: control holds — sync/ownership are NOT in the bash front-end case list today"
fi

# 4. The actual assertion: `route` IS reachable through the bash front end's case list
#    (mirrors the plan's `assert_grep 'route)' catalyst-cluster`).
assert "catalyst-cluster's case statement includes 'route)'" grep -q 'route)' "$CLUSTER"

# 5. `catalyst cluster --help` documents `route`.
out="$("$CLUSTER" --help 2>&1 || true)"
if echo "$out" | grep -q 'route'; then
	PASS=$((PASS + 1))
	echo "PASS: catalyst-cluster --help lists 'route'"
else
	FAIL=$((FAIL + 1))
	echo "FAIL: catalyst-cluster --help lists 'route' (got: ${out})"
fi

echo ""
echo "cluster-route-cli.test.sh: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
