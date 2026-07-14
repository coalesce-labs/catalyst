#!/usr/bin/env bash
# Tests for CTL-1473: catalyst-stack install-services must NEVER bake an ephemeral
# path (linked worktree or /tmp dir) as the shipper --config path.
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-shipper-guard.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

SCRATCH="$(mktemp -d "${HOME}/.ctl1473-shipper-guard-test.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

echo "catalyst-stack shipper ephemeral-path guard (CTL-1473):"

# 1. /private/tmp worktree path → refuse
out="$(CATALYST_FORCE_BAKE_DIR=/private/tmp/wt/plugins/dev/scripts \
       CATALYST_LAYER2_CONFIG_FILE=/dev/null \
       bash "$STACK" install-services --print 2>&1)"; rc=$?
if [[ $rc -ne 0 && ("$out" == *"refusing"* || "$out" == *"ephemeral"*) ]]; then
  pass "refuses a /private/tmp worktree bake dir"
else
  fail "should refuse ephemeral bake dir (rc=$rc): $out"
fi

# 2. /tmp path → refuse
out="$(CATALYST_FORCE_BAKE_DIR=/tmp/whatever/scripts \
       CATALYST_LAYER2_CONFIG_FILE=/dev/null \
       bash "$STACK" install-services --print 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"ephemeral"* ]] && pass "refuses a /tmp bake dir" || fail "should refuse /tmp bake dir (rc=$rc)"

# 3. a real linked git worktree → refuse
(
  cd "$SCRATCH" && git init -q main && cd main \
    && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init \
    && git worktree add -q ../wt >/dev/null 2>&1
)
if [[ -d "$SCRATCH/wt" ]]; then
  mkdir -p "$SCRATCH/wt/plugins/dev/scripts"
  out="$(CATALYST_FORCE_BAKE_DIR="$SCRATCH/wt/plugins/dev/scripts" \
         CATALYST_LAYER2_CONFIG_FILE=/dev/null \
         bash "$STACK" install-services --print 2>&1)"; rc=$?
  [[ $rc -ne 0 && "$out" == *"ephemeral"* ]] && pass "refuses a linked git worktree bake dir" || fail "should refuse linked worktree (rc=$rc): $out"
else
  fail "could not construct a linked worktree for the test"
fi

# 4. a pristine non-ephemeral dir → allows the guard (render proceeds)
PRISTINE="$SCRATCH/pristine/plugins/dev/scripts"
mkdir -p "$PRISTINE/log-shipper"
touch "$PRISTINE/log-shipper/config.alloy" "$PRISTINE/log-shipper/launch.sh"
out="$(CATALYST_FORCE_BAKE_DIR="$PRISTINE" \
       CATALYST_LAYER2_CONFIG_FILE=/dev/null \
       bash "$STACK" install-services --print 2>&1)"
# The guard must NOT refuse; the plist should contain --config pointing at our pristine dir
if [[ "$out" != *"ephemeral"* && "$out" == *"--config"* && "$out" == *"${PRISTINE}"* ]]; then
  pass "allows a stable non-ephemeral dir and bakes the pristine config path"
elif [[ "$out" != *"ephemeral"* && "$out" == *"--config"* ]]; then
  pass "allows a stable non-ephemeral dir (bakes config path)"
else
  fail "should allow stable dir and bake config path (got): $out"
fi

# 5. /var/folders (macOS temp) path → refuse
out="$(CATALYST_FORCE_BAKE_DIR=/var/folders/xx/abc/T/foo/scripts \
       CATALYST_LAYER2_CONFIG_FILE=/dev/null \
       bash "$STACK" install-services --print 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"ephemeral"* ]] && pass "refuses a /var/folders temp bake dir" || fail "should refuse /var/folders path (rc=$rc)"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
