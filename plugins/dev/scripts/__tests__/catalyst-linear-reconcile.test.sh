#!/usr/bin/env bash
# Tests for catalyst-linear-reconcile — the completion-declaration reconciler CLI (CTL-1371).
# Hermetic: declares into a temp store and reconciles dry-run against a --states-file
# (no gh / no linearis / no network / no Linear writes).
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-linear-reconcile.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CLI="${REPO_ROOT}/plugins/dev/scripts/catalyst-linear-reconcile"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

assert_eq() {
	local label="$1" expected="$2" actual="$3"
	if [[ $expected == "$actual" ]]; then
		PASSES=$((PASSES + 1))
		echo "  PASS: $label"
	else
		FAILURES=$((FAILURES + 1))
		echo "  FAIL: $label"
		echo "    expected: $expected"
		echo "    actual:   $actual"
	fi
}
assert_contains() {
	local label="$1" needle="$2" haystack="$3"
	if [[ $haystack == *"$needle"* ]]; then
		PASSES=$((PASSES + 1))
		echo "  PASS: $label"
	else
		FAILURES=$((FAILURES + 1))
		echo "  FAIL: $label"
		echo "    expected to contain: $needle"
		echo "    actual: $haystack"
	fi
}

DECLS="$SCRATCH/completions"
cat >"$SCRATCH/config.json" <<'JSON'
{ "catalyst": { "linear": { "teamKey": "CTL", "stateMap": { "backlog": "Backlog", "inReview": "PR", "done": "Done", "canceled": "Canceled" } } } }
JSON
cat >"$SCRATCH/states.json" <<'JSON'
{ "CTL-9": "Backlog" }
JSON

echo "== --help exits 0 =="
"$CLI" --help >/dev/null 2>&1
assert_eq "help exit code" "0" "$?"

echo "== unknown command exits 2 =="
"$CLI" frobnicate >/dev/null 2>&1
assert_eq "unknown-command exit code" "2" "$?"

echo "== declare drops a durable marker (no write), exit 0 =="
OUT="$("$CLI" declare CTL-9 --no-write --no-emit --decls-dir "$DECLS" 2>&1)"
RC=$?
assert_eq "declare exit code" "0" "$RC"
assert_contains "declare reports declared" "declared (no write)" "$OUT"
assert_eq "marker file exists" "1" "$([[ -f "$DECLS/CTL-9.json" ]] && echo 1 || echo 0)"

echo "== status --json shows the pending declaration =="
SOUT="$("$CLI" status --json --decls-dir "$DECLS" 2>/dev/null)"
assert_contains "status lists CTL-9" '"ticket": "CTL-9"' "$SOUT"

echo "== reconcile --json (dry-run) detects drift, writes nothing, exit 0 =="
ROUT="$("$CLI" reconcile --decls-dir "$DECLS" --states-file "$SCRATCH/states.json" --config "$SCRATCH/config.json" --json 2>/dev/null)"
RC=$?
assert_eq "reconcile exit code" "0" "$RC"
assert_contains "mode is dry-run" '"mode": "dry-run"' "$ROUT"
assert_contains "CTL-9 drift correction" '"decision": "correct"' "$ROUT"
assert_contains "drift flagged dry-run" '"dryRun": true' "$ROUT"
assert_contains "summary corrected 0" '"corrected": 0' "$ROUT"
assert_contains "summary drift 1" '"drift": 1' "$ROUT"

echo "== idempotent: already-Done ticket reconciles in-sync, zero drift =="
echo '{ "CTL-9": "Done" }' >"$SCRATCH/states-done.json"
ROUT2="$("$CLI" reconcile --decls-dir "$DECLS" --states-file "$SCRATCH/states-done.json" --config "$SCRATCH/config.json" --json 2>/dev/null)"
assert_contains "idempotent in-sync 1" '"inSync": 1' "$ROUT2"
assert_contains "idempotent drift 0" '"drift": 0' "$ROUT2"

echo ""
echo "catalyst-linear-reconcile tests: ${PASSES} passed / ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
