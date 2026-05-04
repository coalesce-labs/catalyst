#!/bin/bash
# orchestrate-verify.sh - Adversarial verification of worker output
#
# Independent quality audit run by the orchestrator after a worker claims "done".
# Checks for test coverage gaps, security issues, and reward-hacking patterns.
#
# Usage:
#   orchestrate-verify.sh \
#     --worktree <path> \
#     --ticket <ID> \
#     --base-branch <branch> \
#     --signal-file <path> \
#     [--test-requirements <backend|frontend|fullstack>]
#
# Exit codes:
#   0 — PASS (all required coverage present)
#   1 — FAIL (gaps found, details in output)
#   2 — ERROR (script misconfiguration)

# Drop `-e`: many checks use `[ "$X" -gt N ]` style and we want the
# script to always reach the explicit summary block (which sets the real
# exit code). `-uo pipefail` still catches unset vars and pipeline errors.
set -uo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Count non-empty lines in a string. Always emits exactly one integer to
# stdout — never the broken "0\n0" produced by `grep -c . || echo 0` on
# empty input.
count_lines() {
  if [ -z "${1:-}" ]; then
    echo 0
  else
    local n
    n=$(printf '%s\n' "$1" | grep -c . 2>/dev/null)
    echo "${n:-0}"
  fi
}

# Count regex matches in a file. Always emits a single integer.
count_matches() {
  local pattern="$1" file="$2"
  if [ ! -f "$file" ]; then
    echo 0
    return
  fi
  local n
  n=$(grep -cE "$pattern" "$file" 2>/dev/null)
  echo "${n:-0}"
}

# Parse arguments
WORKTREE=""
TICKET=""
BASE_BRANCH="main"
SIGNAL_FILE=""
TEST_REQUIREMENTS="backend"

while [[ $# -gt 0 ]]; do
  case $1 in
    --worktree) WORKTREE="$2"; shift 2 ;;
    --ticket) TICKET="$2"; shift 2 ;;
    --base-branch) BASE_BRANCH="$2"; shift 2 ;;
    --signal-file) SIGNAL_FILE="$2"; shift 2 ;;
    --test-requirements) TEST_REQUIREMENTS="$2"; shift 2 ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 2 ;;
  esac
done

if [ -z "$WORKTREE" ] || [ -z "$TICKET" ]; then
  echo -e "${RED}ERROR: --worktree and --ticket are required${NC}"
  exit 2
fi

if [ ! -d "$WORKTREE" ]; then
  echo -e "${RED}ERROR: Worktree directory does not exist: $WORKTREE${NC}"
  exit 2
fi

# Track failures
FAILURES=()
WARNINGS=()
PASS_COUNT=0

report_pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

report_fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAILURES+=("$1")
}

report_warn() {
  echo -e "  ${YELLOW}WARN${NC} $1"
  WARNINGS+=("$1")
}

report_skip() {
  echo -e "  ${CYAN}SKIP${NC} $1"
}

echo -e "${CYAN}=== Adversarial Verification: ${TICKET} ===${NC}"
echo "Worktree: $WORKTREE"
echo "Base branch: $BASE_BRANCH"
echo "Test requirements: $TEST_REQUIREMENTS"
echo ""

cd "$WORKTREE"

# Determine the diff range. Default: vs base-branch tip. If the worker's
# PR is already merged (post-merge verification — the common case since
# CTL-130), use the merge SHA so we can still see the changeset even
# after the branch has been deleted by `gh pr merge --delete-branch`.
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
DIFF_RANGE="${BASE_BRANCH}..."
PR_NUMBER=""
PR_STATE=""
PR_MERGE_SHA=""
if [ -n "$BRANCH" ]; then
  PR_LIST_JSON=$(gh pr list --head "$BRANCH" --state all --json number,state,mergedAt --limit 5 2>/dev/null || echo "[]")
  if [ -n "$PR_LIST_JSON" ] && [ "$PR_LIST_JSON" != "[]" ]; then
    # Prefer MERGED, then OPEN, then CLOSED
    PR_NUMBER=$(echo "$PR_LIST_JSON" | jq -r 'sort_by(if .state=="MERGED" then 0 elif .state=="OPEN" then 1 else 2 end) | .[0].number // empty' 2>/dev/null || echo "")
    PR_STATE=$(echo "$PR_LIST_JSON" | jq -r 'sort_by(if .state=="MERGED" then 0 elif .state=="OPEN" then 1 else 2 end) | .[0].state // empty' 2>/dev/null || echo "")
  fi
  if [ "$PR_STATE" = "MERGED" ] && [ -n "$PR_NUMBER" ]; then
    PR_VIEW_JSON=$(gh pr view "$PR_NUMBER" --json mergeCommit 2>/dev/null || echo "{}")
    PR_MERGE_SHA=$(echo "$PR_VIEW_JSON" | jq -r '.mergeCommit.oid // empty' 2>/dev/null || echo "")
    if [ -n "$PR_MERGE_SHA" ]; then
      DIFF_RANGE="${PR_MERGE_SHA}~..${PR_MERGE_SHA}"
    fi
  fi
