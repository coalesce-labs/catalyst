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

# ⛔ HERMETICITY (CTL-1214). setup_sweep_config now writes catalyst.sweep into the
# NODE-scoped ~/.config/catalyst/node.json. Without this pin, every case below
# would write the developer's REAL node.json — which is exactly what happened
# while this suite was being written. Export it for the whole file so no
# individual case can forget, and assert the pin took effect before running.
DEFAULT_L2="${SCRATCH}/layer2-default"
mkdir -p "$DEFAULT_L2"
printf '{}\n' > "${DEFAULT_L2}/config.json"
export CATALYST_LAYER2_CONFIG_FILE="${DEFAULT_L2}/config.json"

_REAL_NODE_JSON="${HOME}/.config/catalyst/node.json"
_REAL_NODE_EXISTED=0
[[ -e "$_REAL_NODE_JSON" ]] && _REAL_NODE_EXISTED=1

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

# CTL-1214: the defaults now land in the NODE-scoped node.json, never back in
# the committed Layer-1 config.
S1_NODE="${DEFAULT_L2}/node.json"
run "S1a: idleHours default set (node.json)" \
  bash -c "jq -e '.catalyst.sweep.idleHours == 48' '${S1_NODE}'"
run "S1b: intervalHours default set (node.json)" \
  bash -c "jq -e '.catalyst.sweep.intervalHours == 1' '${S1_NODE}'"
run "S1c: salvagePush default is false (node.json)" \
  bash -c "jq -e '.catalyst.sweep.salvagePush == false' '${S1_NODE}'"
run "S1d: maxRemovalsPerRun default is a number (node.json)" \
  bash -c "jq -e 'type == \"number\"' <(jq '.catalyst.sweep.maxRemovalsPerRun' '${S1_NODE}')"
run "S1e: the committed Layer-1 config gains NO sweep block" \
  bash -c "jq -e '.catalyst.sweep == null' '${S1_DIR}/.catalyst/config.json'"

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
run "S2c: sweep section still written (to node.json)" \
  bash -c "jq -e '.catalyst.sweep.idleHours == 48' '${DEFAULT_L2}/node.json'"

# ─── S3: preserves a pre-existing user override (idleHours=72 stays 72) ──────
# CTL-1214: the override now lives where the value is written — node.json. The
# Layer-1 copy is a legacy config and is asserted untouched by S5h below.
S3_DIR="${SCRATCH}/s3-proj"
S3_L2="${SCRATCH}/s3-layer2"
mkdir -p "${S3_DIR}/.catalyst" "$S3_L2"
printf '{"catalyst":{"projectKey":"X"}}\n' > "${S3_DIR}/.catalyst/config.json"
printf '{}\n' > "${S3_L2}/config.json"
printf '{"catalyst":{"sweep":{"idleHours":72,"maxRemovalsPerRun":5}}}\n' > "${S3_L2}/node.json"

PROJECT_DIR="$S3_DIR"
CATALYST_LAYER2_CONFIG_FILE="${S3_L2}/config.json" setup_sweep_config >/dev/null 2>&1 || true

run "S3a: pre-existing idleHours=72 survives re-run" \
  bash -c "jq -e '.catalyst.sweep.idleHours == 72' '${S3_L2}/node.json'"
run "S3b: pre-existing maxRemovalsPerRun=5 survives re-run" \
  bash -c "jq -e '.catalyst.sweep.maxRemovalsPerRun == 5' '${S3_L2}/node.json'"
run "S3c: un-overridden keys still get defaults (intervalHours=1)" \
  bash -c "jq -e '.catalyst.sweep.intervalHours == 1' '${S3_L2}/node.json'"

# ─── S4: missing .catalyst/config.json -> safe no-op ─────────────────────────
S4_DIR="${SCRATCH}/s4-proj"
mkdir -p "${S4_DIR}/.catalyst"  # dir exists but NO config.json

PROJECT_DIR="$S4_DIR"
run "S4: missing config.json -> exits 0 (no crash)" \
  bash -c "PROJECT_DIR='${S4_DIR}' CATALYST_SETUP_LIB_ONLY=1 source '${SETUP_SH}' && setup_sweep_config"
run "S4b: no malformed/empty config.json created" \
  bash -c "[[ ! -f '${S4_DIR}/.catalyst/config.json' ]] || jq -e '.' '${S4_DIR}/.catalyst/config.json'"

