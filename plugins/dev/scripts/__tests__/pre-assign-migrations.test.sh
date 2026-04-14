#!/usr/bin/env bash
# Shell tests for pre-assign-migrations.sh.
# Run: bash plugins/dev/scripts/__tests__/pre-assign-migrations.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
PREASSIGN="${REPO_ROOT}/plugins/dev/scripts/pre-assign-migrations.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

expect_contains() {
  local file="$1" needle="$2"
  grep -qF -- "$needle" "$file" || { echo "    missing: $needle"; return 1; }
}

expect_not_contains() {
  local file="$1" needle="$2"
  ! grep -qF -- "$needle" "$file" || { echo "    unexpected: $needle"; return 1; }
}

expect_empty() {
  local file="$1"
  [ ! -s "$file" ] || { echo "    expected empty output; got:"; sed 's/^/    /' "$file"; return 1; }
}

expect_exit() {
  local expected="$1"; shift
  set +e
  "$@" > "${SCRATCH}/out" 2>&1
  local rc=$?
  set -e
  [ "$rc" = "$expected" ] || { echo "    expected rc=$expected got rc=$rc"; sed 's/^/    /' "${SCRATCH}/out"; return 1; }
}

echo "pre-assign-migrations tests"

# Test 1: missing --tickets-json errors
run "errors when --tickets-json omitted" \
  expect_exit 1 "$PREASSIGN"

# Test 2: no migrations dir → silent exit 0 (repo-agnostic)
NOMIG_DIR="${SCRATCH}/no-migrations"
mkdir -p "$NOMIG_DIR"
"$PREASSIGN" --migrations-dir "${NOMIG_DIR}/supabase/migrations" \
  --tickets-json '[{"id":"CTL-1","title":"add migration","description":"","labels":[]}]' \
  > "${SCRATCH}/t2.out" 2>&1
run "silent when migrations dir missing" expect_empty "${SCRATCH}/t2.out"

# Test 3: no migration-likely tickets → silent output
MIG_DIR="${SCRATCH}/supabase/migrations"
mkdir -p "$MIG_DIR"
touch "${MIG_DIR}/001_init.sql"
touch "${MIG_DIR}/002_users.sql"
"$PREASSIGN" --migrations-dir "$MIG_DIR" \
  --tickets-json '[{"id":"CTL-1","title":"fix button styles","description":"small UI fix","labels":["frontend"]}]' \
  > "${SCRATCH}/t3.out" 2>&1
run "silent when no migration-likely tickets" expect_empty "${SCRATCH}/t3.out"

# Test 4: single migration-likely ticket gets next number (003)
"$PREASSIGN" --migrations-dir "$MIG_DIR" \
  --tickets-json '[{"id":"CTL-10","title":"add users table","description":"CREATE TABLE users","labels":[]}]' \
  > "${SCRATCH}/t4.out" 2>&1
run "outputs Migration Number Assignments header" expect_contains "${SCRATCH}/t4.out" "## Migration Number Assignments"
run "assigns next number (003) to single ticket" expect_contains "${SCRATCH}/t4.out" '**CTL-10**: `003_'

# Test 5: multiple migration tickets get sequential numbers
"$PREASSIGN" --migrations-dir "$MIG_DIR" \
  --tickets-json '[
    {"id":"CTL-10","title":"add users table","description":"CREATE TABLE users","labels":[]},
    {"id":"CTL-11","title":"add orders","description":"schema change","labels":["database"]}
  ]' \
  > "${SCRATCH}/t5.out" 2>&1
run "CTL-10 gets 003" expect_contains "${SCRATCH}/t5.out" '**CTL-10**: `003_'
run "CTL-11 gets 004" expect_contains "${SCRATCH}/t5.out" '**CTL-11**: `004_'

# Test 6: label-based detection
"$PREASSIGN" --migrations-dir "$MIG_DIR" \
  --tickets-json '[{"id":"CTL-20","title":"infra work","description":"no keywords here","labels":["migration"]}]' \
  > "${SCRATCH}/t6.out" 2>&1
run 'detects via migration label' expect_contains "${SCRATCH}/t6.out" '**CTL-20**: `003_'

# Test 7: only migration-likely tickets are assigned; others skipped
"$PREASSIGN" --migrations-dir "$MIG_DIR" \
  --tickets-json '[
    {"id":"CTL-30","title":"frontend button","description":"UI","labels":["frontend"]},
    {"id":"CTL-31","title":"add comments table","description":"ALTER TABLE comments","labels":[]}
  ]' \
  > "${SCRATCH}/t7.out" 2>&1
run "mixed wave: UI ticket not listed" expect_not_contains "${SCRATCH}/t7.out" "CTL-30"
run "mixed wave: migration ticket listed" expect_contains "${SCRATCH}/t7.out" '**CTL-31**: `003_'

# Test 8: scans largest NNN correctly when files are out of order / padded
MIG_DIR_B="${SCRATCH}/scan/supabase/migrations"
mkdir -p "$MIG_DIR_B"
touch "${MIG_DIR_B}/001_a.sql" "${MIG_DIR_B}/007_g.sql" "${MIG_DIR_B}/003_c.sql"
"$PREASSIGN" --migrations-dir "$MIG_DIR_B" \
  --tickets-json '[{"id":"CTL-40","title":"add reports","description":"CREATE TABLE reports","labels":[]}]' \
  > "${SCRATCH}/t8.out" 2>&1
run "picks max NNN across files (008 after 007)" expect_contains "${SCRATCH}/t8.out" '**CTL-40**: `008_'

# Test 9: empty migrations dir → starts at 001
MIG_DIR_C="${SCRATCH}/empty/supabase/migrations"
mkdir -p "$MIG_DIR_C"
"$PREASSIGN" --migrations-dir "$MIG_DIR_C" \
  --tickets-json '[{"id":"CTL-50","title":"initial schema","description":"CREATE TABLE foo","labels":[]}]' \
  > "${SCRATCH}/t9.out" 2>&1
run "empty migrations dir starts at 001" expect_contains "${SCRATCH}/t9.out" '**CTL-50**: `001_'

# Test 10: migration-likely keywords are case-insensitive
"$PREASSIGN" --migrations-dir "$MIG_DIR" \
  --tickets-json '[{"id":"CTL-60","title":"Schema Update","description":"alter table foo add column","labels":[]}]' \
  > "${SCRATCH}/t10.out" 2>&1
run "case-insensitive keyword match" expect_contains "${SCRATCH}/t10.out" '**CTL-60**: `003_'

# Test 11: non-matching .sql filenames are ignored
MIG_DIR_D="${SCRATCH}/weird/supabase/migrations"
mkdir -p "$MIG_DIR_D"
touch "${MIG_DIR_D}/001_a.sql" "${MIG_DIR_D}/README.md" "${MIG_DIR_D}/backup.sql" "${MIG_DIR_D}/002_b.sql"
"$PREASSIGN" --migrations-dir "$MIG_DIR_D" \
  --tickets-json '[{"id":"CTL-70","title":"add table","description":"CREATE TABLE x","labels":[]}]' \
  > "${SCRATCH}/t11.out" 2>&1
run "ignores non-NNN_*.sql files (picks 003 after 002)" expect_contains "${SCRATCH}/t11.out" '**CTL-70**: `003_'

echo ""
echo "pre-assign-migrations: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
