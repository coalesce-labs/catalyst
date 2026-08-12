#!/usr/bin/env bash
# Cross-site guard: model-invoked skills and templates use worktree-safe merge (CTL-56).
# Asserts no live gh pr merge call carries --delete-branch, and that each file contains
# the checkout-free remote-ref delete pattern (git/refs/heads/ + --method DELETE).
# Run: bash plugins/dev/scripts/__tests__/merge-delete-branch-worktree-guard.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

assert_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" == *"$substr"* ]]; then pass "$label"
  else fail "$label — '$substr' not found"; fi
}

assert_not_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" != *"$substr"* ]]; then pass "$label"
  else fail "$label — forbidden '$substr' present"; fi
}

# Files to check — add new call sites here as a one-line addition.
CHECKED_FILES=(
  "plugins/dev/skills/merge-pr/SKILL.md"
  "plugins/dev/skills/recovery-pass/SKILL.md"
  "plugins/dev/skills/triage-aging-prs/SKILL.md"
  "plugins/dev/templates/followup-prompt.md"
  "plugins/dev/templates/fixup-prompt.md"
)

echo "CTL-56: model-invoked skills and templates — worktree-safe merge (cross-site)"
echo ""

for REL_FILE in "${CHECKED_FILES[@]}"; do
  FILE="${REPO_ROOT}/${REL_FILE}"
  LABEL="$(basename "$(dirname "$FILE")")/$(basename "$FILE")"
  echo "  ── ${LABEL}"
  if [[ -f "$FILE" ]]; then
    BODY="$(cat "$FILE")"
    assert_not_contains "$BODY" "--delete-branch" \
      "CTL-56: ${LABEL} drops --delete-branch (worktree-safe)"
    assert_contains "$BODY" "git/refs/heads/" \
      "CTL-56: ${LABEL} contains checkout-free remote-ref delete path"
    assert_contains "$BODY" "--method DELETE" \
      "CTL-56: ${LABEL} uses gh api --method DELETE for remote-ref cleanup"
  else
    fail "file missing: ${FILE}"
  fi
  echo ""
done

echo "CTL-56: merge-pr Step 11 — linked-worktree guard on local git checkout"
MERGE_PR="${REPO_ROOT}/plugins/dev/skills/merge-pr/SKILL.md"
if [[ -f "$MERGE_PR" ]]; then
  BODY="$(cat "$MERGE_PR")"
  assert_contains "$BODY" "git-common-dir" \
    "merge-pr Step 11 has linked-worktree guard (git-common-dir divergence check)"
else
  fail "merge-pr/SKILL.md missing: $MERGE_PR"
fi

echo ""
echo "CTL-56: repo-wide invariant — no live gh pr merge call carries --delete-branch"

# Scan plugins/ for any 'gh pr merge' line that includes '--delete-branch'.
# Exclude: JSON schema description strings, HTML mockups, bash comments (#),
# and test files (themselves may reference the flag for assertion labels).
REPO_ROOT_GUARD="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIVE_VIOLATORS="$(grep -rn -- '--delete-branch' "${REPO_ROOT_GUARD}/plugins/" \
  | grep 'gh pr merge' \
  | grep -v '\.json:' \
  | grep -v '\.html:' \
  | grep -v '\.test\.sh:' \
  | grep -v '^[^:]*:[[:space:]]*#' \
  || true)"
if [[ -z "$LIVE_VIOLATORS" ]]; then
  pass "no live gh pr merge call carries --delete-branch (repo-wide)"
else
  fail "live gh pr merge --delete-branch found (CTL-56 violation):
${LIVE_VIOLATORS}"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "merge-delete-branch-worktree-guard: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
