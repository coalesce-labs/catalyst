#!/usr/bin/env bash
# validate-release-config.test.sh — CTL-1463 Phase 5.
#
# The repo had no test for validate-release-config.sh before this ticket —
# "a gate with no test is how a check that cannot fail ships" (the plan's own
# words). Exercises the script against scratch fixture repos via
# VALIDATE_RELEASE_CONFIG_REPO_ROOT (a test-only override added alongside
# this test; production behavior with the var unset is untouched).
#
# The vacuous-pass guard (a fixture with NO .codex-plugin/ at all) is named
# in the plan as "the single most important test in this phase" — every
# other check here can be satisfied by a script that never compares anything.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../validate-release-config.sh"
RELEASE_HEALTH_SUBJECT="$SCRIPT_DIR/../check-release-health.sh"
PLUGIN_VERSION_SUBJECT="$SCRIPT_DIR/../check-plugin-version.sh"

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

# build_fixture NAME → path to a scratch repo dir with the minimal shape
# validate-release-config.sh needs: release-please-config.json (one package
# "plugins/x"), .release-please-manifest.json, plugins/x/.claude-plugin/
# {plugin.json,}, and root .claude-plugin/marketplace.json. Callers add or
# omit .codex-plugin/plugin.json per test case.
build_fixture() {
	local name="$1" claude_version="$2"
	local root="$SCRATCH/$name"
	mkdir -p "$root/plugins/x/.claude-plugin"
	cat >"$root/release-please-config.json" <<EOF
{
  "packages": {
    "plugins/x": {
      "release-type": "simple",
      "component": "catalyst-x",
      "extra-files": [
        { "type": "json", "path": ".claude-plugin/plugin.json", "jsonpath": "\$.version" },
        { "type": "json", "path": ".codex-plugin/plugin.json", "jsonpath": "\$.version" }
      ]
    }
  }
}
EOF
	cat >"$root/.release-please-manifest.json" <<EOF
{ "plugins/x": "$claude_version" }
EOF
	cat >"$root/plugins/x/.claude-plugin/plugin.json" <<EOF
{ "name": "catalyst-x", "version": "$claude_version" }
EOF
	mkdir -p "$root/.claude-plugin"
	cat >"$root/.claude-plugin/marketplace.json" <<EOF
{ "plugins": [ { "name": "catalyst-x", "source": "./plugins/x" } ] }
EOF
	echo "$root"
}

run_validate() {
	VALIDATE_RELEASE_CONFIG_REPO_ROOT="$1" bash "$SUBJECT" 2>&1
}

echo ""
echo "=== Check 9/10: vacuous-pass guard — NO .codex-plugin/ at all ==="
ROOT="$(build_fixture novacodex 1.0.0)"
OUT="$(run_validate "$ROOT")"
RC=$?
if echo "$OUT" | grep -q 'FAIL:.*\.codex-plugin/plugin.json.*missing'; then
	pass "Check 9 FAILs (never skips) when .codex-plugin/plugin.json is absent"
else
	fail "Check 9 FAILs when .codex-plugin/plugin.json is absent" "$OUT"
fi
if echo "$OUT" | grep -q 'FAIL:.*inconclusive.*0 comparisons'; then
	pass "Check 10 reports inconclusive — 0 comparisons — never PASS on an empty loop"
else
	fail "Check 10 reports inconclusive on zero comparisons" "$OUT"
fi
if echo "$OUT" | grep -qE '^PASS: Claude and Codex'; then
	fail "Check 10 must NOT print a bare PASS line when it compared nothing" "$OUT"
else
	pass "Check 10 does not falsely PASS when it compared nothing"
fi
[[ $RC -ne 0 ]] && pass "exits non-zero on the vacuous-pass fixture" || fail "exits non-zero on the vacuous-pass fixture" "rc=$RC"

echo ""
echo "=== Check 10: parity FAIL — claude=1.2.0, codex=1.1.0 ==="
ROOT="$(build_fixture mismatch 1.2.0)"
mkdir -p "$ROOT/plugins/x/.codex-plugin"
echo '{ "name": "catalyst-x", "version": "1.1.0" }' >"$ROOT/plugins/x/.codex-plugin/plugin.json"
OUT="$(run_validate "$ROOT")"
RC=$?
if echo "$OUT" | grep -q 'FAIL:.*version mismatch' && echo "$OUT" | grep -q '1.2.0' && echo "$OUT" | grep -q '1.1.0'; then
	pass "Check 10 FAILs naming the plugin and BOTH versions"
else
	fail "Check 10 FAILs naming the plugin and both versions" "$OUT"