# ─── S5 (CTL-1214): the committed Layer-1 config is NEVER re-leaked ──────────
# setup_sweep_config patched catalyst.sweep back into .catalyst/config.json on
# EVERY run, so the Phase-4 slimming would survive exactly until the next setup.
# It now writes node.json instead, and leaves the committed file untouched.
S5_DIR="${SCRATCH}/s5-proj"
S5_L2="${SCRATCH}/s5-layer2"
mkdir -p "${S5_DIR}/.catalyst" "$S5_L2"
printf '{\n  "catalyst": {\n    "schemaVersion": 1,\n    "projectKey": "SLIM"\n  }\n}\n' \
  > "${S5_DIR}/.catalyst/config.json"
printf '{}\n' > "${S5_L2}/config.json"
cp "${S5_DIR}/.catalyst/config.json" "${SCRATCH}/s5-before.json"

PROJECT_DIR="$S5_DIR"
CATALYST_LAYER2_CONFIG_FILE="${S5_L2}/config.json" setup_sweep_config >/dev/null 2>&1 || true

run "S5a: slimmed .catalyst/config.json is byte-for-byte UNCHANGED" \
  cmp -s "${SCRATCH}/s5-before.json" "${S5_DIR}/.catalyst/config.json"
run "S5b: no catalyst.sweep re-added to Layer-1" \
  bash -c "jq -e '.catalyst.sweep == null' '${S5_DIR}/.catalyst/config.json'"
run "S5c: node.json gains the sweep defaults instead" \
  bash -c "jq -e '.catalyst.sweep.intervalHours == 1' '${S5_L2}/node.json'"
run "S5d: node.json is 0600" \
  bash -c "[[ \"\$(stat -f '%Lp' '${S5_L2}/node.json' 2>/dev/null || stat -c '%a' '${S5_L2}/node.json')\" == '600' ]]"

# S5e: non-clobbering — an operator value already in node.json survives.
S5B_DIR="${SCRATCH}/s5b-proj"
S5B_L2="${SCRATCH}/s5b-layer2"
mkdir -p "${S5B_DIR}/.catalyst" "$S5B_L2"
printf '{"catalyst":{"schemaVersion":1,"projectKey":"SLIM"}}\n' > "${S5B_DIR}/.catalyst/config.json"
printf '{}\n' > "${S5B_L2}/config.json"
printf '{"catalyst":{"sweep":{"idleHours":72},"host":{"name":"mini-2"}}}\n' > "${S5B_L2}/node.json"

PROJECT_DIR="$S5B_DIR"
CATALYST_LAYER2_CONFIG_FILE="${S5B_L2}/config.json" setup_sweep_config >/dev/null 2>&1 || true

run "S5e: an existing node.json sweep override is preserved (idleHours stays 72)" \
  bash -c "jq -e '.catalyst.sweep.idleHours == 72' '${S5B_L2}/node.json'"
run "S5f: unrelated node.json keys survive (deep merge, not replace)" \
  bash -c "jq -e '.catalyst.host.name == \"mini-2\"' '${S5B_L2}/node.json'"
run "S5g: un-overridden defaults are still filled in" \
  bash -c "jq -e '.catalyst.sweep.intervalHours == 1' '${S5B_L2}/node.json'"

# S5h: a LEGACY repo that still carries catalyst.sweep in Layer-1 is left alone —
# no destructive rewrite of a config the operator has not migrated yet.
S5C_DIR="${SCRATCH}/s5c-proj"
S5C_L2="${SCRATCH}/s5c-layer2"
mkdir -p "${S5C_DIR}/.catalyst" "$S5C_L2"
printf '{"catalyst":{"projectKey":"LEGACY","sweep":{"idleHours":72}}}\n' > "${S5C_DIR}/.catalyst/config.json"
printf '{}\n' > "${S5C_L2}/config.json"

PROJECT_DIR="$S5C_DIR"
CATALYST_LAYER2_CONFIG_FILE="${S5C_L2}/config.json" setup_sweep_config >/dev/null 2>&1 || true

run "S5h: a legacy Layer-1 catalyst.sweep is NOT deleted" \
  bash -c "jq -e '.catalyst.sweep.idleHours == 72' '${S5C_DIR}/.catalyst/config.json'"

