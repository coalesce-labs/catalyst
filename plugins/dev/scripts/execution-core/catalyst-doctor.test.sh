#!/usr/bin/env bash
# catalyst-doctor.test.sh — dispatcher contract tests (CTL-1186)

set -uo pipefail

DISPATCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/catalyst-doctor"

fails=0
check() { if eval "$2"; then echo "ok - $1"; else echo "FAIL - $1"; fails=$((fails+1)); fi; }

check "--json yields .ok" \
  '"$DISPATCH" --json | jq -e '"'"'has("ok")'"'"' >/dev/null 2>&1'

rc=0
"$DISPATCH" >/dev/null 2>&1 || rc=$?
check "exit 0 on clean host" '[[ $rc -eq 0 ]]'

check "missing module fails" \
  '! ( DOCTOR_MJS=/nonexistent "$DISPATCH" 2>/dev/null )'

[[ $fails -eq 0 ]] || { echo "$fails check(s) failed"; exit 1; }
echo "all dispatcher checks passed"
