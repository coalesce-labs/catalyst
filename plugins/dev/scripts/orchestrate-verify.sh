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

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

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

# ============================================================
# 1. CHANGED FILES ANALYSIS
# ============================================================
echo -e "${CYAN}--- 1. Changed Files Analysis ---${NC}"

CHANGED_FILES=$(git diff --name-only "${BASE_BRANCH}..." 2>/dev/null || echo "")
if [ -z "$CHANGED_FILES" ]; then
  echo -e "${RED}ERROR: No changed files found vs ${BASE_BRANCH}${NC}"
  exit 2
fi

# Categorize changed files
SOURCE_FILES=$(echo "$CHANGED_FILES" | grep -E '\.(ts|tsx|js|jsx|py|go|rs)$' | grep -vE '(\.test\.|\.spec\.|__test__|_test\.)' || true)
TEST_FILES=$(echo "$CHANGED_FILES" | grep -E '(\.test\.|\.spec\.|__test__|_test\.)' || true)
CONFIG_FILES=$(echo "$CHANGED_FILES" | grep -E '(\.json|\.yaml|\.yml|\.toml|\.env)$' || true)
ROUTE_FILES=$(echo "$CHANGED_FILES" | grep -iE '(route|controller|handler|endpoint|api)' | grep -vE '(\.test\.|\.spec\.)' || true)
UI_FILES=$(echo "$CHANGED_FILES" | grep -iE '\.(tsx|jsx|vue|svelte)$' | grep -vE '(\.test\.|\.spec\.)' || true)

SOURCE_COUNT=$(echo "$SOURCE_FILES" | grep -c . 2>/dev/null || echo 0)
TEST_COUNT=$(echo "$TEST_FILES" | grep -c . 2>/dev/null || echo 0)
ROUTE_COUNT=$(echo "$ROUTE_FILES" | grep -c . 2>/dev/null || echo 0)
UI_COUNT=$(echo "$UI_FILES" | grep -c . 2>/dev/null || echo 0)

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
    BRU_COUNT=$(echo "$NEW_BRU" | grep -c . 2>/dev/null || echo 0)

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
    API_TEST_COUNT=$(echo "$API_TEST_FILES" | grep -c . 2>/dev/null || echo 0)

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
  E2E_COUNT=$(echo "$E2E_FILES" | grep -c . 2>/dev/null || echo 0)

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
  AS_ANY_COUNT=$(grep -c 'as any' "$SRC" 2>/dev/null || echo 0)
  if [ "$AS_ANY_COUNT" -gt 0 ]; then
    RH_ISSUES+=("$AS_ANY_COUNT 'as any' cast(s) in $SRC")
  fi

  # @ts-ignore / @ts-expect-error without explanation
  TS_IGNORE_COUNT=$(grep -cE '@ts-(ignore|expect-error)' "$SRC" 2>/dev/null || echo 0)
  if [ "$TS_IGNORE_COUNT" -gt 0 ]; then
    RH_ISSUES+=("$TS_IGNORE_COUNT @ts-ignore/@ts-expect-error in $SRC")
  fi

  # Empty catch blocks
  if grep -Pzo 'catch\s*\([^)]*\)\s*\{\s*\}' "$SRC" >/dev/null 2>&1; then
    RH_ISSUES+=("Empty catch block in $SRC")
  fi

  # console.log left in (non-test files)
  if ! echo "$SRC" | grep -qE '(test|spec)'; then
    LOG_COUNT=$(grep -c 'console\.log' "$SRC" 2>/dev/null || echo 0)
    if [ "$LOG_COUNT" -gt 2 ]; then
      RH_ISSUES+=("$LOG_COUNT console.log statements in $SRC (possible debug leftovers)")
    fi
  fi

  # Non-null assertions (!)
  BANG_COUNT=$(grep -cE '\w+!' "$SRC" 2>/dev/null || echo 0)
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
# 8. WORKER SIGNAL CROSS-CHECK
# ============================================================
echo -e "${CYAN}--- 8. Worker Signal Cross-Check ---${NC}"

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
    NEW_BRU=$(echo "$CHANGED_FILES" | grep -E '\.bru$' | grep -c . 2>/dev/null || echo 0)
    API_TESTS=$(echo "$TEST_FILES" | grep -iE '(api|route|endpoint|integration)' | grep -c . 2>/dev/null || echo 0)
    if [ "$NEW_BRU" -eq 0 ] && [ "$API_TESTS" -eq 0 ]; then
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
