#!/usr/bin/env bash
# Shell tests for orchestrate-verify.sh (CTL-222).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-verify.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
VERIFY="${REPO_ROOT}/plugins/dev/scripts/orchestrate-verify.sh"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# Build a scratch repo with a base commit on `main`, then create a feature
# branch with the given files added so `git diff main..` returns them.
scratch_setup() {
  SCRATCH="$(mktemp -d)"
  cd "$SCRATCH"

  git init -q -b main
  git config user.email "test@example.com"
  git config user.name "test"
  echo "base" > README.md
  git add README.md
  git commit -q -m "base"

  git checkout -q -b feature

  mkdir -p "${SCRATCH}/bin"
  ORCH_DIR="${SCRATCH}/orch"
  mkdir -p "${ORCH_DIR}/workers"
}

scratch_teardown() {
  cd /
  rm -rf "$SCRATCH"
  unset SCRATCH ORCH_DIR
}

# Stage files, commit, and put a stub `gh` on PATH. The pr-view fixture
# uses {{MERGE_SHA}} as a placeholder — replaced with the real HEAD SHA so
# the script's merge-SHA-based diff range refers to a real commit.
seed_changes_and_gh() {
  # Args: GH_PR_LIST_TEMPLATE GH_PR_VIEW_TEMPLATE
  local pr_list_tpl="$1" pr_view_tpl="$2"
  git add -A
  git commit -q -m "feature changes"
  local merge_sha
  merge_sha=$(git rev-parse HEAD)

  local pr_list_json pr_view_json
  pr_list_json="${pr_list_tpl//\{\{MERGE_SHA\}\}/$merge_sha}"
  pr_view_json="${pr_view_tpl//\{\{MERGE_SHA\}\}/$merge_sha}"

  cat > "${SCRATCH}/bin/gh" <<EOF
#!/usr/bin/env bash
args="\$*"
if [[ "\$args" == *"pr list"* ]]; then
  cat <<JSON
${pr_list_json}
JSON
elif [[ "\$args" == *"pr view"* ]]; then
  cat <<JSON
${pr_view_json}
JSON
else
  echo "stub gh: unexpected: \$args" >&2
  exit 99
fi
EOF
  chmod +x "${SCRATCH}/bin/gh"
  export PATH="${SCRATCH}/bin:${PATH}"
}

# Seed a worker signal file at $ORCH_DIR/workers/<ticket>.json.
make_signal() {
  local ticket="$1"
  cat > "${ORCH_DIR}/workers/${ticket}.json" <<EOF
{
  "ticket": "${ticket}",
  "definitionOfDone": {
    "testsWrittenFirst": false,
    "unitTests": {"exists": false, "count": 0},
    "apiTests": {"exists": false, "count": 0},
    "functionalTests": {"exists": false, "count": 0}
  }
}
EOF
}

run_verify() {
  local ticket="$1" req="${2:-backend}"
  set +e
  OUT=$("$VERIFY" \
    --worktree "$SCRATCH" \
    --ticket "$ticket" \
    --base-branch main \
    --signal-file "${ORCH_DIR}/workers/${ticket}.json" \
    --test-requirements "$req" 2>&1)
  RC=$?
  set -e
}

echo "orchestrate-verify tests"
echo

# ---------------------------------------------------------------
# 1. No-source-file run is clean (only docs changed)
# ---------------------------------------------------------------
echo "test: doc-only diff produces no '0\\\\n0' count artefact"
scratch_setup
echo "doc change" >> README.md
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-1"
run_verify "TICK-1" "backend"
# Detect the broken "0\n0" pattern that the bug produces — a count
# rendered as two adjacent lines inside parentheses, e.g. "(0\n0 files)".
if echo "$OUT" | tr '\n' '|' | grep -qE '\(0\|0 '; then
  fail "no '0\\\\n0' count artefact in stdout" "$OUT"
else
  pass "no '0\\\\n0' count artefact in stdout"
fi
echo "$OUT" | grep -q "integer expression" && fail "no 'integer expression' errors" "$OUT" || pass "no 'integer expression' errors"
scratch_teardown
echo

# ---------------------------------------------------------------
# 2. Merged-with-deleted-branch lookup succeeds
# ---------------------------------------------------------------
echo "test: merged PR found via --state all"
scratch_setup
echo "doc" >> README.md
seed_changes_and_gh \
  '[{"number":99,"state":"MERGED","mergedAt":"2026-05-04T00:00:00Z"}]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-2"
run_verify "TICK-2" "backend"
echo "$OUT" | grep -q "PR #99 is MERGED" && pass "merged PR detected" || fail "merged PR detected" "$OUT"
echo "$OUT" | grep -q "No PR found for branch" && fail "should not report 'No PR found' for merged PR" "$OUT" || pass "no false-negative on merged PR"
scratch_teardown
echo

# ---------------------------------------------------------------
# 3. Loose-route regex tightened
# ---------------------------------------------------------------
echo "test: setup-webhooks.sh is NOT flagged as API route"
scratch_setup
mkdir -p plugins/dev/scripts
echo '#!/bin/bash' > plugins/dev/scripts/setup-webhooks.sh
echo 'echo hi' >> plugins/dev/scripts/setup-webhooks.sh
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-3"
run_verify "TICK-3" "backend"
echo "$OUT" | grep -q "API routes changed" && fail "setup-webhooks.sh should not trigger API route check" "$OUT" || pass "setup-webhooks.sh not flagged as API"
scratch_teardown
echo

echo "test: apiClient.ts is NOT flagged as API route"
scratch_setup
mkdir -p src
cat > src/apiClient.ts <<'EOF'
export const fetchClient = () => 1;
EOF
cat > src/apiClient.test.ts <<'EOF'
import { fetchClient } from './apiClient';
test('x', () => { fetchClient(); });
EOF
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-4"
run_verify "TICK-4" "backend"
echo "$OUT" | grep -q "API routes changed" && fail "apiClient.ts should not trigger API route check" "$OUT" || pass "apiClient.ts not flagged as API"
scratch_teardown
echo

# ---------------------------------------------------------------
# 4. Real route file does trigger API check
# ---------------------------------------------------------------
echo "test: src/api/foo.ts DOES trigger API route check"
scratch_setup
mkdir -p src/api
cat > src/api/foo.ts <<'EOF'
export const handler = () => 1;
EOF
# No corresponding API test, so we expect the API check to fail.
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-5"
run_verify "TICK-5" "fullstack"
echo "$OUT" | grep -qE "API (routes|files)" && pass "src/api/foo.ts detected as route" || fail "src/api/foo.ts detected as route" "$OUT"
scratch_teardown
echo

# ---------------------------------------------------------------
# 5. RESULT: FAIL exits non-zero
# ---------------------------------------------------------------
echo "test: missing test file triggers FAIL with non-zero exit"
scratch_setup
mkdir -p src
cat > src/widget.ts <<'EOF'
export const f = () => 1;
EOF
# Deliberately no test file alongside.
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-6"
run_verify "TICK-6" "backend"
echo "$OUT" | grep -q "RESULT: FAIL" && pass "RESULT: FAIL printed" || fail "RESULT: FAIL printed" "$OUT"
[ "$RC" -ne 0 ] && pass "exit code is non-zero on FAIL (rc=$RC)" || fail "exit code is non-zero on FAIL" "rc=$RC; out: $OUT"
scratch_teardown
echo

# ---------------------------------------------------------------
echo
if [ $FAILURES -eq 0 ]; then
  echo "ALL PASSED ($PASSES)"
  exit 0
else
  echo "FAILED: $FAILURES (passes: $PASSES)"
  exit 1
fi
