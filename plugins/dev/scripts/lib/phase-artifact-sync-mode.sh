#!/usr/bin/env bash
# phase-artifact-sync-mode.sh (CTL-1490) — resolver for the phase-artifact sync mode.
#
# Exposes: resolve_phase_artifact_sync_mode → echoes "off" | "shadow" | "enforce"
#
# Precedence:
#   1. CATALYST_PHASE_ARTIFACT_SYNC_MODE env var (validated, normalized to lowercase)
#   2. .catalyst/config.json → catalyst.phaseArtifactSync.mode
#   3. "off" (safe default — a typo must never silently start pushing)
#
# Sourceable and bash-3.2 safe. No side-effects on sourcing.

if [[ -n "${_PHASE_ARTIFACT_SYNC_MODE_LOADED:-}" ]]; then
  return 0
fi
_PHASE_ARTIFACT_SYNC_MODE_LOADED=1

resolve_phase_artifact_sync_mode() {
  local mode=""

  # 1. env override — normalize to lowercase, strip whitespace
  if [[ -n "${CATALYST_PHASE_ARTIFACT_SYNC_MODE:-}" ]]; then
    mode="$(printf '%s' "${CATALYST_PHASE_ARTIFACT_SYNC_MODE}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  fi

  # 2. Layer-1 config
  if [[ -z "$mode" ]]; then
    local cfg="${CATALYST_CONFIG_FILE:-$(pwd)/.catalyst/config.json}"
    if [[ -f "$cfg" ]]; then
      local cfg_mode
      cfg_mode="$(jq -r '.catalyst.phaseArtifactSync.mode // ""' "$cfg" 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
      mode="$cfg_mode"
    fi
  fi

  # 3. Validate + fail-safe to "off"
  case "$mode" in
    off|shadow|enforce) echo "$mode" ;;
    *) echo "off" ;;
  esac
}