fi

# ============================================================
# 1. CHANGED FILES ANALYSIS
# ============================================================
echo -e "${CYAN}--- 1. Changed Files Analysis ---${NC}"
echo "  Diff range: $DIFF_RANGE"

CHANGED_FILES=$(git diff --name-only "$DIFF_RANGE" 2>/dev/null || echo "")
if [ -z "$CHANGED_FILES" ]; then
  echo -e "${RED}ERROR: No changed files found in range ${DIFF_RANGE}${NC}"
  exit 2
fi

# Categorize changed files. Route detection only matches actual API
# source paths and explicit *.{route,handler,controller,endpoint}.X
# extensions — NOT arbitrary filenames containing "api" or "handler".
SOURCE_FILES=$(echo "$CHANGED_FILES" | grep -E '\.(ts|tsx|js|jsx|py|go|rs)$' | grep -vE '(\.test\.|\.spec\.|__test__|_test\.)' || true)
TEST_FILES=$(echo "$CHANGED_FILES" | grep -E '(\.test\.|\.spec\.|__test__|_test\.)' || true)
CONFIG_FILES=$(echo "$CHANGED_FILES" | grep -E '(\.json|\.yaml|\.yml|\.toml|\.env)$' || true)
ROUTE_FILES=$(echo "$CHANGED_FILES" | grep -E '(^|/)(src/api/|app/api/|pages/api/)|\.(route|handler|controller|endpoint)\.(ts|tsx|js|jsx|py|go|rs)$' | grep -vE '(\.test\.|\.spec\.)' || true)
UI_FILES=$(echo "$CHANGED_FILES" | grep -iE '\.(tsx|jsx|vue|svelte)$' | grep -vE '(\.test\.|\.spec\.)' || true)

SOURCE_COUNT=$(count_lines "$SOURCE_FILES")
TEST_COUNT=$(count_lines "$TEST_FILES")
ROUTE_COUNT=$(count_lines "$ROUTE_FILES")
UI_COUNT=$(count_lines "$UI_FILES")

echo "  Source files changed: $SOURCE_COUNT"
echo "  Test files changed: $TEST_COUNT"
echo "  Route/API files changed: $ROUTE_COUNT"
echo "  UI component files changed: $UI_COUNT"
echo ""

# ============================================================
# 2. UNIT TEST VERIFICATION
# ============================================================
echo -e "${CYAN}--- 2. Unit Test Coverage ---${NC}"

if [ "$SOURCE_COUNT" -eq 0 ]; then
  report_skip "No source files changed — unit tests not applicable"
