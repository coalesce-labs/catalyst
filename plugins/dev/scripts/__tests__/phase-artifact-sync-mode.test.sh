#!/usr/bin/env bash
# CTL-1490: tests for plugins/dev/scripts/lib/phase-artifact-sync-mode.sh
# Run: bash plugins/dev/scripts/__tests__/phase-artifact-sync-mode.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RESOLVER="${REPO_ROOT}/plugins/dev/scripts/lib/phase-artifact-sync-mode.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

if [[ ! -f "$RESOLVER" ]]; then
  echo "FATAL: resolver not found — expected at $RESOLVER" >&2
  exit 1
fi

# Source the resolver in a subshell helper so we can control env vars cleanly.
# resolve() calls resolve_phase_artifact_sync_mode after sourcing the lib.
resolve() {
  bash -c "source '${RESOLVER}'; resolve_phase_artifact_sync_mode" "$@"
}
resolve_with_config() {
  local config_file="$1"
  shift
  bash -c "source '${RESOLVER}'; resolve_phase_artifact_sync_mode" \
    env CATALYST_CONFIG_FILE="$config_file" "$@"
}

# --------------------------------------------------------------------------
# T1: CATALYST_PHASE_ARTIFACT_SYNC_MODE=enforce → "enforce" (env wins)
# --------------------------------------------------------------------------
echo "T1: env=enforce → 'enforce'"
out=$(CATALYST_PHASE_ARTIFACT_SYNC_MODE=enforce bash -c "source '${RESOLVER}'; resolve_phase_artifact_sync_mode")
assert_eq "enforce" "$out" "T1: env=enforce"

# --------------------------------------------------------------------------
# T2: env unset, config mode=shadow → "shadow"
# --------------------------------------------------------------------------
echo "T2: env unset, config mode=shadow → 'shadow'"
CFG_T2="${SCRATCH}/cfg-t2.json"
printf '{"catalyst":{"phaseArtifactSync":{"mode":"shadow"}}}\n' > "$CFG_T2"
out=$(CATALYST_CONFIG_FILE="$CFG_T2" bash -c "unset CATALYST_PHASE_ARTIFACT_SYNC_MODE; source '${RESOLVER}'; resolve_phase_artifact_sync_mode")
assert_eq "shadow" "$out" "T2: config mode=shadow"

# --------------------------------------------------------------------------
# T3: env unset, no config → "off" (default)
# --------------------------------------------------------------------------
echo "T3: no env, no config → 'off'"
out=$(CATALYST_CONFIG_FILE="/nonexistent/config.json" bash -c "unset CATALYST_PHASE_ARTIFACT_SYNC_MODE; source '${RESOLVER}'; resolve_phase_artifact_sync_mode")
assert_eq "off" "$out" "T3: default → off"

# --------------------------------------------------------------------------
# T4: env=bogus (typo) → "off" (invalid → fail-safe off)
# --------------------------------------------------------------------------
echo "T4: env=bogus → 'off' (fail-safe)"
out=$(CATALYST_PHASE_ARTIFACT_SYNC_MODE=bogus bash -c "source '${RESOLVER}'; resolve_phase_artifact_sync_mode")
assert_eq "off" "$out" "T4: invalid env value → off"

# --------------------------------------------------------------------------
# T5: config mode=bogus, env unset → "off" (invalid config → off)
# --------------------------------------------------------------------------
echo "T5: config mode=bogus → 'off'"
CFG_T5="${SCRATCH}/cfg-t5.json"
printf '{"catalyst":{"phaseArtifactSync":{"mode":"bogus"}}}\n' > "$CFG_T5"
out=$(CATALYST_CONFIG_FILE="$CFG_T5" bash -c "unset CATALYST_PHASE_ARTIFACT_SYNC_MODE; source '${RESOLVER}'; resolve_phase_artifact_sync_mode")
assert_eq "off" "$out" "T5: invalid config mode → off"

# --------------------------------------------------------------------------
# T6a: env=OFF (uppercase) → "off" (normalized to lowercase)
# --------------------------------------------------------------------------
echo "T6a: env=OFF (uppercase) → 'off' (normalized)"
out=$(CATALYST_PHASE_ARTIFACT_SYNC_MODE=OFF bash -c "source '${RESOLVER}'; resolve_phase_artifact_sync_mode")
assert_eq "off" "$out" "T6a: uppercase OFF → normalized off"

# --------------------------------------------------------------------------
# T6b: env=' enforce ' (whitespace) → "enforce" (trimmed)
# --------------------------------------------------------------------------
echo "T6b: env with whitespace → normalized"
out=$(CATALYST_PHASE_ARTIFACT_SYNC_MODE=" enforce " bash -c "source '${RESOLVER}'; resolve_phase_artifact_sync_mode")
assert_eq "enforce" "$out" "T6b: whitespace-padded enforce → normalized enforce"

# --------------------------------------------------------------------------
# T7: env wins over config (env=enforce, config=shadow → "enforce")
# --------------------------------------------------------------------------
echo "T7: env wins over config"
CFG_T7="${SCRATCH}/cfg-t7.json"
printf '{"catalyst":{"phaseArtifactSync":{"mode":"shadow"}}}\n' > "$CFG_T7"
out=$(CATALYST_PHASE_ARTIFACT_SYNC_MODE=enforce CATALYST_CONFIG_FILE="$CFG_T7" bash -c "source '${RESOLVER}'; resolve_phase_artifact_sync_mode")
assert_eq "enforce" "$out" "T7: env wins over config"

# --------------------------------------------------------------------------
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
