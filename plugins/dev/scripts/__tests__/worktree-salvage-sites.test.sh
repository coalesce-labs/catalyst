#!/usr/bin/env bash
# Tests for the CTL-1639 salvage-before-destroy wiring at the three bash sites:
#   1. phase-agent-dispatch  (L3 destroy+recreate)
#   2. orphan-sweep.sh       (SAFE / SALVAGE_UNPUSHED / SALVAGE_DIRTY)
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

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

# first_line PATTERN FILE — 1-based line number of the first grep -nE match, or "".
first_line() { grep -nE "$2" "$1" 2>/dev/null | head -1 | cut -d: -f1; }

# assert_sources_lib <file> <label> — Codex round-2 P2: a bare substring match
# on "lib/worktree-salvage.sh" stays green even after the actual EXECUTABLE
# `source` statement is deleted, as long as an unrelated occurrence of the
# filename survives elsewhere in the file — dispatcher/orphan-sweep both carry
# a `# shellcheck source=lib/worktree-salvage.sh` comment, and phase-teardown
# assigns the path to `WT_SALVAGE_LIB` on one line and sources `$WT_SALVAGE_LIB`
# (no literal filename at all) on another. Require a REAL `source`/`.` command
# whose argument resolves to the salvage-lib path — either the literal path
# right there in the source line, or a $VAR that some assignment in the file
# sets to that literal path.
assert_sources_lib() {
  local file="$1" label="$2"
  local src_lines
  src_lines="$(grep -nE '(^|&&[[:space:]]*|;[[:space:]]*)(source|\.)[[:space:]]+"?\$?\{?[A-Za-z_][A-Za-z0-9_]*\}?"?' "$file" 2>/dev/null || true)"
  if [[ -z "$src_lines" ]]; then
    fail "$label does NOT contain any source statement"
    return
  fi
  local line lineno arg var
  while IFS= read -r line; do
    lineno="${line%%:*}"
    arg="${line#*:}"
    arg="$(printf '%s' "$arg" | sed -E 's/^.*(source|\.)[[:space:]]+//')"
    # Case (a): the literal salvage-lib path is right there in the source line.
    if printf '%s' "$arg" | grep -qE 'lib/worktree-salvage\.sh'; then
      pass "$label sources worktree-salvage.sh (literal, L${lineno})"; return
    fi
    # Case (b): the argument is a $VAR/${VAR} — confirm some assignment in the
    # file actually set that exact variable to the salvage-lib path.
    var="$(printf '%s' "$arg" | sed -E 's/^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?.*$/\1/')"
    if [[ -n "$var" ]] && grep -qE "${var}=.*lib/worktree-salvage\.sh" "$file"; then
      pass "$label sources worktree-salvage.sh (via \$${var}, L${lineno})"; return
    fi
  done <<<"$src_lines"
  fail "$label does NOT source worktree-salvage.sh (a source statement exists but none resolve to the salvage lib)"
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

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