fi
[[ $RC -ne 0 ]] && pass "exits non-zero on a version mismatch" || fail "exits non-zero on a version mismatch" "rc=$RC"

echo ""
echo "=== Check 9/10: parity PASS — matching versions, non-zero comparison count ==="
ROOT="$(build_fixture matching 1.2.0)"
mkdir -p "$ROOT/plugins/x/.codex-plugin"
echo '{ "name": "catalyst-x", "version": "1.2.0" }' >"$ROOT/plugins/x/.codex-plugin/plugin.json"
mkdir -p "$ROOT/.agents/plugins"
echo '{ "plugins": [ { "name": "catalyst-x" } ] }' >"$ROOT/.agents/plugins/marketplace.json"
OUT="$(run_validate "$ROOT")"
RC=$?
if echo "$OUT" | grep -q 'PASS:.*versions agree (1 compared)'; then
	pass "Check 10 PASSes and reports a non-zero comparison count"
else
	fail "Check 10 PASSes and reports a non-zero comparison count" "$OUT"
fi

echo ""
echo "=== Check 9: Codex extra-files registration is mandatory ==="
ROOT="$(build_fixture missingcodexregistration 1.2.0)"
mkdir -p "$ROOT/plugins/x/.codex-plugin" "$ROOT/.agents/plugins"
echo '{ "name": "catalyst-x", "version": "1.2.0" }' >"$ROOT/plugins/x/.codex-plugin/plugin.json"
echo '{ "plugins": [ { "name": "catalyst-x" } ] }' >"$ROOT/.agents/plugins/marketplace.json"
jq 'del(.packages["plugins/x"]["extra-files"][] | select(.path == ".codex-plugin/plugin.json"))' \
	"$ROOT/release-please-config.json" >"$ROOT/config.tmp"
mv "$ROOT/config.tmp" "$ROOT/release-please-config.json"
OUT="$(run_validate "$ROOT")"
RC=$?
if [[ $RC -ne 0 ]] && echo "$OUT" | grep -q 'FAIL:.*Codex.*extra-files'; then
	pass "Check 9 FAILs when a package no longer registers Codex version propagation"
else
	fail "Check 9 catches a missing Codex extra-files entry" "rc=$RC" "$OUT"
fi

echo ""
echo "=== Check 11: Codex catalog version ban — both directions ==="
ROOT="$(build_fixture codexcatalog 1.0.0)"
mkdir -p "$ROOT/plugins/x/.codex-plugin"
echo '{ "name": "catalyst-x", "version": "1.0.0" }' >"$ROOT/plugins/x/.codex-plugin/plugin.json"
mkdir -p "$ROOT/.agents/plugins"
echo '{ "plugins": [ { "name": "catalyst-x", "version": "1.0.0" } ] }' >"$ROOT/.agents/plugins/marketplace.json"
OUT="$(run_validate "$ROOT")"
if echo "$OUT" | grep -q 'FAIL:.*\.agents/plugins/marketplace\.json has version fields'; then
	pass "Check 11 FAILs when the Codex catalog carries a version field (planted violation)"
else
	fail "Check 11 FAILs when the Codex catalog carries a version field" "$OUT"
fi

# Remove the planted version — same fixture, now clean.
echo '{ "plugins": [ { "name": "catalyst-x" } ] }' >"$ROOT/.agents/plugins/marketplace.json"
OUT="$(run_validate "$ROOT")"
if echo "$OUT" | grep -q 'PASS:.*\.agents/plugins/marketplace\.json has no version fields'; then
	pass "Check 11 PASSes once the planted version is removed — proving the check can actually clear"
else
	fail "Check 11 PASSes once the planted version is removed" "$OUT"
fi

echo ""
echo "=== End-to-end AC: simulate a release bump, both gates green ==="
# The executable form of the Gherkin scenario: apply release-please's own
# extra-files semantics (write \$.version to BOTH configured paths for one
# package), then both checks must be green.
ROOT="$(build_fixture e2e 1.0.0)"
mkdir -p "$ROOT/plugins/x/.codex-plugin"
echo '{ "name": "catalyst-x", "version": "1.0.0" }' >"$ROOT/plugins/x/.codex-plugin/plugin.json"
mkdir -p "$ROOT/.agents/plugins"
echo '{ "plugins": [ { "name": "catalyst-x" } ] }' >"$ROOT/.agents/plugins/marketplace.json"
# Derive the update targets from release-please-config.json. If the Codex
# extra-files registration disappears, this simulation stops updating it and
# the gates go red — unlike a fixture that hardcodes both output paths.
while IFS= read -r rel_path; do
	target="$ROOT/plugins/x/$rel_path"
	jq --arg version "2.0.0" '.version = $version' "$target" >"$target.tmp"
	mv "$target.tmp" "$target"
