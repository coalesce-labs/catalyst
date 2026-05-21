#!/usr/bin/env bash
# Aggregate test runner — discovers and runs every shell + in-scope bun test
# suite, prints one summary line, exits non-zero if any suite failed. (CTL-528)
#
# Env overrides (used by the smoke test):
#   SHELL_TEST_DIR     dir of *.test.sh files     (default: <scripts>/__tests__)
#   EXTRA_SHELL_TESTS  space-separated extra files (default: test-workflow-context.sh)
#   SKIP_BUN=1         skip the bun surfaces entirely
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BROKER_DIR="${REPO_ROOT}/plugins/dev/scripts/broker"
EXECUTION_CORE_DIR="${REPO_ROOT}/plugins/dev/scripts/execution-core"

SHELL_TEST_DIR="${SHELL_TEST_DIR:-${SCRIPT_DIR}/__tests__}"
# +x test: distinguishes "unset" (use default) from "set to empty" (smoke test).
if [[ -z ${EXTRA_SHELL_TESTS+x} ]]; then
	EXTRA_SHELL_TESTS="${SCRIPT_DIR}/test-workflow-context.sh"
fi
SKIP_BUN="${SKIP_BUN:-0}"

shell_pass=0
shell_fail=0
shell_skip=0
bun_pass=0
bun_fail=0
bun_skip=0
failed_suites=()

run_shell_test() {
	local f="$1" out rc
	out="$(bash "$f" 2>&1)"
	rc=$?
	if [[ $rc -eq 0 ]]; then
		if grep -q '^SKIP:' <<<"$out"; then
			shell_skip=$((shell_skip + 1))
			echo "  SKIP $f"
		else
			shell_pass=$((shell_pass + 1))
			echo "  PASS $f"
		fi
	else
		shell_fail=$((shell_fail + 1))
		failed_suites+=("$f")
		echo "  FAIL $f (rc=$rc)"
		printf '%s\n' "    | ${out//$'\n'/$'\n'    | }"
	fi
}

# broker-phase-lifecycle.test.sh (a shell suite member) delegates to bun and
# imports broker/index.mjs, which needs `pino` — so broker deps must be present
# BEFORE the shell suite runs, not just before the bun surfaces. (CTL-528)
ensure_broker_deps() {
	[[ $SKIP_BUN == "1" ]] && return 0
	command -v bun >/dev/null 2>&1 || return 0
	[[ -d "${BROKER_DIR}/node_modules" ]] && return 0
	echo "installing broker deps..."
	(cd "$BROKER_DIR" && bun install --frozen-lockfile) || true
}

# execution-core (CTL-535) — its bun suite imports `pino`, so deps must be
# present before the suite runs, mirroring ensure_broker_deps.
ensure_execution_core_deps() {
	[[ $SKIP_BUN == "1" ]] && return 0
	command -v bun >/dev/null 2>&1 || return 0
	[[ -d "${EXECUTION_CORE_DIR}/node_modules" ]] && return 0
	echo "installing execution-core deps..."
	(cd "$EXECUTION_CORE_DIR" && bun install --frozen-lockfile) || true
}

ensure_broker_deps
ensure_execution_core_deps

echo "=== Shell suite ==="
shopt -s nullglob
for f in "$SHELL_TEST_DIR"/*.test.sh; do
	run_shell_test "$f"
done
for f in $EXTRA_SHELL_TESTS; do
	[[ -f $f ]] && run_shell_test "$f"
done
shopt -u nullglob

echo "=== Bun suite ==="
if [[ $SKIP_BUN == "1" ]]; then
	echo "  SKIP (SKIP_BUN=1)"
elif ! command -v bun >/dev/null 2>&1; then
	echo "  SKIP (bun not on PATH)"
	bun_skip=2
else
	# broker deps were installed before the shell suite (ensure_broker_deps).
	# broker surface
	if (cd "$BROKER_DIR" && bun test); then
		bun_pass=$((bun_pass + 1))
		echo "  PASS broker bun suite"
	else
		bun_fail=$((bun_fail + 1))
		failed_suites+=("broker bun suite")
		echo "  FAIL broker bun suite"
	fi
	# execution-core surface (CTL-535)
	if (cd "$EXECUTION_CORE_DIR" && bun test); then
		bun_pass=$((bun_pass + 1))
		echo "  PASS execution-core bun suite"
	else
		bun_fail=$((bun_fail + 1))
		failed_suites+=("execution-core bun suite")
		echo "  FAIL execution-core bun suite"
	fi
	# lib surface — run from broker/ per lib/*.test.mjs documented run directive
	if (cd "$BROKER_DIR" && bun test ../lib/*.test.mjs); then
		bun_pass=$((bun_pass + 1))
		echo "  PASS lib bun suite"
	else
		bun_fail=$((bun_fail + 1))
		failed_suites+=("lib bun suite")
		echo "  FAIL lib bun suite"
	fi
fi

total_fail=$((shell_fail + bun_fail))
result="PASS"
[[ $total_fail -ne 0 ]] && result="FAIL"
echo ""
echo "make test summary: shell ${shell_pass} passed / ${shell_fail} failed / ${shell_skip} skipped | bun ${bun_pass} passed / ${bun_fail} failed / ${bun_skip} skipped | RESULT: ${result}"

if [[ $total_fail -ne 0 ]]; then
	printf '  failed suite: %s\n' "${failed_suites[@]}"
	exit 1
fi
exit 0