else
  # Check if test files exist for changed source files
  MISSING_TESTS=()
  for SRC in $SOURCE_FILES; do
    # Derive expected test file paths
    DIR=$(dirname "$SRC")
    BASENAME=$(basename "$SRC" | sed -E 's/\.(ts|tsx|js|jsx|py|go|rs)$//')
    EXT=$(echo "$SRC" | grep -oE '\.[^.]+$')

    # Common test file patterns
    FOUND_TEST=false
    for PATTERN in \
      "${DIR}/${BASENAME}.test${EXT}" \
      "${DIR}/${BASENAME}.spec${EXT}" \
      "${DIR}/__tests__/${BASENAME}${EXT}" \
      "${DIR}/__tests__/${BASENAME}.test${EXT}" \
      "${DIR}/../__tests__/${BASENAME}${EXT}" \
      "test/${DIR}/${BASENAME}${EXT}" \
      "tests/${DIR}/${BASENAME}${EXT}"; do
      if [ -f "$PATTERN" ] || echo "$CHANGED_FILES" | grep -qF "$PATTERN"; then
        FOUND_TEST=true
        break
      fi
    done

    if [ "$FOUND_TEST" = false ]; then
      MISSING_TESTS+=("$SRC")
    fi
  done

  if [ ${#MISSING_TESTS[@]} -eq 0 ]; then
    report_pass "All $SOURCE_COUNT source files have corresponding test files"
  else
    report_fail "Missing tests for ${#MISSING_TESTS[@]} of $SOURCE_COUNT source files:"
    for F in "${MISSING_TESTS[@]}"; do
      echo "    - $F"
    done
  fi

  # Run test suite if a test command can be detected
  if [ -f "package.json" ]; then
    TEST_CMD=""
    if command -v bun >/dev/null 2>&1 && grep -q '"test"' package.json; then
      TEST_CMD="bun test"
    elif grep -q '"test"' package.json; then
      TEST_CMD="npm test"
    fi

    if [ -n "$TEST_CMD" ]; then
      echo "  Running test suite: $TEST_CMD"
      if eval "$TEST_CMD" >/dev/null 2>&1; then
        report_pass "Test suite passes"
      else
        report_fail "Test suite has failures"
      fi
    fi
  fi
fi
echo ""

# ============================================================
# 3. API TEST VERIFICATION
# ============================================================
echo -e "${CYAN}--- 3. API Test Coverage ---${NC}"

if [ "$TEST_REQUIREMENTS" = "frontend" ]; then
  report_skip "API tests not required for frontend-only scope"
elif [ "$ROUTE_COUNT" -eq 0 ]; then
  report_skip "No API route files changed — API tests not applicable"
else
  # Check for Bruno collections
  BRUNO_DIR=""
  for DIR in "bruno" "Bruno" "api-tests" "collections"; do
    if [ -d "$DIR" ]; then
      BRUNO_DIR="$DIR"
      break
    fi
  done

  if [ -n "$BRUNO_DIR" ]; then
    # Check for new .bru files in the diff
    NEW_BRU=$(echo "$CHANGED_FILES" | grep -E '\.bru$' || true)
    BRU_COUNT=$(count_lines "$NEW_BRU")

    if [ "$BRU_COUNT" -gt 0 ]; then
      report_pass "Found $BRU_COUNT Bruno API test files for $ROUTE_COUNT route changes"
    else
      report_fail "API routes changed ($ROUTE_COUNT files) but no Bruno test files added/modified"
      echo "    Route files:"
      for F in $ROUTE_FILES; do
        echo "      - $F"
      done
    fi
  else
    # Check for other API test patterns (supertest, axios tests, etc.)
    API_TEST_FILES=$(echo "$TEST_FILES" | grep -iE '(api|route|endpoint|integration)' || true)
    API_TEST_COUNT=$(count_lines "$API_TEST_FILES")

    if [ "$API_TEST_COUNT" -gt 0 ]; then
      report_pass "Found $API_TEST_COUNT API test files for $ROUTE_COUNT route changes"
    else
      report_fail "API routes changed ($ROUTE_COUNT files) but no API test files found"
    fi
  fi
fi
echo ""

# ============================================================
# 4. FUNCTIONAL/E2E TEST VERIFICATION
# ============================================================
echo -e "${CYAN}--- 4. Functional Test Coverage ---${NC}"

if [ "$TEST_REQUIREMENTS" = "backend" ]; then
  report_skip "Functional tests not required for backend-only scope"
elif [ "$UI_COUNT" -eq 0 ]; then
  report_skip "No UI component files changed — functional tests not applicable"
else
  # Check for E2E/functional test files
  E2E_FILES=$(echo "$CHANGED_FILES" | grep -iE '(e2e|playwright|cypress|functional|integration)' || true)
  E2E_COUNT=$(count_lines "$E2E_FILES")

  if [ "$E2E_COUNT" -gt 0 ]; then
    report_pass "Found $E2E_COUNT functional/E2E test files for $UI_COUNT UI changes"
  else
    # Check if E2E test infrastructure exists at all
    if [ -d "e2e" ] || [ -d "tests/e2e" ] || [ -f "playwright.config.ts" ] || [ -f "cypress.config.ts" ]; then
      report_fail "UI changed ($UI_COUNT files) but no functional/E2E test files added/modified"
    else
      report_warn "UI changed ($UI_COUNT files) — no E2E test infrastructure detected in project"
    fi
  fi
fi
echo ""

# ============================================================
# 5. TYPE SAFETY VERIFICATION
# ============================================================
echo -e "${CYAN}--- 5. Type Safety ---${NC}"

# Detect TypeScript project
if [ -f "tsconfig.json" ]; then
  TYPECHECK_CMD=""
  if command -v bun >/dev/null 2>&1; then
    TYPECHECK_CMD="bun tsc --noEmit"
  elif command -v npx >/dev/null 2>&1; then
    TYPECHECK_CMD="npx tsc --noEmit"
  fi

  if [ -n "$TYPECHECK_CMD" ]; then
    echo "  Running typecheck: $TYPECHECK_CMD"
    if eval "$TYPECHECK_CMD" 2>/dev/null; then
      report_pass "TypeScript compilation clean"
    else
      report_fail "TypeScript compilation errors"
    fi
  else
    report_warn "TypeScript project but no tsc available"
  fi
else
  report_skip "Not a TypeScript project"
fi
echo ""

# ============================================================
# 6. SECURITY SCAN
# ============================================================
echo -e "${CYAN}--- 6. Security Patterns ---${NC}"

SECURITY_ISSUES=()

# Check for common security anti-patterns in changed files
for SRC in $SOURCE_FILES; do
  if [ ! -f "$SRC" ]; then continue; fi

  # SQL injection patterns
  if grep -nE "(query|exec|execute)\s*\(" "$SRC" | grep -qE '\$\{|` *\+|"\s*\+' 2>/dev/null; then
    SECURITY_ISSUES+=("Potential SQL injection in $SRC")
  fi

  # Hardcoded secrets
  if grep -nEi '(password|secret|api_key|apikey|token)\s*[:=]\s*["\x27][^"\x27]{8,}' "$SRC" 2>/dev/null | grep -qvE '(test|mock|fake|example|placeholder|TODO)'; then
    SECURITY_ISSUES+=("Potential hardcoded secret in $SRC")
  fi

  # eval() usage
  if grep -nE '\beval\s*\(' "$SRC" 2>/dev/null | grep -qvE '(test|spec)'; then
    SECURITY_ISSUES+=("eval() usage in $SRC")
  fi

  # innerHTML without sanitization
  if grep -nE '(innerHTML|dangerouslySetInnerHTML)' "$SRC" 2>/dev/null; then
    SECURITY_ISSUES+=("Potential XSS via innerHTML in $SRC")
  fi
done

if [ ${#SECURITY_ISSUES[@]} -eq 0 ]; then
  report_pass "No common security anti-patterns found"
else
  for ISSUE in "${SECURITY_ISSUES[@]}"; do
    report_fail "$ISSUE"
  done
fi
echo ""

# ============================================================
# 7. REWARD HACKING SCAN
# ============================================================
echo -e "${CYAN}--- 7. Reward Hacking Patterns ---${NC}"

RH_ISSUES=()

for SRC in $SOURCE_FILES; do
  if [ ! -f "$SRC" ]; then continue; fi

  # as any casts
  AS_ANY_COUNT=$(count_matches 'as any' "$SRC")
  if [ "$AS_ANY_COUNT" -gt 0 ]; then
    RH_ISSUES+=("$AS_ANY_COUNT 'as any' cast(s) in $SRC")
  fi

  # @ts-ignore / @ts-expect-error without explanation
  TS_IGNORE_COUNT=$(count_matches '@ts-(ignore|expect-error)' "$SRC")
  if [ "$TS_IGNORE_COUNT" -gt 0 ]; then
    RH_ISSUES+=("$TS_IGNORE_COUNT @ts-ignore/@ts-expect-error in $SRC")
  fi

  # Empty catch blocks
  if grep -Pzo 'catch\s*\([^)]*\)\s*\{\s*\}' "$SRC" >/dev/null 2>&1; then
    RH_ISSUES+=("Empty catch block in $SRC")
  fi

  # console.log left in (non-test files)
  if ! echo "$SRC" | grep -qE '(test|spec)'; then
    LOG_COUNT=$(count_matches 'console\.log' "$SRC")
    if [ "$LOG_COUNT" -gt 2 ]; then
      RH_ISSUES+=("$LOG_COUNT console.log statements in $SRC (possible debug leftovers)")
    fi
  fi

  # Non-null assertions (!)
  BANG_COUNT=$(count_matches '\w+!' "$SRC")
  if [ "$BANG_COUNT" -gt 5 ]; then
    RH_ISSUES+=("$BANG_COUNT non-null assertions in $SRC (excessive)")
  fi
done

if [ ${#RH_ISSUES[@]} -eq 0 ]; then
  report_pass "No reward hacking patterns found"
else
  for ISSUE in "${RH_ISSUES[@]}"; do
    report_fail "$ISSUE"
  done
fi
echo ""

# ============================================================
# 8. PR MERGE STATE VERIFICATION
# ============================================================
# PR_NUMBER, PR_STATE and PR_MERGE_SHA were already resolved at the top
# of the script (see DIFF_RANGE setup). Reuse them instead of re-querying
# `gh pr list --head` (which only matches OPEN PRs and false-negatives
# every merged-with-deleted-branch worker — the common case since
# CTL-130).
echo -e "${CYAN}--- 8. PR Merge State ---${NC}"

if [ -z "$BRANCH" ]; then
  report_warn "Could not determine current branch"
elif [ -n "$PR_NUMBER" ]; then
  case "$PR_STATE" in
    MERGED)
      if [ -n "$PR_MERGE_SHA" ]; then
        report_pass "PR #${PR_NUMBER} is MERGED (merge SHA: ${PR_MERGE_SHA:0:8})"
      else
        report_pass "PR #${PR_NUMBER} is MERGED"
      fi
      ;;
    OPEN)
      PR_VIEW_OPEN_JSON=$(gh pr view "$PR_NUMBER" --json mergeStateStatus 2>/dev/null || echo "{}")
      MERGE_STATUS=$(echo "$PR_VIEW_OPEN_JSON" | jq -r '.mergeStateStatus // "UNKNOWN"' 2>/dev/null || echo "UNKNOWN")
      report_fail "PR #${PR_NUMBER} is still OPEN (mergeStateStatus: ${MERGE_STATUS}) — worker exited before merge"
      ;;
    CLOSED)
      report_fail "PR #${PR_NUMBER} is CLOSED without merge"
      ;;
    *)
      report_warn "PR #${PR_NUMBER} state: ${PR_STATE}"
      ;;
  esac
else
  report_fail "No PR found for branch ${BRANCH}"
fi
echo ""

# ============================================================
# 9. WORKER SIGNAL CROSS-CHECK
# ============================================================
echo -e "${CYAN}--- 9. Worker Signal Cross-Check ---${NC}"

if [ -n "$SIGNAL_FILE" ] && [ -f "$SIGNAL_FILE" ]; then
  # Compare worker's self-reported definitionOfDone with our findings
  CLAIMED_UNIT=$(jq -r '.definitionOfDone.unitTests.exists' "$SIGNAL_FILE" 2>/dev/null || echo "unknown")
  CLAIMED_API=$(jq -r '.definitionOfDone.apiTests.exists' "$SIGNAL_FILE" 2>/dev/null || echo "unknown")
  CLAIMED_FUNCTIONAL=$(jq -r '.definitionOfDone.functionalTests.exists' "$SIGNAL_FILE" 2>/dev/null || echo "unknown")
  CLAIMED_TDD=$(jq -r '.definitionOfDone.testsWrittenFirst' "$SIGNAL_FILE" 2>/dev/null || echo "unknown")

  if [ "$CLAIMED_UNIT" = "true" ] && [ "$TEST_COUNT" -eq 0 ]; then
    report_fail "Worker claims unit tests exist but no test files found in diff"
  fi

  if [ "$CLAIMED_API" = "true" ] && [ "$ROUTE_COUNT" -gt 0 ]; then
    NEW_BRU_FILES=$(echo "$CHANGED_FILES" | grep -E '\.bru$' || true)
    NEW_BRU_COUNT=$(count_lines "$NEW_BRU_FILES")
    API_TEST_MATCHES=$(echo "$TEST_FILES" | grep -iE '(api|route|endpoint|integration)' || true)
    API_TESTS_COUNT=$(count_lines "$API_TEST_MATCHES")
    if [ "$NEW_BRU_COUNT" -eq 0 ] && [ "$API_TESTS_COUNT" -eq 0 ]; then
      report_fail "Worker claims API tests exist but none found in diff"
    fi
  fi

  report_pass "Worker signal cross-check complete"
else
  report_skip "No signal file provided — skipping cross-check"
fi
echo ""

# ============================================================
# SUMMARY
# ============================================================
echo -e "${CYAN}=== Verification Summary: ${TICKET} ===${NC}"
echo ""

TOTAL_CHECKS=$((PASS_COUNT + ${#FAILURES[@]}))

if [ ${#FAILURES[@]} -eq 0 ]; then
  echo -e "${GREEN}RESULT: PASS${NC} ($PASS_COUNT checks passed)"
  if [ ${#WARNINGS[@]} -gt 0 ]; then
    echo ""
    echo "Warnings (non-blocking):"
    for W in "${WARNINGS[@]}"; do
      echo "  - $W"
    done
  fi
  exit 0
else
  echo -e "${RED}RESULT: FAIL${NC} (${#FAILURES[@]} failures, $PASS_COUNT passes)"
  echo ""
  echo "Failures (blocking):"
  for F in "${FAILURES[@]}"; do
    echo "  - $F"
  done
  if [ ${#WARNINGS[@]} -gt 0 ]; then
    echo ""
    echo "Warnings (non-blocking):"
    for W in "${WARNINGS[@]}"; do
      echo "  - $W"
    done
  fi
  exit 1
fi