done < <(jq -r '.packages["plugins/x"]["extra-files"][] | select(.jsonpath == "$.version") | .path' "$ROOT/release-please-config.json")
echo '{ "plugins/x": "2.0.0" }' >"$ROOT/.release-please-manifest.json"
OUT="$(run_validate "$ROOT")"
RC=$?
if [[ $RC -eq 0 ]] && echo "$OUT" | grep -q 'ALL CHECKS PASSED'; then
	pass "post-release-bump fixture: ALL CHECKS PASSED"
else
	fail "post-release-bump fixture: ALL CHECKS PASSED" "rc=$RC" "$OUT"
fi

build_release_health_fixture() {
	local name="$1" codex_mode="$2"
	local root
	root="$(build_fixture "$name" 1.2.0)"
	mkdir -p "$root/scripts" "$root/bin"
	cp "$RELEASE_HEALTH_SUBJECT" "$root/scripts/check-release-health.sh"
	mkdir -p "$root/.agents/plugins"
	echo '{ "plugins": [] }' >"$root/.agents/plugins/marketplace.json"
	if [[ "$codex_mode" == "mismatch" ]]; then
		mkdir -p "$root/plugins/x/.codex-plugin"
		echo '{ "name": "catalyst-x", "version": "1.1.0" }' >"$root/plugins/x/.codex-plugin/plugin.json"
	fi
	cat >"$root/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "run" ]]; then
  echo '{"conclusion":"success","databaseId":1,"createdAt":"fixture"}'
elif [[ "$1" == "pr" ]]; then
  echo '{"number":1,"headRefName":"fixture"}'
fi
EOF
	chmod +x "$root/bin/gh"
	echo "$root"
}

run_release_health() {
	local root="$1"
	PATH="$root/bin:$PATH" bash "$root/scripts/check-release-health.sh" 2>&1
}

echo ""
echo "=== Release-health Check 3: Codex drift and absence both fail loudly ==="
ROOT="$(build_release_health_fixture healthmismatch mismatch)"
OUT="$(run_release_health "$ROOT")"
RC=$?
if [[ $RC -ne 0 ]] && echo "$OUT" | grep -q '\.codex-plugin/plugin.json=1.1.0'; then
	pass "release health FAILs and names a drifted Codex manifest"
else
	fail "release health catches Codex version drift" "rc=$RC" "$OUT"
fi
ROOT="$(build_release_health_fixture healthmissing missing)"
OUT="$(run_release_health "$ROOT")"
RC=$?
if [[ $RC -ne 0 ]] && echo "$OUT" | grep -q 'missing.*\.codex-plugin/plugin.json'; then
	pass "release health FAILs instead of skipping a missing Codex manifest"
else
	fail "release health catches a missing Codex manifest" "rc=$RC" "$OUT"
fi

echo ""
echo "=== Plugin-version gate: every release-config package path is covered ==="
ROOT="$SCRATCH/plugin-version-paths"
mkdir -p "$ROOT/scripts" "$ROOT/plugins/foundry"
cp "$PLUGIN_VERSION_SUBJECT" "$ROOT/scripts/check-plugin-version.sh"
cat >"$ROOT/release-please-config.json" <<'EOF'
{ "packages": { "plugins/foundry": { "component": "catalyst-foundry" } } }
EOF
echo baseline >"$ROOT/plugins/foundry/README.md"
git -C "$ROOT" init -q
git -C "$ROOT" config user.name fixture
git -C "$ROOT" config user.email fixture@example.com
git -C "$ROOT" add .
git -C "$ROOT" commit -qm baseline
echo changed >"$ROOT/plugins/foundry/README.md"
OUT="$(cd "$ROOT" && STRICT_VERSION_CHECK=true bash scripts/check-plugin-version.sh 2>&1)"
RC=$?
if [[ $RC -ne 0 ]] && echo "$OUT" | grep -q 'catalyst-foundry'; then
	pass "plugin-version gate covers plugins/foundry from release-please config"
else
	fail "plugin-version gate covers every configured package path" "rc=$RC" "$OUT"
fi

echo ""
echo "=== Production real-repo run is unaffected by the override var being unset ==="
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT="$(bash "$SUBJECT" 2>&1)"
RC=$?
if [[ $RC -eq 0 ]] && echo "$OUT" | grep -q 'ALL CHECKS PASSED'; then
	pass "real repo ($REPO_ROOT) still passes all checks with no override set"
else
	fail "real repo still passes all checks with no override set" "rc=$RC" "$OUT"
fi

echo ""
echo "=== $PASSES passed, $FAILURES failed ==="
[[ $FAILURES -eq 0 ]]
