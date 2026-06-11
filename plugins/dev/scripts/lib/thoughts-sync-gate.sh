#!/usr/bin/env bash
# thoughts-sync-gate.sh (CTL-866) — multi-host thoughts-sync gate for the
# write side of research/plan phases. Single source of truth, called from
# phase-research and phase-plan immediately before phase-agent-emit-complete.
#
#   "${PLUGIN_ROOT}/scripts/lib/thoughts-sync-gate.sh" --phase "$PHASE" --ticket "$TICKET" || exit 11
#
# Contract:
#   roster <= 1 (single-host / absent / malformed hosts.json) → exit 0  (exact no-op, no sync)
#   roster  > 1 + `humanlayer thoughts sync` exit 0           → exit 0  (artifact pushed; proceed)
#   roster  > 1 + sync failure                                → emit `failed`
#                                                               (reason thoughts_sync_failed), exit 11
set -uo pipefail
PHASE="" TICKET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)  PHASE="$2"; shift 2 ;;
    --ticket) TICKET="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Resolve roster (mirror getClusterHosts: absent/malformed → single-host default).
CFG_DIR="$(dirname "${CATALYST_CONFIG_FILE:-$(pwd)/.catalyst/config.json}")"
HOSTS_FILE="${CFG_DIR}/hosts.json"
ROSTER_SIZE=1
if [[ -f "$HOSTS_FILE" ]]; then
  n="$(jq -r '[.[] | select(type=="string" and length>0)] | length' "$HOSTS_FILE" 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]] && ROSTER_SIZE="$n"
fi
[[ "$ROSTER_SIZE" -le 1 ]] && exit 0   # single-host → exact no-op

# Multi-host: sync (commit+push) MUST succeed before the caller emits complete.
if humanlayer thoughts sync >/dev/null 2>&1; then
  exit 0
fi

echo "${PHASE}: thoughts sync failed (roster=${ROSTER_SIZE}) — not emitting complete" >&2
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SELF_DIR}/../.." && pwd)}"
EMIT="${CATALYST_EMIT_COMPLETE:-${PLUGIN_ROOT}/scripts/phase-agent-emit-complete}"
"${EMIT}" --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "thoughts_sync_failed" || true
exit 11
