#!/usr/bin/env bash
# Shell tests for scripts/install-dev-marketplace.sh.
# Run: bash plugins/dev/scripts/__tests__/install-dev-marketplace.test.sh
#
# Covers worktree-guard behavior (CTL-120): refuse to register a linked git
# worktree as a plugin marketplace unless --allow-worktree is passed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALL_SCRIPT="${REPO_ROOT}/scripts/install-dev-marketplace.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Build a fake Catalyst main checkout (git repo) with the install script copied
# in, plus a linked worktree for worktree-guard tests. Stubs `claude` via env.
setup_repo() {
  local main="$1"
  local branch="${2:-main}"
  rm -rf "$main"
  mkdir -p "$main/scripts"
  mkdir -p "$main/.claude-plugin"
  echo '{}' > "$main/.claude-plugin/marketplace.json"
  cp "$INSTALL_SCRIPT" "$main/scripts/install-dev-marketplace.sh"
  (
    cd "$main"
    git init -q -b "$branch"
    git config user.email "t@t" && git config user.name "t"
    git add -A
    git commit -q -m "init"
  )
}

add_worktree() {
  local main="$1" wt="$2" branch="$3"
  (cd "$main" && git worktree add -q -b "$branch" "$wt")
  # The worktree shares scripts/install-dev-marketplace.sh with main via checkout.
}

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

expect_exit() {
  local expected="$1"; shift
  set +e
  "$@" > "${SCRATCH}/out" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" = "$expected" ]]; then
    return 0
  else
    echo "    expected rc=$expected got rc=$rc"
    sed 's/^/    /' "${SCRATCH}/out"
    return 1
  fi
}

expect_contains() {
  local file="$1" needle="$2"
  if grep -qF -- "$needle" "$file"; then
    return 0
  else
    echo "    missing: $needle"
    echo "    in:"
    sed 's/^/      /' "$file"
    return 1
  fi
}

echo "install-dev-marketplace tests"

# ── 1. --help exits 0 and prints usage ─────────────────────────────────────
run "--help exits 0 and prints usage" bash -c "
  CATALYST_CLAUDE_CMD=echo $INSTALL_SCRIPT --help 2>&1 | grep -qi 'usage'
"

# ── 2. -h exits 0 and prints usage ─────────────────────────────────────────
run "-h exits 0 and prints usage" bash -c "
  CATALYST_CLAUDE_CMD=echo $INSTALL_SCRIPT -h 2>&1 | grep -qi 'usage'
"

# ── 3. unknown flag exits non-zero ─────────────────────────────────────────
run "unknown flag exits non-zero" expect_exit 1 bash -c "
  CATALYST_CLAUDE_CMD=echo $INSTALL_SCRIPT --bogus 2>&1
"

# ── 4. runs successfully from main worktree ───────────────────────────────
MAIN1="$SCRATCH/repo1"
setup_repo "$MAIN1" "main"
run "runs from main worktree (exit 0)" bash -c "
  CATALYST_CLAUDE_CMD=echo bash '$MAIN1/scripts/install-dev-marketplace.sh' > '$SCRATCH/out1' 2>&1
"
run "main-worktree output invokes claude with main path" bash -c "
  grep -qE 'plugin marketplace add .*$MAIN1' '$SCRATCH/out1'
"
run "main-worktree output prints branch name" expect_contains "$SCRATCH/out1" "branch=main"

# ── 5. refuses from linked worktree without --allow-worktree ─────────────
MAIN2="$SCRATCH/repo2"
WT2="$SCRATCH/repo2-wt-CTL-999"
setup_repo "$MAIN2" "main"
add_worktree "$MAIN2" "$WT2" "CTL-999"
run "linked worktree without flag exits non-zero" expect_exit 1 bash -c "
  CATALYST_CLAUDE_CMD=echo bash '$WT2/scripts/install-dev-marketplace.sh' 2>&1
"
set +e
CATALYST_CLAUDE_CMD=echo bash "$WT2/scripts/install-dev-marketplace.sh" > "$SCRATCH/out2" 2>&1
set -e
run "linked-worktree error mentions worktree" expect_contains "$SCRATCH/out2" "worktree"
run "linked-worktree error includes main path" expect_contains "$SCRATCH/out2" "$MAIN2"
run "linked-worktree error includes --allow-worktree" expect_contains "$SCRATCH/out2" "--allow-worktree"
run "linked-worktree error includes branch name" expect_contains "$SCRATCH/out2" "CTL-999"
run "linked-worktree does NOT invoke claude (stub)" bash -c "
  ! grep -qE 'plugin marketplace add' '$SCRATCH/out2'
"

# ── 6. linked worktree with --allow-worktree proceeds ────────────────────
MAIN3="$SCRATCH/repo3"
WT3="$SCRATCH/repo3-wt-CTL-42"
setup_repo "$MAIN3" "main"
add_worktree "$MAIN3" "$WT3" "CTL-42"
run "linked worktree with --allow-worktree succeeds" bash -c "
  CATALYST_CLAUDE_CMD=echo bash '$WT3/scripts/install-dev-marketplace.sh' --allow-worktree > '$SCRATCH/out3' 2>&1
"
run "allow-worktree invokes claude with worktree path" bash -c "
  grep -qE 'plugin marketplace add .*$WT3' '$SCRATCH/out3'
"
run "allow-worktree still warns" expect_contains "$SCRATCH/out3" "warning"

# ── 7. --scope still works alongside --allow-worktree ────────────────────
run "--scope project still parses" bash -c "
  CATALYST_CLAUDE_CMD=echo bash '$MAIN3/scripts/install-dev-marketplace.sh' --scope project > '$SCRATCH/out4' 2>&1
  grep -qE 'scope project' '$SCRATCH/out4'
"

# ── 8. flag order is tolerant (--allow-worktree before --scope) ──────────
run "flags in either order parse" bash -c "
  CATALYST_CLAUDE_CMD=echo bash '$WT3/scripts/install-dev-marketplace.sh' --allow-worktree --scope local > '$SCRATCH/out5' 2>&1
  grep -qE 'scope local' '$SCRATCH/out5'
"

# ── 9. missing .claude-plugin/marketplace.json still errors ──────────────
BAD="$SCRATCH/not-a-catalyst"
mkdir -p "$BAD/scripts"
cp "$INSTALL_SCRIPT" "$BAD/scripts/install-dev-marketplace.sh"
(cd "$BAD" && git init -q -b main && git config user.email t@t && git config user.name t \
  && git add -A && git commit -q -m init)
run "missing marketplace.json errors" expect_exit 1 bash -c "
  CATALYST_CLAUDE_CMD=echo bash '$BAD/scripts/install-dev-marketplace.sh' 2>&1
"

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASSES + FAILURES))
echo "install-dev-marketplace: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
