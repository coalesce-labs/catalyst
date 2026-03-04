#!/usr/bin/env bash
# Test suite for move-and-rereference.sh sed escaping
#
# Validates that regex special characters in file paths (especially dots)
# are escaped properly so sed treats them literally, not as wildcards.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/move-and-rereference.sh"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

PASS=true
TESTS=0
FAILURES=0

fail() {
	echo "  FAIL: $1"
	PASS=false
	FAILURES=$((FAILURES + 1))
}

pass() {
	echo "  PASS: $1"
}

run_test() {
	TESTS=$((TESTS + 1))
	echo ""
	echo "--- Test $TESTS: $1 ---"
}

# ── Test 1: Dots in file extensions are treated literally ────────────────────

run_test "Dots in file paths are not treated as regex wildcards"

TEST1_DIR="$TMPDIR/test1"
mkdir -p "$TEST1_DIR"
cd "$TEST1_DIR"
git init -q .

mkdir -p plugins/dev/agents
echo "content of foo.md" >plugins/dev/agents/foo.md

# Create a file with both an exact match and a near-match
# If dot is a wildcard, "foo.md" would also match "fooXmd"
cat >reference.md <<'EOF'
See plugins/dev/agents/foo.md for details.
Also see plugins/dev/agents/fooXmd for other info.
EOF

git add -A && git commit -q -m "initial"

printf 'plugins/dev/agents/foo.md\tplugins/dev/agents/bar.md\n' >mapping.tsv

"$SCRIPT" --execute --root "$TEST1_DIR" mapping.tsv >/dev/null 2>&1

# Check move happened
if [[ ! -f plugins/dev/agents/bar.md ]]; then
	fail "bar.md should exist after move"
elif [[ -f plugins/dev/agents/foo.md ]]; then
	fail "foo.md should still exist (was not moved)"
else
	pass "File was moved correctly"
fi

# Check reference updated
if grep -q "plugins/dev/agents/bar.md" reference.md; then
	pass "Reference updated from foo.md to bar.md"
else
	fail "Reference was not updated to bar.md"
fi

# CRITICAL: Check that the near-match was NOT altered
if grep -q "plugins/dev/agents/fooXmd" reference.md; then
	pass "Near-match 'fooXmd' was correctly left unchanged"
else
	fail "Near-match 'fooXmd' was incorrectly replaced (dot treated as wildcard)"
fi

# ── Test 2: Multiple dots in paths ──────────────────────────────────────────

run_test "Multiple dots in paths are all escaped"

TEST2_DIR="$TMPDIR/test2"
mkdir -p "$TEST2_DIR"
cd "$TEST2_DIR"
git init -q .

mkdir -p src/components
echo "component" >src/components/Button.test.tsx

cat >index.md <<'EOF'
Import from src/components/Button.test.tsx
Also import from src/components/ButtonXtestXtsx
EOF

git add -A && git commit -q -m "initial"

printf 'src/components/Button.test.tsx\tsrc/components/Button.spec.tsx\n' >mapping.tsv

"$SCRIPT" --execute --root "$TEST2_DIR" mapping.tsv >/dev/null 2>&1

if grep -q "src/components/Button.spec.tsx" index.md; then
	pass "Multi-dot path reference updated correctly"
else
	fail "Multi-dot path reference was not updated"
fi

if grep -q "src/components/ButtonXtestXtsx" index.md; then
	pass "Multi-dot near-match was correctly left unchanged"
else
	fail "Multi-dot near-match was incorrectly replaced"
fi

# ── Test 3: Paths with brackets ─────────────────────────────────────────────

run_test "Paths with square brackets are handled"

TEST3_DIR="$TMPDIR/test3"
mkdir -p "$TEST3_DIR"
cd "$TEST3_DIR"
git init -q .

mkdir -p "src/routes"
echo "route" >"src/routes/[id].tsx"

cat >config.md <<'EOF'
Route file: src/routes/[id].tsx
EOF

git add -A && git commit -q -m "initial"

printf 'src/routes/[id].tsx\tsrc/routes/[slug].tsx\n' >mapping.tsv

"$SCRIPT" --execute --root "$TEST3_DIR" mapping.tsv >/dev/null 2>&1

if grep -q 'src/routes/\[slug\].tsx' config.md; then
	pass "Bracket path reference updated correctly"
else
	fail "Bracket path reference was not updated correctly"
fi

# ── Test 4: Dry-run does not modify files ────────────────────────────────────

run_test "Dry-run mode does not modify files"

TEST4_DIR="$TMPDIR/test4"
mkdir -p "$TEST4_DIR"
cd "$TEST4_DIR"
git init -q .

mkdir -p plugins/dev
echo "content" >plugins/dev/old.md

cat >ref.md <<'EOF'
See plugins/dev/old.md
EOF

git add -A && git commit -q -m "initial"

printf 'plugins/dev/old.md\tplugins/dev/new.md\n' >mapping.tsv

# Run in dry-run mode (default)
"$SCRIPT" --root "$TEST4_DIR" mapping.tsv >/dev/null 2>&1

if [[ -f plugins/dev/old.md ]]; then
	pass "File was not moved in dry-run mode"
else
	fail "File was moved despite dry-run mode"
fi

if grep -q "plugins/dev/old.md" ref.md; then
	pass "Reference was not updated in dry-run mode"
else
	fail "Reference was updated despite dry-run mode"
fi

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "=============================="
echo "Tests: $TESTS | Failures: $FAILURES"
if [[ "$PASS" == true ]]; then
	echo "ALL TESTS PASSED"
	exit 0
else
	echo "SOME TESTS FAILED"
	exit 1
fi
