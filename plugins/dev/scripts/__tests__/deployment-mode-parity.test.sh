#!/usr/bin/env bash
# Cross-stack parity test for lib/deployment-mode.mjs vs
# lib/catalyst-deployment-mode.sh (CTL-1617).
#
# Built directly on the proven, CI-exercised cross-stack mechanism in
# __tests__/host-identity.test.sh (shell out to node, run identical inputs
# through both implementations, diff the outputs). Where host-identity.test.sh
# checks one scenario, this runs a FULL fixture matrix over three axes:
#
#   ENV  (7): unset / valid / garbage / quoted / unmatched-quote / apostrophe / crlf
#   L2   (6): absent / valid / garbage / null / bool-false / number
#   L1   (4): absent / valid / garbage / bool-true
#
#   7 x 6 x 4 = 168 cells
#
# Each axis value is a SETTLE/FALLTHROUGH fixture (see the *_SETTLE/*_MODE/
# *_RECOGNIZED arrays below) — the expected {mode, source, recognized,
# inferred} for every cell is COMPUTED from the same env > layer2 > layer1 >
# default cascade the design specifies (§4), not copied from either
# implementation's output. The assertion is therefore threeway:
# bash == expected AND node == expected — asserting bash == node alone (the
# pre-fix version of this file) is a false-green on the exact property this
# test exists to guard, since two implementations can agree with each other
# while both disagreeing with the spec.
#
# The non-string L2/L1 fixtures ({"mode": false}, {"mode": 123},
# {"mode": true}) exercise BLOCKING 1 (a bare jq `// empty` swallows JSON
# `false`, silently falling through instead of settling degraded). The
# quoted / unmatched-quote / apostrophe / crlf ENV fixtures exercise
# BLOCKING 2 (xargs-as-trimmer performs quote/backslash reprocessing, errors
# on an unmatched quote, and does not strip \r).
#
# Every cell runs in a hermetic `env -i` subshell for BOTH implementations —
# only PATH/HOME plus the exact fixture inputs under test are passed through,
# as ARRAY elements (never string-interpolated into an unquoted expansion),
# so a hostile fixture value (embedded quotes, an unmatched quote, a raw CR)
# is passed to `env`/`node` as literal DATA and can never be re-split or
# re-parsed by the invoking shell — the "seal the transport, don't just stub
# the helper" lesson.
#
# Run: bash plugins/dev/scripts/__tests__/deployment-mode-parity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-deployment-mode.sh"
JS_LIB="${REPO_ROOT}/plugins/dev/scripts/lib/deployment-mode.mjs"

FAILURES=0
PASSES=0
SKIPPED=0

ok() {
  PASSES=$((PASSES+1))
}
fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $name"
  echo "    $detail"
}
expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    ok
  else
    fail "$name" "expected='$expected' actual='$actual'"
  fi
}

if ! command -v node >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 \
   || [[ ! -f "$LIB" ]] || [[ ! -f "$JS_LIB" ]]; then
  echo "  SKIP: deployment-mode-parity (node/jq unavailable or libs missing: $LIB / $JS_LIB)"
  echo ""
  echo "Total: 0, Passed: 0, Failed: 0, Skipped: 1"
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

L2_PATH="${TMP_DIR}/layer2.json"
L1_PATH="${TMP_DIR}/layer1.json"

# Static JS probe — the import path is fixed, so no per-cell interpolation is
# needed. Reads the SAME env vars the bash side reads (CATALYST_DEPLOYMENT_MODE
# / CATALYST_LAYER2_CONFIG_FILE / CATALYST_CONFIG_FILE) via
# resolveDeploymentMode()'s own process.env default — a true black-box parity
# check of both public entry points. Fourth field is `inferred` (A4) — `raw`
# stays JS-only (an exported bash var is a poor home for hostile raw bytes).
PROBE_JS="${TMP_DIR}/probe.mjs"
cat > "$PROBE_JS" <<EOF
import { resolveDeploymentMode } from "${JS_LIB}";
const r = resolveDeploymentMode();
process.stdout.write(r.mode + "|" + r.source + "|" + String(r.recognized) + "|" + String(r.inferred));
EOF

# --- Fixture matrix -----------------------------------------------------
# Each *_SETTLE[i] == 1 means this fixture value SETTLES the question at its
# layer (with the paired *_MODE[i]/*_RECOGNIZED[i]); == 0 means it FALLS
# THROUGH to the next layer (the paired MODE/RECOGNIZED entries are unused
# and left empty).

ENV_NAMES=(unset valid garbage quoted unmatched-quote apostrophe crlf)
ENV_VALS=("" "cluster" "typo-env" "\"cluster\"" 'cluster"' "don't" $'cluster\r')
ENV_SETTLE=(0 1 1 1 1 1 1)
ENV_MODE=("" "cluster" "single-host" "single-host" "single-host" "single-host" "cluster")
ENV_RECOGNIZED=("" "true" "false" "false" "false" "false" "true")

