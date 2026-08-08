#!/usr/bin/env bash
# thoughts-sync-gate.sh (CTL-866, CTL-1490) — mode-aware thoughts-sync gate
# for the write side of phase skills. Single source of truth, called from phase
# skills immediately before phase-agent-emit-complete.
#
#   "${PLUGIN_ROOT}/scripts/lib/thoughts-sync-gate.sh" --phase "$PHASE" --ticket "$TICKET" || exit 11
#
# Modes (resolved by lib/phase-artifact-sync-mode.sh, precedence: env → config → "off"):
#   off      roster <= 1 → exit 0 (no sync); roster > 1 → sync (byte-identical to original)
#   shadow   always sync regardless of roster; failure → exit 0 + event appended to events log
#   enforce  always sync regardless of roster; failure → emit failed + exit 11
set -uo pipefail

PHASE="" TICKET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)  PHASE="$2"; shift 2 ;;
    --ticket) TICKET="$2"; shift 2 ;;
    *) shift ;;
  esac
done

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SELF_DIR}/../.." && pwd)}"

# Resolve sync mode (env → config → "off").
# shellcheck source=lib/phase-artifact-sync-mode.sh
source "${SELF_DIR}/phase-artifact-sync-mode.sh"
SYNC_MODE="$(resolve_phase_artifact_sync_mode)"

# ── off mode: byte-identical to original (roster-gated) ──────────────────────
if [[ "$SYNC_MODE" == "off" ]]; then
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
  EMIT="${CATALYST_EMIT_COMPLETE:-${PLUGIN_ROOT}/scripts/phase-agent-emit-complete}"
  "${EMIT}" --phase "$PHASE" --ticket "$TICKET" --status failed \
    --reason "thoughts_sync_failed" || true
  exit 11
fi

# ── shadow / enforce mode: always sync, roster guard bypassed ─────────────────
if humanlayer thoughts sync >/dev/null 2>&1; then
  exit 0
fi

# Sync failed.
echo "${PHASE}: thoughts sync failed (mode=${SYNC_MODE}) — not blocking on shadow, blocking on enforce" >&2

if [[ "$SYNC_MODE" == "shadow" ]]; then
  # Never blocks — append an event and continue.
  CANONICAL="${SELF_DIR}/canonical-event.sh"
  if [[ -r "$CANONICAL" ]]; then
    # shellcheck source=lib/canonical-event.sh
    source "$CANONICAL"
    EVENT_NAME="thoughts.sync.failed.${PHASE}.${TICKET}"
    TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    LINE="$(build_canonical_line \
      --ts "$TS" --severity WARN --service "catalyst.phase-agent" \
      --event-name "$EVENT_NAME" 2>/dev/null || true)"
    if [[ -n "$LINE" ]]; then
      EVENTS_BASE="${CATALYST_DIR:-${HOME}/catalyst}/events"
      canonical_jsonl_append "$EVENTS_BASE" "$LINE" 2>/dev/null || true
    fi
  fi
  exit 0
fi

# enforce mode: treat sync failure as fatal.
EMIT="${CATALYST_EMIT_COMPLETE:-${PLUGIN_ROOT}/scripts/phase-agent-emit-complete}"
"${EMIT}" --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "thoughts_sync_failed" || true
exit 11
