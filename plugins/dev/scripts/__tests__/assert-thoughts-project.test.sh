#!/usr/bin/env bash
# Tests for lib/assert-thoughts-project.sh (CTL-1081 Phase 3).
#
# The helper checks that thoughts/shared symlink target contains
# /repos/<catalyst.thoughts.directory>/. Fail-open when config or
# symlink is absent (non-orchestrated runs unaffected).
#
# Run: bash plugins/dev/scripts/__tests__/assert-thoughts-project.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/assert-thoughts-project.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t assert-thoughts-project-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then
		pass "$label"
	else
		fail "$label — expected '$expected', got '$actual'"
	fi
}

if [[ ! -f $HELPER ]]; then
	echo "FATAL: helper not found — expected at $HELPER" >&2
	exit 1
fi

# Build a fake thoughts repo layout:
# ${SCRATCH}/repos/catalyst-workspace/shared/
# ${SCRATCH}/repos/adva/shared/
THOUGHTS_REPO="${SCRATCH}/repos"
mkdir -p "${THOUGHTS_REPO}/catalyst-workspace/shared"
mkdir -p "${THOUGHTS_REPO}/adva/shared"

# ─── Test 1: correct symlink → exits 0, silent ───────────────────────────────

echo "Test 1: correct symlink (catalyst-workspace) → exits 0 silently"
PROJ1="${SCRATCH}/proj1"
mkdir -p "${PROJ1}/.catalyst"
cat >"${PROJ1}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "thoughts": { "directory": "catalyst-workspace" },
    "projectKey": "test-proj"
  }
}
EOF
mkdir -p "${PROJ1}/thoughts"
ln -sf "${THOUGHTS_REPO}/catalyst-workspace/shared" "${PROJ1}/thoughts/shared"

RC=0
OUT="$(cd "$PROJ1" && bash "$HELPER" 2>&1)" || RC=$?
assert_eq "0" "$RC" "correct symlink: exits 0"
assert_eq "" "$OUT" "correct symlink: no output"

# ─── Test 2: wrong symlink (adva) → exits non-zero, stderr names both paths ──

echo ""
echo "Test 2: wrong symlink (adva) → exits non-zero, stderr names both paths"
PROJ2="${SCRATCH}/proj2"
mkdir -p "${PROJ2}/.catalyst"
cat >"${PROJ2}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "thoughts": { "directory": "catalyst-workspace" },
    "projectKey": "test-proj"
  }
}
EOF
mkdir -p "${PROJ2}/thoughts"
ln -sf "${THOUGHTS_REPO}/adva/shared" "${PROJ2}/thoughts/shared"

RC2=0
OUT2="$(cd "$PROJ2" && bash "$HELPER" 2>&1)" || RC2=$?
assert_eq "1" "$RC2" "wrong symlink: exits non-zero"
if printf '%s\n' "$OUT2" | grep -q "catalyst-workspace"; then
	pass "wrong symlink: stderr mentions expected directory (catalyst-workspace)"
else
	fail "wrong symlink: stderr did NOT mention expected directory (catalyst-workspace)"
fi
if printf '%s\n' "$OUT2" | grep -q "adva"; then
	pass "wrong symlink: stderr mentions actual directory (adva)"
else
	fail "wrong symlink: stderr did NOT mention actual directory (adva)"
fi

# ─── Test 3: missing config → fails-open (exits 0, optional warning) ─────────

echo ""
echo "Test 3: missing .catalyst/config.json → fails-open (exits 0)"
PROJ3="${SCRATCH}/proj3"
mkdir -p "${PROJ3}/thoughts"
ln -sf "${THOUGHTS_REPO}/catalyst-workspace/shared" "${PROJ3}/thoughts/shared"
RC3=0
(cd "$PROJ3" && bash "$HELPER" >/dev/null 2>&1) || RC3=$?
assert_eq "0" "$RC3" "missing config: fails-open (exits 0)"

# ─── Test 4: missing symlink → fails-open (exits 0) ──────────────────────────

echo ""
echo "Test 4: missing thoughts/shared symlink → fails-open (exits 0)"
PROJ4="${SCRATCH}/proj4"
mkdir -p "${PROJ4}/.catalyst"
cat >"${PROJ4}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "thoughts": { "directory": "catalyst-workspace" }
  }
}
EOF
RC4=0
(cd "$PROJ4" && bash "$HELPER" >/dev/null 2>&1) || RC4=$?
assert_eq "0" "$RC4" "missing symlink: fails-open (exits 0)"

# ─── Test 5: missing thoughts.directory in config → fails-open ───────────────

echo ""
echo "Test 5: thoughts.directory absent in config → fails-open (exits 0)"
PROJ5="${SCRATCH}/proj5"
mkdir -p "${PROJ5}/.catalyst" "${PROJ5}/thoughts"
cat >"${PROJ5}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-proj"
  }
}
EOF
ln -sf "${THOUGHTS_REPO}/catalyst-workspace/shared" "${PROJ5}/thoughts/shared"
RC5=0
(cd "$PROJ5" && bash "$HELPER" >/dev/null 2>&1) || RC5=$?
assert_eq "0" "$RC5" "no thoughts.directory in config: fails-open (exits 0)"

echo ""
echo "─────────────────────────────────────────────"
echo "assert-thoughts-project: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
	exit 1
fi
exit 0
