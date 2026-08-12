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

# _invalidate_phase_doc — remove the durable phase document that this gate could
# not publish (CTL-1490 Codex P1). Only ever called on a BLOCKING failure, i.e. a
# path that does NOT emit complete: `off` + multi-host, and `enforce`. In shadow
# mode the phase legitimately completes, so the local document stays.
#
# Why it must go: reconstruct-ticket-state.mjs treats the mere PRESENCE of the
# document as proof the phase completed. Leaving it behind means a later
# same-host reconstruction — or an unrelated sync that eventually publishes the
# stale file — advances past a phase whose blocking sync failed.
_invalidate_phase_doc() {
  local doc="${CATALYST_PHASE_THOUGHTS_DOC:-}"
  [[ -n "$doc" && -f "$doc" ]] || return 0
  if rm -f "$doc" 2>/dev/null; then
    echo "${PHASE}: removed unpublished phase document ${doc} (sync failed — phase did NOT complete)" >&2
  else
    # Could not remove it: say so loudly rather than let a stale document
    # silently stand in for a completed phase.
    echo "${PHASE}: WARNING could not remove unpublished phase document ${doc} — reconstruction may treat this failed phase as complete" >&2
  fi
}

# ── off mode: byte-identical to original (roster-gated) ──────────────────────
if [[ "$SYNC_MODE" == "off" ]]; then
  # Resolve the roster from the CANONICAL source (CTL-1490 Codex P1).
  #
  # This used to read the per-repository `.catalyst/hosts.json`, which was retired:
  # execution-core/config.mjs resolves the roster from the catalyst-cluster repo's
  # cluster.json, then a static roster, then a single-host default. With the file
  # gone, every real multi-host install read ROSTER_SIZE=1 and took the
  # single-host no-op below — so `off` (the DEFAULT mode) silently skipped every
  # artifact sync and the cross-host durability this ticket adds never engaged.
  # Verified on a live 2-host install: the canonical resolver answers 2 where the
  # retired path answered 1.
  # shellcheck source=lib/cluster-roster-size.sh
  source "${SELF_DIR}/cluster-roster-size.sh"
  if ! ROSTER_SIZE="$(resolve_cluster_roster_size "$PLUGIN_ROOT")"; then
    # Unresolvable (no bun, or config.mjs unreadable). Match the JS resolver's own
    # single-host default rather than inventing a second answer — but say so, since
    # a silently-skipped sync on a multi-host node is precisely the failure above.
    echo "${PHASE}: cluster roster unresolvable (bun/config.mjs unavailable) — assuming single-host, skipping thoughts sync" >&2
    ROSTER_SIZE=1
  fi
  [[ "$ROSTER_SIZE" -le 1 ]] && exit 0   # single-host → exact no-op

  # Multi-host: sync (commit+push) MUST succeed before the caller emits complete.
  if humanlayer thoughts sync >/dev/null 2>&1; then
    exit 0
  fi

  echo "${PHASE}: thoughts sync failed (roster=${ROSTER_SIZE}) — not emitting complete" >&2
  _invalidate_phase_doc
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
_invalidate_phase_doc
EMIT="${CATALYST_EMIT_COMPLETE:-${PLUGIN_ROOT}/scripts/phase-agent-emit-complete}"
"${EMIT}" --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "thoughts_sync_failed" || true
exit 11