# ─── S7 (CTL-1214 remediation): setup_dispatch_mode_config seeds node.json ────
#
# Phase 4 removed `orchestration.dispatchMode` from the config template and left
# NO writer behind, so a project scaffolded on a fresh host silently resolved to
# the `oneshot-legacy` code default. The key is node-scoped and the template
# declares schemaVersion 1, so it cannot go back in the template without turning
# checkConfigScopeLeak's FAIL — and catalyst-join.sh's gate — against every new
# project. These cases pin the seeder that replaces it.
S7_L2="${SCRATCH}/s7-layer2"
mkdir -p "$S7_L2"
printf '{}\n' > "${S7_L2}/config.json"
CATALYST_LAYER2_CONFIG_FILE="${S7_L2}/config.json" setup_dispatch_mode_config >/dev/null 2>&1 || true

run "S7a: dispatchMode default is seeded into node.json" \
  bash -c "jq -e '.catalyst.orchestration.dispatchMode == \"phase-agents\"' '${S7_L2}/node.json'"

# Positive control for S7a: the default is NOT what a bare `{}` node.json would
# already answer, so the assertion above is evidence the seeder ran.
S7CTRL="${SCRATCH}/s7-control.json"
printf '{}\n' > "$S7CTRL"
run "S7b: control — an unseeded node.json has no dispatchMode" \
  bash -c "jq -e '.catalyst.orchestration.dispatchMode == null' '${S7CTRL}'"

# Idempotent + non-clobbering: a host pinned to execution-core keeps its pin.
S7B_L2="${SCRATCH}/s7b-layer2"
mkdir -p "$S7B_L2"
printf '{}\n' > "${S7B_L2}/config.json"
printf '{"catalyst":{"orchestration":{"dispatchMode":"execution-core","executor":"sdk"},"host":{"name":"mini-2"}}}\n' \
  > "${S7B_L2}/node.json"
CATALYST_LAYER2_CONFIG_FILE="${S7B_L2}/config.json" setup_dispatch_mode_config >/dev/null 2>&1 || true

run "S7c: an operator's existing dispatchMode is NOT overwritten" \
  bash -c "jq -e '.catalyst.orchestration.dispatchMode == \"execution-core\"' '${S7B_L2}/node.json'"
run "S7d: sibling orchestration keys survive (merge, not replace)" \
  bash -c "jq -e '.catalyst.orchestration.executor == \"sdk\"' '${S7B_L2}/node.json'"
run "S7e: unrelated node.json keys survive" \
  bash -c "jq -e '.catalyst.host.name == \"mini-2\"' '${S7B_L2}/node.json'"

# Re-running is a no-op on an already-seeded file (setup re-runs are routine).
_S7_BEFORE="$(cat "${S7_L2}/node.json")"
CATALYST_LAYER2_CONFIG_FILE="${S7_L2}/config.json" setup_dispatch_mode_config >/dev/null 2>&1 || true
if [[ "$_S7_BEFORE" == "$(cat "${S7_L2}/node.json")" ]]; then
  PASSES=$((PASSES+1)); echo "  PASS: S7f: a second run leaves node.json byte-identical"
else
  FAILURES=$((FAILURES+1)); echo "  FAIL: S7f: a second run rewrote node.json"
fi

# The seeder must NEVER write the committed Layer-1 config (that is the whole
# point of the relocation, and a schemaVersion-1 config carrying it FAILs doctor).
S7C_DIR="${SCRATCH}/s7c-proj"
mkdir -p "${S7C_DIR}/.catalyst"
printf '{"catalyst":{"schemaVersion":1,"projectKey":"TEST"}}\n' > "${S7C_DIR}/.catalyst/config.json"
PROJECT_DIR="$S7C_DIR"
CATALYST_LAYER2_CONFIG_FILE="${S7_L2}/config.json" setup_dispatch_mode_config >/dev/null 2>&1 || true
run "S7g: the committed Layer-1 config gains NO orchestration stanza" \
  bash -c "jq -e '.catalyst.orchestration == null' '${S7C_DIR}/.catalyst/config.json'"

# ─── S6 (CTL-1214): the suite never touched the REAL host config ─────────────
# A guard on the guard. Without it this file silently created the developer's
# ~/.config/catalyst/node.json while it was being written.
if [[ "$_REAL_NODE_EXISTED" -eq 0 && -e "$_REAL_NODE_JSON" ]]; then
  FAILURES=$((FAILURES+1))
  echo "  FAIL: S6: the suite created the REAL ${_REAL_NODE_JSON}"
else
  PASSES=$((PASSES+1))
  echo "  PASS: S6: the real ~/.config/catalyst/node.json was not touched"
fi

# ─── results ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1
