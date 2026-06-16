#!/usr/bin/env bash
# catalyst-doctor.test.sh — dispatcher contract tests (CTL-1186)

set -uo pipefail

DISPATCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/catalyst-doctor"

fails=0
check() { if eval "$2"; then echo "ok - $1"; else echo "FAIL - $1"; fails=$((fails+1)); fi; }

# Test 1: dispatcher passes --json through and emits JSON with an "ok" key.
# Capture output separately (|| true) so doctor's non-zero exit code doesn't
# pollute the JSON-shape check under pipefail.
check "--json emits JSON with ok key" \
  '{ JSON=$("$DISPATCH" --json 2>/dev/null || true); echo "$JSON" | jq -e '"'"'has("ok")'"'"' >/dev/null 2>&1; }'

# Test 2: --json emits JSON with ok key AND a non-empty checks array.
check "--json checks array is non-empty" \
  '{ JSON=$("$DISPATCH" --json 2>/dev/null || true); echo "$JSON" | jq -e '"'"'.checks | length > 0'"'"' >/dev/null 2>&1; }'

# Test 3: missing module fails (dispatcher contract: guard fires before JS).
check "missing module fails" \
  '! ( DOCTOR_MJS=/nonexistent "$DISPATCH" 2>/dev/null )'

[[ $fails -eq 0 ]] || { echo "$fails check(s) failed"; exit 1; }
echo "all dispatcher checks passed"
