#!/usr/bin/env bash
# Tests for scripts/worktree-thoughts-init.sh (CTL-845) — the vendored,
# humanlayer-free thoughts layout creator.
# Run: bash plugins/dev/scripts/__tests__/worktree-thoughts-init.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INIT="${REPO_ROOT}/scripts/worktree-thoughts-init.sh"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
assert_eq() {
	if [[ $1 == "$2" ]]; then pass "$3"; else fail "$3 — expected '$1', got '$2'"; fi
}
assert_contains() {
	if [[ $1 == *"$2"* ]]; then pass "$3"; else fail "$3 — '$2' not in output"; fi
}

# Build an isolated env: fake $HOME with humanlayer.json, a fake thoughtsRepo,
# and a fake worktree (cwd). Returns via globals: SCRATCH, WT, TR, FAKEHOME.
setup_env() {
	local user="${1-ryan}" profile="${2-}"
	SCRATCH="$(mktemp -d -t wti-XXXXXX)"
	TR="$SCRATCH/thoughtsRepo"
	WT="$SCRATCH/wt"
	FAKEHOME="$SCRATCH/home"
	mkdir -p "$TR" "$WT" "$FAKEHOME/.config/humanlayer"
	cat >"$FAKEHOME/.config/humanlayer/humanlayer.json" <<JSON
{"thoughts":{"thoughtsRepo":"$TR/top","reposDir":"repos","globalDir":"global",
 "user":"$user","profiles":{"coalesce-labs":{"thoughtsRepo":"$TR/cl","reposDir":"repos","globalDir":"global"}}}}
JSON
	mkdir -p "$TR/top" "$TR/cl"
}

# Case 1: happy path, top-level config → 3 symlinks + searchable/ + repoMapping.
echo "Test 1: creates layout from top-level config"
setup_env ryan ""
OUT="$(cd "$WT" && HOME="$FAKEHOME" bash "$INIT" --directory myrepo 2>&1)"
EXIT=$?
assert_eq "0" "$EXIT" "exits 0 on success"
if [[ -d "$WT/thoughts/shared" ]]; then pass "thoughts/shared exists"; else fail "thoughts/shared missing"; fi
if [[ -L "$WT/thoughts/shared" ]]; then pass "thoughts/shared is a symlink"; else fail "not a symlink"; fi
SHARED_TARGET="$(readlink "$WT/thoughts/shared")"
if [[ "$SHARED_TARGET" == "$TR/top/repos/myrepo/shared" ]]; then
	pass "shared target correct"
else
	fail "wrong shared target: got '$SHARED_TARGET', expected '$TR/top/repos/myrepo/shared'"
fi
if [[ -L "$WT/thoughts/ryan" ]]; then pass "user symlink exists"; else fail "user symlink missing"; fi
if [[ -d "$WT/thoughts/searchable" ]]; then pass "searchable/ dir exists"; else fail "searchable/ missing"; fi
WT_REAL="$(cd "$WT" && pwd -P)"
MAP="$(jq -r --arg k "$WT_REAL" '.thoughts.repoMappings[$k].repo' "$FAKEHOME/.config/humanlayer/humanlayer.json")"
assert_eq "myrepo" "$MAP" "repoMapping registered with absolute worktree path"
rm -rf "$SCRATCH"

# Case 2: --profile resolves the profile's thoughtsRepo, NOT the top-level one.
echo "Test 2: --profile uses profile-specific thoughtsRepo"
setup_env ryan ""
OUT="$(cd "$WT" && HOME="$FAKEHOME" bash "$INIT" --directory myrepo --profile coalesce-labs 2>&1)"
EXIT=$?
assert_eq "0" "$EXIT" "exits 0 with profile"
SHARED_TARGET_P="$(readlink "$WT/thoughts/shared")"
if [[ "$SHARED_TARGET_P" == "$TR/cl/repos/myrepo/shared" ]]; then
	pass "profile shared target correct"
else
	fail "did not use profile thoughtsRepo: got '$SHARED_TARGET_P'"
fi
WT_REAL2="$(cd "$WT" && pwd -P)"
MAPP="$(jq -r --arg k "$WT_REAL2" '.thoughts.repoMappings[$k].profile' "$FAKEHOME/.config/humanlayer/humanlayer.json")"
assert_eq "coalesce-labs" "$MAPP" "repoMapping records profile"
rm -rf "$SCRATCH"

# Case 3: missing humanlayer.json → non-zero + actionable message, no partial layout.
echo "Test 3: missing config fails loudly"
SCRATCH="$(mktemp -d -t wti-XXXXXX)"
WT="$SCRATCH/wt"
FAKEHOME="$SCRATCH/home"
mkdir -p "$WT" "$FAKEHOME"
OUT="$(cd "$WT" && HOME="$FAKEHOME" bash "$INIT" --directory myrepo 2>&1)"
EXIT=$?
if [[ "$EXIT" -ne 0 ]]; then pass "exits non-zero when humanlayer.json absent"; else fail "should fail"; fi
if [[ "$OUT" == *"humanlayer.json"* ]]; then pass "error names the missing file"; else fail "error missing 'humanlayer.json'"; fi
if [[ ! -e "$WT/thoughts/shared" ]]; then pass "no partial layout left"; else fail "left a partial layout"; fi
rm -rf "$SCRATCH"

# Case 4: null user → skips user symlink, still creates shared/global, exits 0 with warning.
echo "Test 4: null user degrades gracefully"
setup_env "" ""
OUT="$(cd "$WT" && HOME="$FAKEHOME" bash "$INIT" --directory myrepo 2>&1)"
EXIT=$?
assert_eq "0" "$EXIT" "exits 0 even without a user"
if [[ -L "$WT/thoughts/shared" ]]; then pass "shared still created"; else fail "shared missing"; fi
if [[ "$OUT" == *"user"* ]]; then pass "warns about missing user"; else fail "no warning about user"; fi
rm -rf "$SCRATCH"

# Case 5: idempotent — running twice does not error and leaves correct symlinks.
echo "Test 5: idempotent re-run"
setup_env ryan ""
(cd "$WT" && HOME="$FAKEHOME" bash "$INIT" --directory myrepo >/dev/null 2>&1)
OUT="$(cd "$WT" && HOME="$FAKEHOME" bash "$INIT" --directory myrepo 2>&1)"
EXIT=$?
assert_eq "0" "$EXIT" "second run exits 0"
SHARED_TARGET2="$(readlink "$WT/thoughts/shared")"
if [[ "$SHARED_TARGET2" == "$TR/top/repos/myrepo/shared" ]]; then
	pass "symlink still correct after re-run"
else
	fail "symlink broke on re-run: $SHARED_TARGET2"
fi
rm -rf "$SCRATCH"

echo ""
echo "Passed: $PASSES  Failed: $FAILURES"
[[ $FAILURES -eq 0 ]] || exit 1
