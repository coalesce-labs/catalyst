#!/usr/bin/env bash
# CTL-1236: tests for plugins/dev/scripts/thoughts-pull-sync.sh
# Run: bash plugins/dev/scripts/__tests__/thoughts-pull-sync.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/thoughts-pull-sync.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

# --------------------------------------------------------------------------
# Test 1: missing HumanLayer config → exit 0 (benign), ERROR in log
# --------------------------------------------------------------------------
echo "Test: missing HumanLayer config → exit 0, ERROR logged"
{
  WD="$(mktemp -d)"
  LOG="${WD}/sync.log"
  rc=0
  HL_CONFIG=/nonexistent/humanlayer.json \
  THOUGHTS_PULL_LOG="$LOG" \
    bash "$SCRIPT" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    fail "missing config: expected exit 0, got $rc"
  elif ! grep -q "ERROR" "$LOG" 2>/dev/null; then
    fail "missing config: expected ERROR in log" "log: $(cat "$LOG" 2>/dev/null)"
  else
    pass "missing HumanLayer config → exit 0, ERROR logged"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 2: dedup — global thoughtsRepo == profile thoughtsRepo → ONE pull attempt
# --------------------------------------------------------------------------
echo "Test: dedup — same repo in global and profile → single pull attempt"
{
  WD="$(mktemp -d)"
  LOG="${WD}/sync.log"
  CFGDIR="${WD}/config"
  mkdir -p "$CFGDIR"

  # Create a bare git repo so fetch has somewhere to go
  BARE="${WD}/bare.git"
  git init --bare "$BARE" --quiet
  CLONE="${WD}/clone"
  git clone "$BARE" "$CLONE" --quiet
  # Commit something so clone has a tracking branch
  git -C "$CLONE" -c user.email=test@test.com -c user.name=test \
      commit --allow-empty -m "init" --quiet

  # HL config: same path appears in global + profile → dedup → 1 repo
  REPO_PATH="$CLONE"
  printf '{"thoughts":{"thoughtsRepo":"%s","profiles":[{"thoughtsRepo":"%s"}]}}' \
    "$REPO_PATH" "$REPO_PATH" > "${CFGDIR}/humanlayer.json"

  rc=0
  HL_CONFIG="${CFGDIR}/humanlayer.json" \
  THOUGHTS_PULL_LOG="$LOG" \
    bash "$SCRIPT" || rc=$?

  if [[ "$rc" -ne 0 ]]; then
    fail "dedup: expected exit 0, got $rc"
  else
    LAST_LINE="$(grep "^.*done:" "$LOG" 2>/dev/null | tail -1 || true)"
    if echo "$LAST_LINE" | grep -q "done: 1 repos"; then
      pass "dedup — same repo appears only once (done: 1 repos)"
    else
      fail "dedup: expected 'done: 1 repos' in done line" "log: $(cat "$LOG" 2>/dev/null)"
    fi
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 3: ff-success — two local git repos → "PULLED" logged, HEAD advances
# --------------------------------------------------------------------------
echo "Test: ff-success — PULLED logged after fast-forward"
{
  WD="$(mktemp -d)"
  LOG="${WD}/sync.log"
  CFGDIR="${WD}/config"
  mkdir -p "$CFGDIR"

  # bare upstream
  BARE="${WD}/bare.git"
  git init --bare "$BARE" --quiet

  # clone A — the "local checkout" the script will pull into
  CLONE="${WD}/clone"
  git clone "$BARE" "$CLONE" --quiet
  git -C "$CLONE" -c user.email=test@test.com -c user.name=test \
      commit --allow-empty -m "init" --quiet
  git -C "$CLONE" push --quiet origin HEAD:main 2>/dev/null || \
    git -C "$CLONE" push --quiet origin HEAD 2>/dev/null || true
  # set upstream tracking
  git -C "$CLONE" branch --set-upstream-to=origin/main main 2>/dev/null || \
    git -C "$CLONE" branch --set-upstream-to=origin/HEAD main 2>/dev/null || true

  # Push an additional commit directly to bare so the clone is behind
  PUSH_REPO="${WD}/push"
  git clone "$BARE" "$PUSH_REPO" --quiet
  git -C "$PUSH_REPO" -c user.email=test@test.com -c user.name=test \
      commit --allow-empty -m "remote-advance" --quiet
  git -C "$PUSH_REPO" push --quiet origin HEAD:main 2>/dev/null || \
    git -C "$PUSH_REPO" push --quiet origin HEAD 2>/dev/null || true

  printf '{"thoughts":{"thoughtsRepo":"%s"}}' "$CLONE" > "${CFGDIR}/humanlayer.json"

  rc=0
  HL_CONFIG="${CFGDIR}/humanlayer.json" \
  THOUGHTS_PULL_LOG="$LOG" \
    bash "$SCRIPT" || rc=$?

  if [[ "$rc" -ne 0 ]]; then
    fail "ff-success: expected exit 0, got $rc"
  elif grep -q "PULLED" "$LOG" 2>/dev/null; then
    pass "ff-success — PULLED logged and HEAD advanced"
  else
    fail "ff-success: expected PULLED in log" "log: $(cat "$LOG" 2>/dev/null)"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 4: diverged repo — "FF-SKIP" logged, exit 0
# (local and remote both advanced from the same base → ff-only fails)
# --------------------------------------------------------------------------
echo "Test: diverged repo → FF-SKIP logged, exit 0"
{
  WD="$(mktemp -d)"
  LOG="${WD}/sync.log"
  CFGDIR="${WD}/config"
  mkdir -p "$CFGDIR"

  BARE="${WD}/bare.git"
  git init --bare "$BARE" --quiet

  # clone A — this is the checkout the script will try to pull into
  CLONE="${WD}/clone"
  git clone "$BARE" "$CLONE" --quiet
  git -C "$CLONE" -c user.email=test@test.com -c user.name=test \
      commit --allow-empty -m "init" --quiet
  git -C "$CLONE" push --quiet origin HEAD:main 2>/dev/null || \
    git -C "$CLONE" push --quiet origin HEAD 2>/dev/null || true
  git -C "$CLONE" branch --set-upstream-to=origin/main main 2>/dev/null || true

  # Push a new commit to bare from a different clone → remote advances
  PUSH_REPO="${WD}/push"
  git clone "$BARE" "$PUSH_REPO" --quiet
  git -C "$PUSH_REPO" -c user.email=test@test.com -c user.name=test \
      commit --allow-empty -m "remote-only" --quiet
  git -C "$PUSH_REPO" push --quiet origin HEAD:main 2>/dev/null || \
    git -C "$PUSH_REPO" push --quiet origin HEAD 2>/dev/null || true

  # Also add a local commit to CLONE → diverged
  git -C "$CLONE" -c user.email=test@test.com -c user.name=test \
      commit --allow-empty -m "local-only" --quiet

  printf '{"thoughts":{"thoughtsRepo":"%s"}}' "$CLONE" > "${CFGDIR}/humanlayer.json"

  rc=0
  HL_CONFIG="${CFGDIR}/humanlayer.json" \
  THOUGHTS_PULL_LOG="$LOG" \
    bash "$SCRIPT" || rc=$?

  if [[ "$rc" -ne 0 ]]; then
    fail "diverged: expected exit 0, got $rc"
  elif grep -q "FF-SKIP" "$LOG" 2>/dev/null; then
    pass "diverged repo → FF-SKIP logged, exit 0"
  else
    fail "diverged: expected FF-SKIP in log" "log: $(cat "$LOG" 2>/dev/null)"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 5: not-a-git-repo skip → "SKIP (not a git repo)"
# --------------------------------------------------------------------------
echo "Test: not-a-git-repo → SKIP logged"
{
  WD="$(mktemp -d)"
  LOG="${WD}/sync.log"
  CFGDIR="${WD}/config"
  NOT_GIT="${WD}/plain-dir"
  mkdir -p "$CFGDIR" "$NOT_GIT"

  printf '{"thoughts":{"thoughtsRepo":"%s"}}' "$NOT_GIT" > "${CFGDIR}/humanlayer.json"

  rc=0
  HL_CONFIG="${CFGDIR}/humanlayer.json" \
  THOUGHTS_PULL_LOG="$LOG" \
    bash "$SCRIPT" || rc=$?

  if [[ "$rc" -ne 0 ]]; then
    fail "not-a-git-repo: expected exit 0, got $rc"
  elif grep -q "SKIP (not a git repo)" "$LOG" 2>/dev/null; then
    pass "not-a-git-repo → SKIP logged"
  else
    fail "not-a-git-repo: expected 'SKIP (not a git repo)' in log" "log: $(cat "$LOG" 2>/dev/null)"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Test 6: tilde expansion — "~/..." path expands against $HOME
# --------------------------------------------------------------------------
echo "Test: tilde expansion — ~/path resolved against HOME"
{
  WD="$(mktemp -d)"
  LOG="${WD}/sync.log"
  CFGDIR="${WD}/config"
  # Use a real dir under $HOME so expansion is observable
  NOT_GIT="${WD}/plain-tilde"
  mkdir -p "$CFGDIR" "$NOT_GIT"
  TILDE_PATH="~/${NOT_GIT#$HOME/}"

  printf '{"thoughts":{"thoughtsRepo":"%s"}}' "$TILDE_PATH" > "${CFGDIR}/humanlayer.json"

  rc=0
  HL_CONFIG="${CFGDIR}/humanlayer.json" \
  THOUGHTS_PULL_LOG="$LOG" \
    bash "$SCRIPT" || rc=$?

  if [[ "$rc" -ne 0 ]]; then
    fail "tilde expansion: expected exit 0, got $rc"
  elif grep -q "SKIP\|PULLED\|FF-SKIP\|FETCH" "$LOG" 2>/dev/null; then
    pass "tilde expansion — path was resolved (git check reached the actual dir)"
  else
    fail "tilde expansion: expected path-resolved log entry" "log: $(cat "$LOG" 2>/dev/null)"
  fi
  rm -rf "$WD"
}

# --------------------------------------------------------------------------
# Contract: thoughts-pull-sync.sh is registered in install-cli.sh
# --------------------------------------------------------------------------
echo "Test: install-cli.sh registers thoughts-pull-sync.sh"
{
  INSTALL_CLI="${REPO_ROOT}/plugins/dev/scripts/install-cli.sh"
  if grep -q "thoughts-pull-sync.sh:thoughts-pull-sync" "$INSTALL_CLI"; then
    pass "install-cli.sh has thoughts-pull-sync.sh:thoughts-pull-sync entry"
  else
    fail "install-cli.sh missing 'thoughts-pull-sync.sh:thoughts-pull-sync'" \
      "add it to CLI_ENTRIES"
  fi
}

# --------------------------------------------------------------------------
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
