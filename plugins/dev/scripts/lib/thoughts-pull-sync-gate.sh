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
  # Resolve roster — mirrors getClusterHosts: absent/malformed → single-host default.
  CFG_DIR="$(dirname "${CATALYST_CONFIG_FILE:-$(pwd)/.catalyst/config.json}")"
  HOSTS_FILE="${CFG_DIR}/hosts.json"
  ROSTER_SIZE=1
  if [[ -f "$HOSTS_FILE" ]]; then
    n="$(jq -r '[.[] | select(type=="string" and length>0)] | length' "$HOSTS_FILE" 2>/dev/null || echo 0)"
    [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]] && ROSTER_SIZE="$n"
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
