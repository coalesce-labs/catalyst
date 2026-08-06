#!/usr/bin/env bash
# Tests for the CTL-1639 salvage-before-destroy wiring at the three bash sites:
#   1. phase-agent-dispatch  (L3 destroy+recreate)
#   2. orphan-sweep.sh       (SAFE / SALVAGE_UNPUSHED / SALVAGE_DIRTY)
#   3. phase-teardown/SKILL.md (worktree-removal block)
#
# These are DETERMINISTIC source-order invariants: each site must (a) source the
# salvage lib and (b) place its `salvage_worktree` call BEFORE the destructive
# git op it guards. Behavioral coverage of the primitive lives in
# lib/__tests__/worktree-salvage.test.sh; the orphan-sweep runtime path is
# exercised by __tests__/orphan-sweep.test.sh (T26*). This suite guards the
# wiring so a future refactor can't silently move a destroy ahead of its salvage.
#
# Run: bash plugins/dev/scripts/__tests__/worktree-salvage-sites.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPTS_DIR}/../../.." && pwd)"

DISPATCH="${SCRIPTS_DIR}/phase-agent-dispatch"
SWEEP="${SCRIPTS_DIR}/orphan-sweep.sh"
TEARDOWN="${REPO_ROOT}/plugins/dev/skills/phase-teardown/SKILL.md"

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

# first_line PATTERN FILE — 1-based line number of the first grep -nE match, or "".
first_line() { grep -nE "$2" "$1" 2>/dev/null | head -1 | cut -d: -f1; }

assert_sources_lib() {
  local file="$1" label="$2"
  if grep -qE 'lib/worktree-salvage\.sh' "$file"; then pass "$label sources worktree-salvage.sh"
  else fail "$label does NOT source worktree-salvage.sh"; fi
}

# assert_salvage_before <file> <salvage-pattern> <destroy-pattern> <label>
assert_salvage_before() {
  local file="$1" salv="$2" destroy="$3" label="$4"
  local sline dline
  sline="$(first_line "$file" "$salv")"
  dline="$(first_line "$file" "$destroy")"
  if [[ -z "$sline" ]]; then fail "$label — no salvage_worktree call found"; return; fi
  if [[ -z "$dline" ]]; then fail "$label — no destructive op found (pattern drift?)"; return; fi
  if [[ "$sline" -lt "$dline" ]]; then pass "$label — salvage (L${sline}) precedes destroy (L${dline})"
  else fail "$label — salvage (L${sline}) does NOT precede destroy (L${dline})"; fi
}

echo "worktree-salvage-sites tests (CTL-1639)"

# ── Site 1: phase-agent-dispatch L3 destroy+recreate ────────────────────────
echo "1. phase-agent-dispatch (L3 recreate)"
assert_sources_lib "$DISPATCH" "dispatcher"
assert_salvage_before "$DISPATCH" \
  'salvage_worktree "\$_WT_PATH" "\$TICKET"' \
  'worktree remove --force "\$_WT_PATH"' \
  "dispatch-l3-recreate"
if grep -qE 'salvage_worktree "\$_WT_PATH" "\$TICKET"' "$DISPATCH" \
   && grep -qE '\-\-site "dispatch-l3-recreate"' "$DISPATCH"; then
  pass "dispatcher call carries --site dispatch-l3-recreate"
else fail "dispatcher call missing --site dispatch-l3-recreate"; fi

# ── Site 2: orphan-sweep.sh ─────────────────────────────────────────────────
echo "2. orphan-sweep.sh"
assert_sources_lib "$SWEEP" "orphan-sweep"
# SAFE salvage precedes the SAFE force-remove.
assert_salvage_before "$SWEEP" \
  '\-\-site "orphan-sweep-safe"' \
  'git worktree remove --force "\$wt"' \
  "orphan-sweep SAFE"
# SALVAGE_UNPUSHED salvage runs at branch top (before the SWEEP_SALVAGE_PUSH gate).
if grep -qE '\-\-site "orphan-sweep-unpushed"' "$SWEEP"; then
  usline="$(first_line "$SWEEP" '\-\-site "orphan-sweep-unpushed"')"
  ugate="$(first_line "$SWEEP" 'if \[\[ "\$SWEEP_SALVAGE_PUSH" == "1" \]\]')"
  if [[ -n "$usline" && -n "$ugate" && "$usline" -lt "$ugate" ]]; then
    pass "orphan-sweep UNPUSHED salvage (L${usline}) precedes the SWEEP_SALVAGE_PUSH gate (L${ugate}) — push-flag-independent"
  else fail "orphan-sweep UNPUSHED salvage is not before the push-flag gate (L${usline:-?} vs L${ugate:-?})"; fi
else fail "orphan-sweep missing --site orphan-sweep-unpushed"; fi
# SALVAGE_DIRTY salvage precedes the keep-log line (snapshot-then-skip).
assert_salvage_before "$SWEEP" \
  '\-\-site "orphan-sweep-dirty"' \
  'skip SALVAGE_DIRTY .snapshotted' \
  "orphan-sweep DIRTY"

# ── Site 3: phase-teardown/SKILL.md ─────────────────────────────────────────
echo "3. phase-teardown/SKILL.md"
assert_sources_lib "$TEARDOWN" "phase-teardown"
assert_salvage_before "$TEARDOWN" \
  'salvage_worktree "\$WORKTREE_PATH" "\$TICKET"' \
  'git worktree remove "\$WORKTREE_PATH"' \
  "phase-teardown"
if grep -qE '\-\-site "phase-teardown"' "$TEARDOWN"; then
  pass "phase-teardown call carries --site phase-teardown"
else fail "phase-teardown call missing --site phase-teardown"; fi

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
