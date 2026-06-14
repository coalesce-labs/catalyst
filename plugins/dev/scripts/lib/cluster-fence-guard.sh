#!/usr/bin/env bash
# cluster-fence-guard.sh (CTL-864) — cross-host worker fencing guard.
#
# Single source of truth for the side-effect fence used by phase-pr,
# phase-implement, phase-monitor-merge, phase-monitor-deploy, and phase-triage.
# Call BEFORE any irreversible side-effect (git push, gh pr create|merge,
# Linear mirror comment + transition):
#
#   "${PLUGIN_ROOT}/scripts/lib/cluster-fence-guard.sh" --phase "$PHASE" --ticket "$TICKET" || exit 10
#
# (All 5 call-sites use `|| exit 10`, matching the guard's only non-zero exit
# code; CTL-864 remediation aligned this example to that convention.)
#
# Contract:
#   CATALYST_CLUSTER_GENERATION unset/empty → exit 0  (single-host no-op)
#   generation current  (fence-check exit 0)  → exit 0  (proceed)
#   generation stale    (fence-check exit 10) → emit `failed` (reason
#                                               cluster_fence_stale), exit 10
set -uo pipefail
PHASE="" TICKET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)  PHASE="$2"; shift 2 ;;
    --ticket) TICKET="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Single-host / no token → exact no-op.
[[ -n "${CATALYST_CLUSTER_GENERATION:-}" ]] || exit 0

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SELF_DIR}/../.." && pwd)}"
CLUSTER_CLAIM_CLI="${PLUGIN_ROOT}/scripts/execution-core/cluster-claim.mjs"
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"

if node "$CLUSTER_CLAIM_CLI" fence-check "$TICKET" "$CATALYST_CLUSTER_GENERATION" >/dev/null 2>&1; then
  exit 0   # generation current → proceed
fi

# Stale (exit 10 or any non-current result) — bow out without the side-effect.
echo "${PHASE}: cluster fence stale (gen=${CATALYST_CLUSTER_GENERATION}) — bowing out, no side-effect" >&2
"${EMIT}" \
  --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "cluster_fence_stale" || true
exit 10