L2_NAMES=(absent valid garbage null bool-false number)
L2_BODIES=(
  ""
  '{"catalyst":{"deployment":{"mode":"cloud"}}}'
  '{"catalyst":{"deployment":{"mode":"typo-l2"}}}'
  '{"catalyst":{"deployment":{"mode":null}}}'
  '{"catalyst":{"deployment":{"mode":false}}}'
  '{"catalyst":{"deployment":{"mode":123}}}'
)
L2_SETTLE=(0 1 1 0 1 1)
L2_MODE=("" "cloud" "single-host" "" "single-host" "single-host")
L2_RECOGNIZED=("" "true" "false" "" "false" "false")

L1_NAMES=(absent valid garbage bool-true)
L1_BODIES=(
  ""
  '{"catalyst":{"deployment":{"mode":"single-host"}}}'
  '{"catalyst":{"deployment":{"mode":"typo-l1"}}}'
  '{"catalyst":{"deployment":{"mode":true}}}'
)
L1_SETTLE=(0 1 1 1)
L1_MODE=("" "single-host" "single-host" "single-host")
L1_RECOGNIZED=("" "true" "false" "false")

CELLS=0
for i in "${!ENV_NAMES[@]}"; do
  env_name="${ENV_NAMES[$i]}"
  env_val="${ENV_VALS[$i]}"
  env_settle="${ENV_SETTLE[$i]}"

  for j in "${!L2_NAMES[@]}"; do
    l2_name="${L2_NAMES[$j]}"
    l2_body="${L2_BODIES[$j]}"
    l2_settle="${L2_SETTLE[$j]}"

    for k in "${!L1_NAMES[@]}"; do
      l1_name="${L1_NAMES[$k]}"
      l1_body="${L1_BODIES[$k]}"
      l1_settle="${L1_SETTLE[$k]}"
      CELLS=$((CELLS+1))

      rm -f "$L2_PATH" "$L1_PATH"
      [[ "$l2_name" != "absent" ]] && printf '%s' "$l2_body" > "$L2_PATH"
      [[ "$l1_name" != "absent" ]] && printf '%s' "$l1_body" > "$L1_PATH"

      # --- compute EXPECTED from the design ladder (§4): env > layer2 > layer1 > default
      if [[ "$env_name" != "unset" && "$env_settle" == "1" ]]; then
        EXP_MODE="${ENV_MODE[$i]}"
        EXP_SOURCE="env"
        EXP_RECOGNIZED="${ENV_RECOGNIZED[$i]}"
        EXP_INFERRED="false"
      elif [[ "$l2_settle" == "1" ]]; then
        EXP_MODE="${L2_MODE[$j]}"
        EXP_SOURCE="layer2"
        EXP_RECOGNIZED="${L2_RECOGNIZED[$j]}"
        EXP_INFERRED="false"
      elif [[ "$l1_settle" == "1" ]]; then
        EXP_MODE="${L1_MODE[$k]}"
        EXP_SOURCE="layer1"
        EXP_RECOGNIZED="${L1_RECOGNIZED[$k]}"
        EXP_INFERRED="false"
      else
        EXP_MODE="single-host"
        EXP_SOURCE="default"
        EXP_RECOGNIZED="true"
        EXP_INFERRED="true"
      fi
      EXPECTED="${EXP_MODE}|${EXP_SOURCE}|${EXP_RECOGNIZED}|${EXP_INFERRED}"

      BASH_ARGS=(env -i PATH="$PATH" HOME="$HOME")
      [[ "$env_name" != "unset" ]] && BASH_ARGS+=("CATALYST_DEPLOYMENT_MODE=${env_val}")
      BASH_ARGS+=(
        CATALYST_LAYER2_CONFIG_FILE="$L2_PATH"
        CATALYST_CONFIG_FILE="$L1_PATH"
        bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\" \"\$CATALYST_DEPLOYMENT_MODE_INFERRED\""
      )
      BASH_OUT="$("${BASH_ARGS[@]}")"

      NODE_ARGS=(env -i PATH="$PATH" HOME="$HOME")
      [[ "$env_name" != "unset" ]] && NODE_ARGS+=("CATALYST_DEPLOYMENT_MODE=${env_val}")
      NODE_ARGS+=(
        CATALYST_LAYER2_CONFIG_FILE="$L2_PATH"
        CATALYST_CONFIG_FILE="$L1_PATH"
        node "$PROBE_JS"
      )
      NODE_OUT="$("${NODE_ARGS[@]}" 2>&1)"

      cell_name="env=$env_name l2=$l2_name l1=$l1_name"
      expect_eq "$cell_name (bash==expected)" "$EXPECTED" "$BASH_OUT"
      expect_eq "$cell_name (node==expected)" "$EXPECTED" "$NODE_OUT"
    done
  done
done

echo "Fixture cells run: $CELLS (7 env x 6 layer2 x 4 layer1 = 168; 2 assertions/cell)"
echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES, Skipped: $SKIPPED"
exit "$FAILURES"
