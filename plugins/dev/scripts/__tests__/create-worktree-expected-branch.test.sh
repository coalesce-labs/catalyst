#!/usr/bin/env bash
# Shell tests for create-worktree.sh --expected-branch (CTL-615).
#
# The flag's purpose is to guard --reuse-existing against landing in a
# worktree directory that has been re-purposed for a different branch.
# This is the wrong-cwd ADV-1134 signature: same on-disk path, different
# `git rev-parse --abbrev-ref HEAD`.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/create-worktree.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t expected-branch-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

# Build a real git repo + a stranger worktree at the canonical reuse path.
REPO="${SCRATCH}/source-repo"
mkdir -p "${REPO}"
git -C "${REPO}" init -q
git -C "${REPO}" -c user.email=t@t -c user.name=t commit --allow-empty -q -m init
# Override default branch name to "main" so the repo has a canonical base.
git -C "${REPO}" branch -m main 2>/dev/null || true

# Pre-create a stranger worktree at the path create-worktree.sh will reuse,
# checked out to a different branch (ADV-1129).
WORKTREES_BASE="${SCRATCH}/wt"
mkdir -p "${WORKTREES_BASE}"
git -C "${REPO}" worktree add -q -b "ADV-1129" "${WORKTREES_BASE}/CTL-T3" main

# ─── Test 1: --expected-branch mismatch under --reuse-existing → exit 64 ───
echo ""
echo "--- Test 1: --expected-branch mismatch exits 64 with diagnostic ---"
out=$(
  cd "${REPO}" && \
  bash "${SCRIPT}" CTL-T3 main \
    --reuse-existing \
    --worktree-dir "${WORKTREES_BASE}" \
    --skip-fetch \
    --expected-branch CTL-T3 2>&1
)
rc=$?
if [[ $rc -eq 64 ]]; then
  pass "exit code is 64 (expected-branch mismatch sentinel)"
else
  fail "expected exit 64, got $rc — output: $out"
fi
if echo "$out" | grep -q "expected-branch mismatch"; then
  pass "diagnostic mentions 'expected-branch mismatch'"
else
  fail "diagnostic missing 'expected-branch mismatch' — output: $out"
fi
if echo "$out" | grep -q "ADV-1129"; then
  pass "diagnostic includes actual branch name"
else
  fail "diagnostic missing actual branch — output: $out"
fi

# ─── Test 2: --expected-branch matching reuses worktree silently (exit 0) ──
echo ""
echo "--- Test 2: --expected-branch match short-circuits cleanly ---"
# Add a matching worktree at the path the script will compute for ticket CTL-T4
git -C "${REPO}" worktree add -q -b "CTL-T4" "${WORKTREES_BASE}/CTL-T4" main
out2=$(
  cd "${REPO}" && \
  bash "${SCRIPT}" CTL-T4 main \
    --reuse-existing \
    --worktree-dir "${WORKTREES_BASE}" \
    --skip-fetch \
    --expected-branch CTL-T4 2>&1
)
rc2=$?
if [[ $rc2 -eq 0 ]]; then
  pass "match → exit 0"
else
  fail "expected exit 0, got $rc2 — output: $out2"
fi
if echo "$out2" | grep -q "WORKTREE_PATH=${WORKTREES_BASE}/CTL-T4"; then
  pass "WORKTREE_PATH= line still printed on match"
else
  fail "WORKTREE_PATH= line missing — output: $out2"
fi

# ─── Test 3: --expected-branch omitted → legacy behaviour (no validation) ──
echo ""
echo "--- Test 3: --expected-branch omitted (legacy) — no check, exit 0 ---"
# Reuse the ADV-1129 stranger worktree from Test 1 — without the flag, the
# script must NOT validate and must short-circuit successfully.
out3=$(
  cd "${REPO}" && \
  bash "${SCRIPT}" CTL-T3 main \
    --reuse-existing \
    --worktree-dir "${WORKTREES_BASE}" \
    --skip-fetch 2>&1
)
rc3=$?
if [[ $rc3 -eq 0 ]]; then
  pass "no flag → exit 0 (backwards compatible)"
else
  fail "expected exit 0 without flag, got $rc3 — output: $out3"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo " ${PASSES} passed, ${FAILURES} failed"
echo "══════════════════════════════════════════════"

if [[ "${FAILURES}" -gt 0 ]]; then
  exit 1
fi
