#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FAIL=0 CHECKED=0
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
for file in "$ROOT"/plugins/dev/scripts/lib/escalate-*.sh; do
  [[ "$file" == *escalate-common.sh ]] && continue
  CHECKED=$((CHECKED+1))
  grep -q 'escalation-explain\.mjs' "$file" && bad "I1 $file: calls shim directly; use escalation_explain_json"
  grep -qE '2>/dev/null[[:space:]]*\|\|[[:space:]]*echo' "$file" && bad "I2 $file: discarded stderr fallback"
  grep -qE '\[\[? -x "\$\{?emit' "$file" && bad "I3 $file: hand-rolled emitter guard"
  grep -q 'escalation_emit_terminal' "$file" || bad "I3 $file: no shared terminal emit"
  grep -q -- '--argjson' "$file" && bad "I4 $file: raw --argjson"
  grep -qE '\$\{[A-Za-z_][A-Za-z0-9_]*:-\{\}\}' "$file" && bad "I5 $file: unsafe brace fallback"
  grep -q 'escalate-common.sh' "$file" || bad "I6 $file: shared primitives not sourced"
  if command -v shellcheck >/dev/null; then shellcheck -e SC2317 "$file" || bad "I7 $file: shellcheck"; fi
done
[[ "$CHECKED" -ge 2 ]] || bad "I8: expected at least two helpers, found $CHECKED"
echo "checked=$CHECKED failed=$FAIL"
[[ "$FAIL" -eq 0 ]]
