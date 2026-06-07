#!/usr/bin/env bash
# Tests for create-pr/SKILL.md title derivation + docs presence (CTL-783 Phase 3 & 4).
# Run: bash plugins/dev/scripts/__tests__/create-pr-title.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_CREATE_PR="${REPO_ROOT}/plugins/dev/skills/create-pr/SKILL.md"
CONFIG_DOC="${REPO_ROOT}/website/src/content/docs/reference/configuration.md"
ARCH_DOC="${REPO_ROOT}/docs/architecture.md"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

assert_grep() {
  local pattern="$1" file="$2" label="$3"
  if grep -qE "$pattern" "$file" 2>/dev/null; then pass "$label"
  else fail "$label — pattern '$pattern' not found in $(basename "$file")"; fi
}

assert_not_grep() {
  local pattern="$1" file="$2" label="$3"
  if ! grep -qE "$pattern" "$file" 2>/dev/null; then pass "$label"
  else fail "$label — pattern '$pattern' unexpectedly found in $(basename "$file")"; fi
}

echo "=== create-pr-title + docs presence tests (CTL-783) ==="

# ─── A. Step 7 sources lib/draft-pr.sh (or references draft_pr_title) ────────
echo ""
echo "A: create-pr/SKILL.md Step 7 uses draft_pr_title"
assert_grep 'draft_pr_title|draft-pr\.sh' "$SKILL_CREATE_PR" \
  "A: Step 7 references draft_pr_title or sources draft-pr.sh"

# ─── B. Step 7 derives subject from git log --no-merges ────────────────────
echo ""
echo "B: Step 7 derives title from commit subject (git log --no-merges)"
assert_grep 'git log.*--no-merges' "$SKILL_CREATE_PR" \
  "B: Step 7 uses git log --no-merges for commit-first title"

# ─── C. Branch-derived fallback retained ───────────────────────────────────
echo ""
echo "C: branch-derived kebab→spaces fallback retained"
assert_grep "tr '-' ' '" "$SKILL_CREATE_PR" \
  "C: kebab-to-spaces branch fallback still present"

# ─── D. Documents the convention string in prose ───────────────────────────
echo ""
echo "D: create-pr/SKILL.md documents the <type>(<scope>): <ticket> convention"
assert_grep '<type>\(<scope>\).*<ticket>|type.*scope.*ticket|conventional.*ticket|ticket.*convention' "$SKILL_CREATE_PR" \
  "D: Step 7 prose documents the PR title convention"

# ─── E. website/src/content/docs/reference/configuration.md documents draftPr.enabled
echo ""
echo "E: configuration.md documents orchestration.draftPr.enabled"
assert_grep 'draftPr\.enabled|draftPr' "$CONFIG_DOC" \
  "E: configuration.md mentions orchestration.draftPr.enabled"

# ─── F. docs/architecture.md contains a work record / draft-PR-early section ─
echo ""
echo "F: docs/architecture.md contains draft-PR-early / work record section"
assert_grep 'draft.*PR.*work record|work record.*draft PR|implement-plan-draft-pr-early|draft_pr_promote|draft.*implementing|ready.*in review' "$ARCH_DOC" \
  "F: architecture.md documents the PR-as-work-record convention"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "create-pr-title: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
