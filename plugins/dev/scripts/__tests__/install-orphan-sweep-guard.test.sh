#!/usr/bin/env bash
# Tests for CTL-1306: install-orphan-sweep.sh must NEVER bake an ephemeral path
# (a linked git worktree or a /tmp dir) into the LaunchAgent — that path can be
# deleted, silently killing the reaper (exit 127). It must refuse such targets.
# Run: bash plugins/dev/scripts/__tests__/install-orphan-sweep-guard.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALLER="${REPO_ROOT}/plugins/dev/scripts/install-orphan-sweep.sh"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

# Run --print-only with an injected BAKE_DIR and no real machine config, capturing
# combined output + exit code. CATALYST_FORCE_BAKE_DIR / CATALYST_LAYER2_CONFIG_FILE
# are the test seams the installer exposes.
run_guard() {
  CATALYST_FORCE_BAKE_DIR="$1" CATALYST_LAYER2_CONFIG_FILE=/dev/null \
    bash "$INSTALLER" --print-only 2>&1
}

echo "install-orphan-sweep guard (CTL-1306):"

# 1. /private/tmp worktree path → refuse
out="$(run_guard /private/tmp/pr1827-wt/plugins/dev/scripts)"; rc=$?
if [[ $rc -ne 0 && "$out" == *"refusing to install from an ephemeral path"* ]]; then
  pass "refuses a /private/tmp worktree path"
else
  fail "should refuse /private/tmp path (rc=$rc): $out"
fi

# 2. /tmp path → refuse
out="$(run_guard /tmp/whatever/scripts)"; rc=$?
[[ $rc -ne 0 && "$out" == *"ephemeral path"* ]] && pass "refuses a /tmp path" || fail "should refuse /tmp path (rc=$rc)"

# 3. a real linked git worktree → refuse (detected via .git/worktrees/ git dir)
SCRATCH="$(mktemp -d "${HOME}/.ctl1306-guard-test.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
(
  cd "$SCRATCH" && git init -q main && cd main \
    && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init \
    && git worktree add -q ../wt >/dev/null 2>&1
)
if [[ -d "$SCRATCH/wt" ]]; then
  mkdir -p "$SCRATCH/wt/plugins/dev/scripts"
  out="$(run_guard "$SCRATCH/wt/plugins/dev/scripts")"; rc=$?
  [[ $rc -ne 0 && "$out" == *"ephemeral path"* ]] && pass "refuses a linked git worktree" || fail "should refuse linked worktree (rc=$rc): $out"
else
  fail "could not construct a linked worktree for the test"
fi

# 4. a plain non-git, non-temp dir → passes the guard (fails later on missing
#    template, but the refusal message must be ABSENT)
REAL="$SCRATCH/realclone/plugins/dev/scripts"; mkdir -p "$REAL"
out="$(run_guard "$REAL")"
[[ "$out" != *"refusing to install from an ephemeral path"* ]] && pass "allows a stable non-ephemeral dir" || fail "should NOT refuse a stable dir: $out"

echo "  ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
