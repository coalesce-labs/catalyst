#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"; CLI="$ROOT/plugins/dev/scripts/catalyst-otel-forward"
failures=0; ok(){ echo "  PASS: $1"; }; bad(){ echo "  FAIL: $1 ($2)"; failures=$((failures+1)); }

for verb in stop start restart status; do
  before="$(pgrep -f 'otel-forward/index.ts' 2>/dev/null || true)"
  out="$($CLI "$verb" 2>&1)"; rc=$?
  after="$(pgrep -f 'otel-forward/index.ts' 2>/dev/null || true)"
  if [[ $rc -ne 0 && "$out" == *"catalyst-monitor.sh forward-$verb"* && "$before" == "$after" ]]; then ok "$verb is refused without starting a forwarder"; else bad "$verb is refused without starting a forwarder" "$out rc=$rc before=$before after=$after"; fi
done
out="$($CLI --bogus 2>&1)"; rc=$?; [[ $rc -eq 2 && "$out" == *"unknown argument"* ]] && ok "unknown flag is rejected" || bad "unknown flag is rejected" "$out rc=$rc"
for help in -h --help; do out="$($CLI "$help" 2>&1)"; rc=$?; [[ $rc -eq 0 && "$out" == *"Usage:"* ]] && ok "$help prints help" || bad "$help prints help" "$out rc=$rc"; done
if grep -Fq 'exec bun run "${SCRIPT_DIR}/otel-forward/index.ts" "$@"' "$CLI" && grep -Fq '"") ;;' "$CLI"; then ok "bare invocation falls through to unchanged exec"; else bad "bare invocation falls through to unchanged exec" "static assertion failed"; fi
exit "$failures"
