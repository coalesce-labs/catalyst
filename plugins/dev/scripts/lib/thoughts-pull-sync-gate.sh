#!/usr/bin/env bash
# thoughts-pull-sync-gate.sh (CTL-1236, CTL-1490) — mode-aware, ff-only,
# NON-FATAL pull-before-read gate for phase-research, phase-plan, and
# research-codebase.
#
# Contract (read side ALWAYS non-fatal — diverges from write-side gate):
#   mode=off + roster <= 1 → exit 0, pull NOT invoked  (today's no-op)
#   mode=off + roster >  1 → pull invoked; failure → warn + exit 0
#   mode=shadow/enforce    → pull invoked regardless of roster; failure → warn + exit 0
#
# Pull failures stay non-fatal (exit 0) in ALL modes — the read side never
# blocks the pipeline (research F2/F6).
#
# Usage:
#   "${PLUGIN_ROOT}/scripts/lib/thoughts-pull-sync-gate.sh" || true
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve sync mode (env → config → "off").
# shellcheck source=lib/phase-artifact-sync-mode.sh
source "${SELF_DIR}/phase-artifact-sync-mode.sh"
SYNC_MODE="$(resolve_phase_artifact_sync_mode)"

# Resolve pull command — injectable by tests.
if [[ -n "${CATALYST_PULL_SYNC_CMD:-}" ]]; then
  PULL_CMD="$CATALYST_PULL_SYNC_CMD"
elif [[ -x "${HOME}/.catalyst/bin/thoughts-pull-sync" ]]; then
  PULL_CMD="${HOME}/.catalyst/bin/thoughts-pull-sync"
else
  PULL_CMD="${SELF_DIR}/../thoughts-pull-sync.sh"
fi

# ── off mode: original roster-gated behavior ──────────────────────────────────
if [[ "$SYNC_MODE" == "off" ]]; then
  # Resolve the roster from the CANONICAL source (CTL-1490 Codex P1). The retired
  # per-repository `.catalyst/hosts.json` read here answered 1 on every real
  # multi-host install, so this gate never pulled and the read side never saw a
  # peer's freshly-pushed artifacts. Same defect, same fix, as the write-side gate.
  PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "${SELF_DIR}/../.." && pwd)}"
  # shellcheck source=lib/cluster-roster-size.sh
  source "${SELF_DIR}/cluster-roster-size.sh"
  if ! ROSTER_SIZE="$(resolve_cluster_roster_size "$PLUGIN_ROOT")"; then
    echo "thoughts-pull-sync-gate: cluster roster unresolvable — assuming single-host, skipping pull" >&2
    ROSTER_SIZE=1
  fi
  [[ "$ROSTER_SIZE" -le 1 ]] && exit 0   # single-host → exact no-op

  # Multi-host: run pull (non-fatal).
  if ! "$PULL_CMD" >/dev/null 2>&1; then
    echo "thoughts-pull-sync-gate: pull failed (roster=${ROSTER_SIZE}) — continuing anyway (non-fatal)" >&2
  fi
  exit 0
fi

# ── shadow / enforce mode: always pull, roster guard bypassed ────────────────
if ! "$PULL_CMD" >/dev/null 2>&1; then
  echo "thoughts-pull-sync-gate: pull failed (mode=${SYNC_MODE}) — continuing anyway (read side non-fatal)" >&2
fi
exit 0
