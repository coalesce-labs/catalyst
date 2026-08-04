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
# CTL-1612 round 7 (Codex P2 follow-up): lib/__tests__/*.test.sh was never
# discovered by this runner (only the flat SHELL_TEST_DIR glob above ran), so
# lib/__tests__/linear-app-actor.test.sh — the only direct regression coverage
# for the monitor's scoped app-actor credential handling (alias clearing,
# personal-key preservation, inherited-token fallback) — never ran
# automatically. All 13 lib/__tests__/*.test.sh suites were verified passing
# before wiring this in (one, escalate-emitters.test.sh, was fixed alongside —
# pre-existing shellcheck debt in orphan-sweep.sh unrelated to CTL-1612).
LIB_SHELL_TEST_DIR="${LIB_SHELL_TEST_DIR:-${SCRIPT_DIR}/lib/__tests__}"
# CTL-1612 round 9 (Codex P2 follow-up): 6 of the 13 lib/__tests__ suites
# ALREADY run via a one-line SHELL_TEST_DIR wrapper
# (`exec bash ".../lib/__tests__/<name>.test.sh"`, predating the round-7
# glob above — e.g. __tests__/cluster-fence-guard-lib.test.sh,
# __tests__/secrets-hygiene.test.sh). Discovering them AGAIN via the
# LIB_SHELL_TEST_DIR glob below double-runs them: inflated pass/fail counts,
# and the relatively expensive Git/worktree fixture setup some of them do
# pays twice.
#
# CTL-1612 round 12 (Codex P2 follow-up): a hardcoded LIB_SHELL_TEST_WRAPPED
# table (rounds 9-11) said "this basename normally has a wrapper", not "a
# wrapper actually ran this invocation" — a targeted/fixture run overriding
# SHELL_TEST_DIR to a dir with no wrapper files silently dropped the lib
# suite (0 tests run, reported PASS).
#
# CTL-1612 round 13 (Codex P1 follow-up): that same hardcoded table was ALSO
# a second source of truth for the wrapper SET itself, independent of the
# round-12 presence bug — add a 7th wrapper later and this list drifts: the
# shell loop below runs the new wrapper fine, but the lib loop doesn't
# recognize its target and double-runs the underlying suite, and
# run-tests.test.sh's smoke coverage only ever pinned the ONE static-list
# entry it happened to exercise, so this drift class could ship unnoticed.
# Fix: derive the wrapped set from the wrapper files THEMSELVES, once, up
# front — scan every file actually present under the active SHELL_TEST_DIR
# for the literal exec-target reference every real wrapper contains
# (".../lib/__tests__/<basename>.test.sh", see e.g.
# __tests__/cluster-fence-guard-lib.test.sh) and collect the referenced
# basenames into LIB_WRAPPED_BASENAMES. A new wrapper is therefore
# self-registering — adding the wrapper file is the only step, no second
# list to remember or drift out of sync with — and this keeps round 12's
# "only skip when a wrapper is actually present under the ACTIVE
# SHELL_TEST_DIR this run" semantics for free, since the set is derived from
# that same active directory.
#
# CTL-1612 round 15 (Codex P2 follow-up): the round-13 grep matched the
# lib/__tests__ reference ANYWHERE in a file's text — a comment, a doc
# string, or (concretely reproduced) __tests__/run-tests.test.sh's own
# fixture-building `echo '... lib/__tests__/brand-new-lib-suite.test.sh"'`
# line, which merely BUILDS a string for a generated fixture and never
# executes anything. Any file merely mentioning a basename got treated as a
# real wrapper for it, so a genuine future lib suite of that basename would
# be silently skipped forever (0 tests run, reported PASS) even with no
# wrapper actually executing it. Fix: only count a reference on a line that
# is itself a real invocation — anchored to a line whose first token
# (after optional leading whitespace) is `bash` or `exec bash`, matching
# every real wrapper's exact shape (`exec bash ".../lib/__tests__/<name>"`)
# and excluding comments (start with `#`) and fixture-building `echo`/
# `printf` lines (start with `echo`/`printf`, not `bash`/`exec`).
LIB_WRAPPED_BASENAMES=""
if [[ -d $SHELL_TEST_DIR ]]; then
	for _wrapper_file in "$SHELL_TEST_DIR"/*.test.sh; do
		[[ -f $_wrapper_file ]] || continue
		while IFS= read -r _wrapped_basename; do
			[[ -n $_wrapped_basename ]] || continue
			LIB_WRAPPED_BASENAMES="${LIB_WRAPPED_BASENAMES}${_wrapped_basename}"$'\n'
		done < <(grep -nE '^[[:space:]]*(exec[[:space:]]+)?bash[[:space:]].*lib/__tests__/[A-Za-z0-9._-]+\.test\.sh"' "$_wrapper_file" 2>/dev/null |
			grep -oE 'lib/__tests__/[A-Za-z0-9._-]+\.test\.sh"' |
			sed -E 's#^lib/__tests__/(.+)"$#\1#')
	done
fi
_lib_suite_wrapper_present() {
	local _basename="$1"
	grep -qxF "$_basename" <<<"$LIB_WRAPPED_BASENAMES"
}
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
# CTL-1612 round 7: lib/__tests__ is a SEPARATE directory from SHELL_TEST_DIR
# (scripts/__tests__), so it needs its own glob rather than folding into the
# override var above (which the smoke test also repoints, deliberately kept
# single-purpose).
# CTL-1612 round 9: skip a lib suite that already ran via its SHELL_TEST_DIR
# wrapper in the loop above — without this, the aggregate summary
# double-counts suites that have one. CTL-1612 round 13: the wrapped set
# (LIB_WRAPPED_BASENAMES) is derived from the wrapper files themselves, see
# its comment above _lib_suite_wrapper_present.
for f in "$LIB_SHELL_TEST_DIR"/*.test.sh; do
	_f_basename="$(basename "$f")"
	if _lib_suite_wrapper_present "$_f_basename"; then
		continue
	fi
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
