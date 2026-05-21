#!/usr/bin/env bash
# Shell tests for orchestrate-execution-core-route.sh — the /orchestrate
# execution-core routing helper (CTL-554).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-execution-core-route.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HELPER="${REPO_ROOT}/plugins/dev/scripts/orchestrate-execution-core-route.sh"

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# Physical scratch path so logical `pwd` in the helper matches the fixture
# strings even on macOS, where mktemp lives under a /var → /private/var link.
SCRATCH=$(cd "$(mktemp -d)" && pwd -P)

# Fixture: a git repo with a linked worktree. The helper is run FROM the
# worktree and must resolve repoRoot to the main working tree.
git init -q "$SCRATCH/main"
(cd "$SCRATCH/main" \
  && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init)
mkdir -p "$SCRATCH/main/.catalyst"
echo '{"catalyst":{"project":{"key":"demoproj"}}}' \
  > "$SCRATCH/main/.catalyst/config.json"
git -C "$SCRATCH/main" worktree add -q -b feature "$SCRATCH/wt" >/dev/null 2>&1

RECORD="$SCRATCH/cat/execution-core/projects/demoproj.json"

echo "test 1 (CTL-554): enroll from a worktree resolves repoRoot to the main tree"
OUT=$(cd "$SCRATCH/wt" \
  && CATALYST_DIR="$SCRATCH/cat" EXECUTION_CORE_ENSURE_DAEMON=":" \
     bash "$HELPER" enroll 2>&1)
RC=$?
[ "$RC" = "0" ] && pass "enroll exits 0" || fail "enroll exits 0" "rc=$RC out=$OUT"
[ -f "$RECORD" ] && pass "enroll wrote record under resolved projectKey" \
  || fail "enroll wrote record" "no file at $RECORD"
RR=$(jq -r '.repoRoot' "$RECORD" 2>/dev/null)
[ "$RR" = "$SCRATCH/main" ] && pass "repoRoot resolved to main worktree" \
  || fail "repoRoot = main worktree" "got '$RR' want '$SCRATCH/main'"
PK=$(jq -r '.projectKey' "$RECORD" 2>/dev/null)
[ "$PK" = "demoproj" ] && pass "projectKey read from .catalyst/config.json" \
  || fail "projectKey from config" "got '$PK'"

echo "test 2 (CTL-554): stop removes the enrollment record"
(cd "$SCRATCH/wt" && CATALYST_DIR="$SCRATCH/cat" bash "$HELPER" stop) >/dev/null 2>&1
[ ! -f "$RECORD" ] && pass "stop removed the record" \
  || fail "stop removed the record" "record still at $RECORD"

# cleanup
git -C "$SCRATCH/main" worktree remove --force "$SCRATCH/wt" 2>/dev/null || true
rm -rf "$SCRATCH"

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${PASSES} pass, ${FAILURES} fail"
echo "─────────────────────────────────────────"
[ "$FAILURES" -eq 0 ]
