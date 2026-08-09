#!/usr/bin/env bash
# Unit tests for plugins/dev/scripts/lib/phase-signal-freshness.sh (CTL-1667).
# Tests the is_poststale_signal predicate in isolation (no dispatch involved).
#
# Run: bash plugins/dev/scripts/lib/__tests__/phase-signal-freshness.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../phase-signal-freshness.sh"

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

[ -f "$HELPER" ] || { echo "FATAL: helper not found: $HELPER" >&2; exit 1; }

# shellcheck source=../phase-signal-freshness.sh
source "$HELPER"

SCRATCH="$(mktemp -d -t phase-freshness-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

# Helper: write a minimal signal JSON
write_signal() {
  local path="$1"; shift
  local json="$1"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$json" > "$path"
}

# Helper: compute an ISO-8601 timestamp offset from now (macOS + GNU portable)
ts_offset() {
  local delta="$1"  # e.g. "-3600" (1 hour ago) or "+3600" (1 hour from now)
  if date -v "${delta}S" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null >&2; then
    date -v "${delta}S" -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
  else
    date -u -d "${delta} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
  fi
}

YESTERDAY="$(ts_offset "-86400")"   # 24 hours ago
NOW="$(ts_offset "0")"              # now (for phase-pr.json)
FUTURE="$(ts_offset "+3600")"       # 1 hour from now (signal newer than pr)

echo "phase-signal-freshness unit tests"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "Case A: monitor-merge signal older than phase-pr.json → STALE (exit 0)"
D_A="$SCRATCH/case-a"
write_signal "$D_A/phase-pr.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$NOW\",\"pr\":{\"number\":200}}"
write_signal "$D_A/phase-monitor-merge.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$YESTERDAY\",\"pr\":{\"number\":100,\"mergedAt\":\"$YESTERDAY\",\"ciStatus\":\"merged\"}}"

is_poststale_signal "$D_A" "monitor-merge"
RC_A=$?
if [ "$RC_A" -eq 0 ]; then
  ok "Case A: signal older than phase-pr → STALE (exit 0)"
else
  fail "Case A: signal older than phase-pr → STALE (exit 0)" "got exit $RC_A"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case B: monitor-merge .pr.number != phase-pr .pr.number (same/newer ts) → STALE"
D_B="$SCRATCH/case-b"
write_signal "$D_B/phase-pr.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$NOW\",\"pr\":{\"number\":200}}"
write_signal "$D_B/phase-monitor-merge.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$FUTURE\",\"pr\":{\"number\":100,\"mergedAt\":\"$NOW\",\"ciStatus\":\"merged\"}}"

is_poststale_signal "$D_B" "monitor-merge"
RC_B=$?
if [ "$RC_B" -eq 0 ]; then
  ok "Case B: PR-number mismatch → STALE (exit 0) even if signal is newer"
else
  fail "Case B: PR-number mismatch → STALE (exit 0) even if signal is newer" "got exit $RC_B"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case C: monitor-merge newer than phase-pr AND same .pr.number → FRESH (exit 1)"
D_C="$SCRATCH/case-c"
write_signal "$D_C/phase-pr.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$YESTERDAY\",\"pr\":{\"number\":200}}"
write_signal "$D_C/phase-monitor-merge.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$NOW\",\"pr\":{\"number\":200,\"mergedAt\":\"$NOW\",\"ciStatus\":\"merged\"}}"

is_poststale_signal "$D_C" "monitor-merge"
RC_C=$?
if [ "$RC_C" -ne 0 ]; then
  ok "Case C: same PR# + newer ts → FRESH (exit 1)"
else
  fail "Case C: same PR# + newer ts → FRESH (exit 1)" "got exit $RC_C (0=stale)"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case D: no phase-pr.json present → FRESH (cannot prove stale)"
D_D="$SCRATCH/case-d"
mkdir -p "$D_D"
write_signal "$D_D/phase-monitor-merge.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$YESTERDAY\",\"pr\":{\"number\":100}}"
# no phase-pr.json written

