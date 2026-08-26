#!/usr/bin/env bash
# check-plugin-manifest-parity.test.sh — CTL-2263 Phase 1: the extra-files
# completeness check (Check 4), fixture-driven per the plan's "write first,
# watch fail" discipline. CTL-2220 deleted validate-release-config.sh (11
# checks) and replaced only Checks 9-11; nothing asserted a package's
# extra-files actually point at the two plugin.json files that exist. That
# was harmless while the config was a bare roster — restoring real
# extra-files re-opens the hole, and the failure mode is silent (version.txt
# bumped, both plugin.json files left behind).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../check-plugin-manifest-parity.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}

# build_fixture DIR CONFIG_JSON — a minimal repo tree with one plugin
# (plugins/dev), valid marketplace catalogs, and plugin.json files that
# already satisfy Checks 1-3, so only the new extra-files check (Check 4)
# is under test. CONFIG_JSON becomes release-please-config.json verbatim.
build_fixture() {
	local dir="$1" config_json="$2"
	mkdir -p "$dir/plugins/dev/.claude-plugin" "$dir/plugins/dev/.codex-plugin" "$dir/.claude-plugin" "$dir/.agents/plugins"
	echo '{"version":"1.0.0"}' >"$dir/plugins/dev/.claude-plugin/plugin.json"
	echo '{"version":"1.0.0"}' >"$dir/plugins/dev/.codex-plugin/plugin.json"
	echo '{"plugins":[]}' >"$dir/.claude-plugin/marketplace.json"
	echo '{"plugins":[]}' >"$dir/.agents/plugins/marketplace.json"
	printf '%s' "$config_json" >"$dir/release-please-config.json"
}

run_check() {
	local dir="$1"
	CHECK_PLUGIN_MANIFEST_PARITY_REPO_ROOT="$dir" bash "$SUBJECT" 2>&1
}

VALID_EXTRA_FILES='[{"type":"json","path":".claude-plugin/plugin.json","jsonpath":"$.version"},{"type":"json","path":".codex-plugin/plugin.json","jsonpath":"$.version"}]'

echo ""
echo "=== fixture 1: package entry omits extra-files entirely ==="
DIR1="$SCRATCH/f1"
build_fixture "$DIR1" '{"packages":{"plugins/dev":{"release-type":"simple","component":"catalyst-dev","changelog-path":"CHANGELOG.md","include-component-in-tag":true}}}'
OUT1="$(run_check "$DIR1")"
RC1=$?
[[ "$RC1" -ne 0 ]] && pass "exits non-zero" || fail "exits non-zero" "$OUT1"
grep -q "plugins/dev" <<<"$OUT1" && pass "names the plugin" || fail "names the plugin" "$OUT1"

echo ""
echo "=== fixture 2: extra-files path points at a nonexistent file ==="
DIR2="$SCRATCH/f2"
build_fixture "$DIR2" "{\"packages\":{\"plugins/dev\":{\"release-type\":\"simple\",\"component\":\"catalyst-dev\",\"changelog-path\":\"CHANGELOG.md\",\"include-component-in-tag\":true,\"extra-files\":$VALID_EXTRA_FILES}}}"
# The extra-files entry's shape is otherwise correct (right path, right type,
# right jsonpath) — only the codex plugin.json target is missing on disk, so
# this exercises the file-existence leg specifically, not the "wrong path"
# leg fixture 1 already covers.
rm -f "$DIR2/plugins/dev/.codex-plugin/plugin.json"
OUT2="$(run_check "$DIR2")"
RC2=$?
[[ "$RC2" -ne 0 ]] && pass "exits non-zero" || fail "exits non-zero" "$OUT2"
grep -q "plugins/dev/.codex-plugin/plugin.json does not resolve" <<<"$OUT2" && pass "names the missing path" || fail "names the missing path" "$OUT2"

echo ""
echo "=== fixture 3: jsonpath is not \$.version ==="
DIR3="$SCRATCH/f3"
build_fixture "$DIR3" '{"packages":{"plugins/dev":{"release-type":"simple","component":"catalyst-dev","changelog-path":"CHANGELOG.md","include-component-in-tag":true,"extra-files":[{"type":"json","path":".claude-plugin/plugin.json","jsonpath":"$.name"},{"type":"json","path":".codex-plugin/plugin.json","jsonpath":"$.version"}]}}}'
OUT3="$(run_check "$DIR3")"
RC3=$?
[[ "$RC3" -ne 0 ]] && pass "exits non-zero" || fail "exits non-zero" "$OUT3"

echo ""
echo "=== fixture 4: empty packages object → inconclusive, not a vacuous pass ==="
DIR4="$SCRATCH/f4"
mkdir -p "$DIR4/.claude-plugin" "$DIR4/.agents/plugins"
echo '{"plugins":[]}' >"$DIR4/.claude-plugin/marketplace.json"
echo '{"plugins":[]}' >"$DIR4/.agents/plugins/marketplace.json"
echo '{"packages":{}}' >"$DIR4/release-please-config.json"
OUT4="$(run_check "$DIR4")"
RC4=$?
[[ "$RC4" -ne 0 ]] && pass "exits non-zero (inconclusive, not a vacuous pass)" || fail "exits non-zero" "$OUT4"
grep -qi "inconclusive" <<<"$OUT4" && pass "reports inconclusive" || fail "reports inconclusive" "$OUT4"

echo ""
echo "=== fixture 5: the real repo config passes ==="
OUT5="$(CHECK_PLUGIN_MANIFEST_PARITY_REPO_ROOT="$REPO_ROOT" bash "$SUBJECT" 2>&1)"
RC5=$?
[[ "$RC5" -eq 0 ]] && pass "exits zero on the real repo config" || fail "exits zero on the real repo config" "$OUT5"

echo ""
echo "--- ⛔ positive control: a fully valid single-package fixture passes ---"
DIR6="$SCRATCH/f6"
build_fixture "$DIR6" "{\"packages\":{\"plugins/dev\":{\"release-type\":\"simple\",\"component\":\"catalyst-dev\",\"changelog-path\":\"CHANGELOG.md\",\"include-component-in-tag\":true,\"extra-files\":$VALID_EXTRA_FILES}}}"
OUT6="$(run_check "$DIR6")"
RC6=$?
[[ "$RC6" -eq 0 ]] && pass "exits zero" || fail "exits zero" "$OUT6"

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
