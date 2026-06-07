#!/usr/bin/env bash
# Guard test: every canonical event emitter must reference host-identity primitives.
# Fails until all emitters in the canonical set are patched with host.name/host.id.
#
# The canonical emitter set (non-legacy, has a resource block with service.namespace:"catalyst"):
#   1. lib/canonical-event.sh           — bash base resource builder
#   2. orch-monitor/lib/canonical-event.ts — TS buildCanonicalEvent
#   3. execution-core/recovery.mjs      — MJS buildEventEnvelope
#   4. broker/router.mjs                — MJS buildCanonicalEnvelope
#   5. catalyst-agent/emit.mjs          — MJS buildAgentEnvelope
# Plus the per-event builders in execution-core that inline their own resource:
#   6. execution-core/ratelimit-event.mjs
#   7. execution-core/memory-event.mjs
#   8. execution-core/wait-event.mjs
#   9. execution-core/linear-state-write-event.mjs
#  10. execution-core/triage-transition-event.mjs
#
# Run: bash plugins/dev/scripts/__tests__/host-coverage.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DEV="${REPO_ROOT}/plugins/dev/scripts"

FAILURES=0
PASSES=0

ok() {
  local name="$1"
  PASSES=$((PASSES+1))
  echo "  PASS: $name"
}

fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $name"
  echo "    $detail"
}

check_host_refs() {
  local label="$1" file="$2"
  if [[ ! -f "$file" ]]; then
    fail "$label" "file not found: $file"
    return
  fi
  # Each file must reference at least one of the host-identity primitives:
  #   bash: catalyst_host_name / catalyst_host_id / host-identity.sh
  #   TS/MJS: hostName / hostId / host-identity.mjs
  if grep -qE 'catalyst_host_name|catalyst_host_id|host-identity\.sh|hostName|hostId|host-identity\.mjs' "$file"; then
    ok "$label references host-identity primitive"
  else
    fail "$label" "no host-identity primitive found in $file"
  fi
}

# 1. Bash canonical-event.sh
check_host_refs "lib/canonical-event.sh" "${DEV}/lib/canonical-event.sh"

# 2. TS canonical-event.ts
check_host_refs "orch-monitor/lib/canonical-event.ts" "${DEV}/orch-monitor/lib/canonical-event.ts"

# 3. MJS execution-core/recovery.mjs
check_host_refs "execution-core/recovery.mjs" "${DEV}/execution-core/recovery.mjs"

# 4. MJS broker/router.mjs
check_host_refs "broker/router.mjs" "${DEV}/broker/router.mjs"

# 5. MJS catalyst-agent/emit.mjs
check_host_refs "catalyst-agent/emit.mjs" "${DEV}/catalyst-agent/emit.mjs"

# 6–10. execution-core per-event builders
check_host_refs "execution-core/ratelimit-event.mjs" "${DEV}/execution-core/ratelimit-event.mjs"
check_host_refs "execution-core/memory-event.mjs" "${DEV}/execution-core/memory-event.mjs"
check_host_refs "execution-core/wait-event.mjs" "${DEV}/execution-core/wait-event.mjs"
check_host_refs "execution-core/linear-state-write-event.mjs" "${DEV}/execution-core/linear-state-write-event.mjs"
check_host_refs "execution-core/triage-transition-event.mjs" "${DEV}/execution-core/triage-transition-event.mjs"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
