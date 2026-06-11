#!/usr/bin/env bash
# Tests for setup_sweep_config() in setup-catalyst.sh (CTL-1030 Phase 6).
#
# Run: bash plugins/dev/scripts/__tests__/setup-sweep-config.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP_SH="${REPO_ROOT}/setup-catalyst.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

run() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
  fi
}

# Source the library functions without running main.
# shellcheck source=/dev/null
CATALYST_SETUP_LIB_ONLY=1 source "$SETUP_SH"

# ─── S1: setup_sweep_config adds catalyst.sweep defaults ─────────────────────
S1_DIR="${SCRATCH}/s1-proj"
mkdir -p "${S1_DIR}/.catalyst"
printf '{"catalyst":{"projectKey":"TEST"}}\n' > "${S1_DIR}/.catalyst/config.json"

PROJECT_DIR="$S1_DIR"
setup_sweep_config >/dev/null 2>&1 || true

run "S1a: idleHours default set" \
  bash -c "jq -e '.catalyst.sweep.idleHours == 48' '${S1_DIR}/.catalyst/config.json'"
run "S1b: intervalHours default set" \
  bash -c "jq -e '.catalyst.sweep.intervalHours == 1' '${S1_DIR}/.catalyst/config.json'"
run "S1c: salvagePush default is false" \
  bash -c "jq -e '.catalyst.sweep.salvagePush == false' '${S1_DIR}/.catalyst/config.json'"
run "S1d: maxRemovalsPerRun default is a number" \
  bash -c "jq -e 'type == \"number\"' <(jq '.catalyst.sweep.maxRemovalsPerRun' '${S1_DIR}/.catalyst/config.json')"

# ─── S2: does NOT clobber existing projectKey / dispatchMode ──────────────────
S2_DIR="${SCRATCH}/s2-proj"
mkdir -p "${S2_DIR}/.catalyst"
printf '{"catalyst":{"projectKey":"MYPROJ","orchestration":{"dispatchMode":"phase-agents"}}}\n' \
  > "${S2_DIR}/.catalyst/config.json"

PROJECT_DIR="$S2_DIR"
setup_sweep_config >/dev/null 2>&1 || true

run "S2a: projectKey preserved" \
  bash -c "jq -e '.catalyst.projectKey == \"MYPROJ\"' '${S2_DIR}/.catalyst/config.json'"
run "S2b: orchestration.dispatchMode preserved" \
  bash -c "jq -e '.catalyst.orchestration.dispatchMode == \"phase-agents\"' '${S2_DIR}/.catalyst/config.json'"
run "S2c: sweep section still written" \
  bash -c "jq -e '.catalyst.sweep.idleHours == 48' '${S2_DIR}/.catalyst/config.json'"

# ─── S3: preserves a pre-existing user override (idleHours=72 stays 72) ──────
S3_DIR="${SCRATCH}/s3-proj"
mkdir -p "${S3_DIR}/.catalyst"
printf '{"catalyst":{"projectKey":"X","sweep":{"idleHours":72,"maxRemovalsPerRun":5}}}\n' \
  > "${S3_DIR}/.catalyst/config.json"

PROJECT_DIR="$S3_DIR"
setup_sweep_config >/dev/null 2>&1 || true

run "S3a: pre-existing idleHours=72 survives re-run" \
  bash -c "jq -e '.catalyst.sweep.idleHours == 72' '${S3_DIR}/.catalyst/config.json'"
run "S3b: pre-existing maxRemovalsPerRun=5 survives re-run" \
  bash -c "jq -e '.catalyst.sweep.maxRemovalsPerRun == 5' '${S3_DIR}/.catalyst/config.json'"
run "S3c: un-overridden keys still get defaults (intervalHours=1)" \
  bash -c "jq -e '.catalyst.sweep.intervalHours == 1' '${S3_DIR}/.catalyst/config.json'"

# ─── S4: missing .catalyst/config.json -> safe no-op ─────────────────────────
S4_DIR="${SCRATCH}/s4-proj"
mkdir -p "${S4_DIR}/.catalyst"  # dir exists but NO config.json

PROJECT_DIR="$S4_DIR"
run "S4: missing config.json -> exits 0 (no crash)" \
  bash -c "PROJECT_DIR='${S4_DIR}' CATALYST_SETUP_LIB_ONLY=1 source '${SETUP_SH}' && setup_sweep_config"
run "S4b: no malformed/empty config.json created" \
  bash -c "[[ ! -f '${S4_DIR}/.catalyst/config.json' ]] || jq -e '.' '${S4_DIR}/.catalyst/config.json'"

# ─── results ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