is_poststale_signal "$D_D" "monitor-merge"
RC_D=$?
if [ "$RC_D" -ne 0 ]; then
  ok "Case D: no phase-pr.json → FRESH (exit 1, conservative)"
else
  fail "Case D: no phase-pr.json → FRESH (exit 1, conservative)" "got exit $RC_D (0=stale)"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case E: non-post-PR phase (implement) → always FRESH (out of scope)"
D_E="$SCRATCH/case-e"
write_signal "$D_E/phase-pr.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$NOW\",\"pr\":{\"number\":200}}"
write_signal "$D_E/phase-implement.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$YESTERDAY\"}"

is_poststale_signal "$D_E" "implement"
RC_E=$?
if [ "$RC_E" -ne 0 ]; then
  ok "Case E: non-post-PR phase → FRESH (exit 1)"
else
  fail "Case E: non-post-PR phase → FRESH (exit 1)" "got exit $RC_E (0=stale)"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case F: malformed/absent timestamps → FRESH (fail-safe)"
D_F="$SCRATCH/case-f"
write_signal "$D_F/phase-pr.json" \
  "{\"status\":\"done\",\"pr\":{\"number\":200}}"
# no updatedAt in either signal
write_signal "$D_F/phase-monitor-merge.json" \
  "{\"status\":\"done\",\"pr\":{\"number\":100}}"

is_poststale_signal "$D_F" "monitor-merge"
RC_F=$?
# PR-number mismatch (100 vs 200) IS definitive staleness even with missing timestamps
if [ "$RC_F" -eq 0 ]; then
  ok "Case F: PR-number mismatch with missing timestamps → STALE (PR-number check before timestamp check)"
else
  fail "Case F: PR-number mismatch with missing timestamps → STALE" "got exit $RC_F"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case F2: malformed/absent timestamps, same PR# → FRESH (fail-safe)"
D_F2="$SCRATCH/case-f2"
write_signal "$D_F2/phase-pr.json" \
  "{\"status\":\"done\",\"pr\":{\"number\":200}}"
write_signal "$D_F2/phase-monitor-merge.json" \
  "{\"status\":\"done\",\"pr\":{\"number\":200}}"
# no updatedAt anywhere — cannot determine ordering

is_poststale_signal "$D_F2" "monitor-merge"
RC_F2=$?
if [ "$RC_F2" -ne 0 ]; then
  ok "Case F2: same PR# + missing timestamps → FRESH (exit 1, fail-safe)"
else
  fail "Case F2: same PR# + missing timestamps → FRESH (exit 1, fail-safe)" "got exit $RC_F2 (0=stale)"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case G: teardown signal stale → STALE (all three post-PR phases covered)"
D_G="$SCRATCH/case-g"
write_signal "$D_G/phase-pr.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$NOW\",\"pr\":{\"number\":200}}"
write_signal "$D_G/phase-teardown.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$YESTERDAY\"}"

is_poststale_signal "$D_G" "teardown"
RC_G=$?
if [ "$RC_G" -eq 0 ]; then
  ok "Case G: stale teardown signal → STALE (exit 0)"
else
  fail "Case G: stale teardown signal → STALE (exit 0)" "got exit $RC_G"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case H: monitor-deploy signal stale → STALE"
D_H="$SCRATCH/case-h"
write_signal "$D_H/phase-pr.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$NOW\",\"pr\":{\"number\":200}}"
write_signal "$D_H/phase-monitor-deploy.json" \
  "{\"status\":\"done\",\"updatedAt\":\"$YESTERDAY\"}"

is_poststale_signal "$D_H" "monitor-deploy"
RC_H=$?
if [ "$RC_H" -eq 0 ]; then
  ok "Case H: stale monitor-deploy signal → STALE (exit 0)"
else
  fail "Case H: stale monitor-deploy signal → STALE (exit 0)" "got exit $RC_H"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "─── Results ───────────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
