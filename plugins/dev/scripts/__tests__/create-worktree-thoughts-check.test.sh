#!/usr/bin/env bash
# Tests for the CTL-513 thoughts-init sanity check in create-worktree.sh.
# Run: bash plugins/dev/scripts/__tests__/create-worktree-thoughts-check.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CREATE_WT="${REPO_ROOT}/plugins/dev/scripts/create-worktree.sh"

FAILURES=0
PASSES=0
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
}
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
assert_eq() {
	if [[ $1 == "$2" ]]; then pass "$3"; else fail "$3 — expected '$1', got '$2'"; fi
}
assert_contains() {
	if [[ $1 == *"$2"* ]]; then pass "$3"; else fail "$3 — '$2' not in output"; fi
}

# Builds an isolated repo + stub humanlayer, runs the real create-worktree.sh.
#   $1 INIT_MODE: fail | noop-ok | real
#   $2 SETUP_JSON: optional catalyst.worktree.setup array (selects config-driven path)
# Sets globals: OUTPUT, EXIT, WT_PATH, SRC, SCRATCH
run_create_worktree() {
	local INIT_MODE="$1" SETUP_JSON="${2-}"
	SCRATCH="$(mktemp -d -t cwt-ctl513-XXXXXX)"
	SRC="$SCRATCH/src"
	local WT="$SCRATCH/wt" BIN="$SCRATCH/bin" FAKEHOME="$SCRATCH/home"
	mkdir -p "$SRC" "$WT" "$BIN" "$FAKEHOME" "$SRC/.catalyst"
	git -C "$SRC" init -q
	git -C "$SRC" config user.email t@t.t && git -C "$SRC" config user.name t
	git -C "$SRC" commit -q --allow-empty -m init
	if [[ -n $SETUP_JSON ]]; then
		printf '{"catalyst":{"projectKey":"t","worktree":{"setup":%s}}}\n' "$SETUP_JSON" \
			>"$SRC/.catalyst/config.json"
	else
		printf '{"catalyst":{"projectKey":"t"}}\n' >"$SRC/.catalyst/config.json"
	fi
	cat >"$BIN/humanlayer" <<STUB
#!/usr/bin/env bash
case "\$1 \$2" in
  "thoughts status") echo "Profile: testprofile" ;;
  "thoughts init")
    case "$INIT_MODE" in
      fail)    exit 1 ;;
      noop-ok) exit 0 ;;
      real)    mkdir -p thoughts/shared && echo x > thoughts/shared/.keep ;;
    esac ;;
  *) exit 0 ;;
esac
STUB
	chmod +x "$BIN/humanlayer"
	OUTPUT="$(cd "$SRC" && PATH="$BIN:$PATH" HOME="$FAKEHOME" \
		bash "$CREATE_WT" t-CTL-999 main --worktree-dir "$WT" 2>&1)"
	EXIT=$?
	WT_PATH="$WT/t-CTL-999"
}

# Case 1 — auto-detected path, init FAILS → exit 1 + worktree torn down.
echo "Test 1: auto-detected path, failed thoughts init fails fast"
run_create_worktree fail ""
assert_eq "1" "$EXIT" "exits 1 when auto-detected thoughts init fails"
assert_contains "$OUTPUT" "thoughts/shared" "error names thoughts/shared"
if [[ ! -d $WT_PATH ]]; then pass "worktree removed"; else fail "worktree not removed"; fi
if [[ -z "$(git -C "$SRC" branch --list t-CTL-999)" ]]; then pass "branch deleted"; else fail "branch left"; fi
rm -rf "$SCRATCH"

# Case 2 — config-driven path, thoughts init in setup FAILS → exit 1 (currently UNGUARDED).
echo "Test 2: config-driven path, failed thoughts init fails fast"
run_create_worktree fail '["humanlayer thoughts init --directory t"]'
assert_eq "1" "$EXIT" "exits 1 when config-driven thoughts init fails"
assert_contains "$OUTPUT" "thoughts/shared" "error names thoughts/shared"
if [[ ! -d $WT_PATH ]]; then pass "worktree removed"; else fail "worktree not removed"; fi
rm -rf "$SCRATCH"

# Case 3 — auto-detected path, init SUCCEEDS → exit 0, worktree + thoughts/shared present.
echo "Test 3: successful thoughts init still succeeds"
run_create_worktree real ""
assert_eq "0" "$EXIT" "exits 0 on successful init"
if [[ -d "$WT_PATH/thoughts/shared" ]]; then pass "thoughts/shared present"; else fail "thoughts/shared missing"; fi
rm -rf "$SCRATCH"

# Case 4 — config-driven setup that never calls thoughts init → no false positive, exit 0.
echo "Test 4: no false positive when thoughts init is not attempted"
run_create_worktree fail '["echo skip-thoughts"]'
assert_eq "0" "$EXIT" "exits 0 when no thoughts init was attempted"
if [[ -d $WT_PATH ]]; then pass "worktree created"; else fail "worktree missing"; fi
rm -rf "$SCRATCH"

# Case 5 — regression guard: existing auto-detected check still catches init-OK-but-empty.
echo "Test 5: existing thoughts/shared check still fires on noop-ok init"
run_create_worktree noop-ok ""
assert_eq "1" "$EXIT" "exits 1 when init reports OK but creates nothing"
rm -rf "$SCRATCH"

echo ""
echo "Passed: $PASSES  Failed: $FAILURES"
[[ $FAILURES -eq 0 ]] || exit 1
