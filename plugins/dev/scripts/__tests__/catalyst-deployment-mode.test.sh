#!/usr/bin/env bash
# Shell unit tests for plugins/dev/scripts/lib/catalyst-deployment-mode.sh
# (CTL-1617). Standalone per-language suite — cross-stack agreement with
# lib/deployment-mode.mjs is covered separately by
# __tests__/deployment-mode-parity.test.sh. Follows the __tests__/
# host-identity.test.sh conventions (ok/fail/expect_eq, PASSES/FAILURES exit
# code).
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-deployment-mode.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-deployment-mode.sh"

# shellcheck disable=SC1090
source "$LIB"

FAILURES=0
PASSES=0

ok() {
  local name="$1"
  PASSES=$((PASSES+1))
  echo "  PASS: $name"
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
    ok "$name"
  else
    fail "$name" "expected '$expected' got '$actual'"
  fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
L2="${TMP_DIR}/layer2.json"
L1="${TMP_DIR}/layer1.json"
MISSING="${TMP_DIR}/does-not-exist.json"

# --- idempotent-load guard ------------------------------------------------
expect_eq "idempotent-source guard set" "1" "${_CATALYST_DEPLOYMENT_MODE_SH_LOADED:-}"

# --- frozen enum -----------------------------------------------------------
# _CATALYST_DEPLOYMENT_MODES is an array (IFS-independent membership fix,
# CTL-1617 Codex remediation) — join with "${arr[*]}", not a bare "$arr"
# (which would only yield the first element).
expect_eq "enum is the 3 canonical values" "single-host cluster cloud" "${_CATALYST_DEPLOYMENT_MODES[*]}"
if _catalyst_deployment_mode_is_member "single-host" && _catalyst_deployment_mode_is_member "cluster" \
   && _catalyst_deployment_mode_is_member "cloud"; then
  ok "all three canonical values are members"
else
  fail "canonical membership" "one of single-host/cluster/cloud rejected"
fi
if _catalyst_deployment_mode_is_member "both"; then
  fail "no fourth value" "'both' was accepted as a member"
else
  ok "'both' is deliberately not a member (CTL-1617 design §2)"
fi

# --- default: nothing set anywhere -----------------------------------------
rm -f "$L2" "$L1"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "nothing set ⇒ default/single-host/recognized" "single-host|default|true" "$OUT"

# --- env wins over both files ------------------------------------------
printf '%s' '{"catalyst":{"deployment":{"mode":"cloud"}}}' > "$L2"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_DEPLOYMENT_MODE="cluster" \
  CATALYST_LAYER2_CONFIG_FILE="$L2" CATALYST_CONFIG_FILE="$L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "env wins over Layer-2 and Layer-1" "cluster|env|true" "$OUT"

# --- Layer-2 wins over Layer-1 when env absent -----------------------------
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$L2" CATALYST_CONFIG_FILE="$L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "Layer-2 wins when env absent" "cloud|layer2|true" "$OUT"

# --- Layer-1 wins when env + Layer-2 absent --------------------------------
rm -f "$L2"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "Layer-1 wins when env + Layer-2 absent" "cluster|layer1|true" "$OUT"

# --- explicit JSON null at Layer-2 falls through to Layer-1 ---------------
printf '%s' '{"catalyst":{"deployment":{"mode":null}}}' > "$L2"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$L2" CATALYST_CONFIG_FILE="$L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "explicit null at Layer-2 falls through to Layer-1" "cluster|layer1|true" "$OUT"

# --- unrecognized (typo) degrades AT that layer, does not fall through ----
printf '%s' '{"catalyst":{"deployment":{"mode":"clustre"}}}' > "$L2"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$L2" CATALYST_CONFIG_FILE="$L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "typo at Layer-2 degrades to single-host, recognized:false, source layer2 (no fallthrough to a valid Layer-1)" \
  "single-host|layer2|false" "$OUT"

# --- unrecognized (typo) at env degrades, source env ------------------------
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_DEPLOYMENT_MODE="clustre" \
  CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "typo at env degrades to single-host, recognized:false, source env" "single-host|env|false" "$OUT"

# --- case/whitespace normalization -----------------------------------------
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_DEPLOYMENT_MODE="  Cluster  " \
  CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "mixed-case/boundary-whitespace normalizes to canonical member" "cluster|env|true" "$OUT"

# --- whitespace-only env falls through (mirrors an empty env var) ---------
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L2"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_DEPLOYMENT_MODE="   " \
  CATALYST_LAYER2_CONFIG_FILE="$L2" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "whitespace-only env falls through to Layer-2" "cluster|layer2|true" "$OUT"

# --- malformed JSON at Layer-2 treated as absent, falls through -----------
printf '%s' '{not valid json' > "$L2"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$L2" CATALYST_CONFIG_FILE="$L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "malformed Layer-2 JSON treated as absent, falls through to Layer-1" "cluster|layer1|true" "$OUT"

# --- BLOCKING 1: JSON `false`/non-string values settle degraded, never
# fall through (the `// empty` bug this replaces would swallow JSON false) --
printf '%s' '{"catalyst":{"deployment":{"mode":false}}}' > "$L2"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$L2" CATALYST_CONFIG_FILE="$L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "JSON false at Layer-2 settles degraded at layer2 (does NOT fall through to a valid Layer-1)" \
  "single-host|layer2|false" "$OUT"

printf '%s' '{"catalyst":{"deployment":{"mode":123}}}' > "$L2"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$L2" CATALYST_CONFIG_FILE="$L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "JSON number at Layer-2 settles degraded at layer2" "single-host|layer2|false" "$OUT"

# --- BLOCKING 2: quote/CRLF-hostile env values trim as pure data, never as
# shell syntax ----------------------------------------------------------
rm -f "$L2"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'; CATALYST_DEPLOYMENT_MODE='\"cluster\"'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "embedded-quotes env value is DATA, not a recognized member" "single-host|env|false" "$OUT"

OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'; CATALYST_DEPLOYMENT_MODE='cluster\"'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "unmatched-quote env value never errors (no xargs 'unmatched quote')" "single-host|env|false" "$OUT"

OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'; CATALYST_DEPLOYMENT_MODE=\$'cluster\r'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "CRLF-suffixed env value trims to a recognized member" "cluster|env|true" "$OUT"

# --- A4: CATALYST_DEPLOYMENT_MODE_INFERRED ----------------------------------
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s' \"\$CATALYST_DEPLOYMENT_MODE_INFERRED\"")"
expect_eq "inferred=true only for the constant default" "true" "$OUT"

OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_DEPLOYMENT_MODE="cluster" \
  CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s' \"\$CATALYST_DEPLOYMENT_MODE_INFERRED\"")"
expect_eq "inferred=false when env settles the question" "false" "$OUT"

# --- F8: enum membership is independent of caller IFS -----------------------
# A sourcing script running under strict-shell IFS=$'\n\t' (no space) must
# not break membership: the enum lives in a bash array iterated as
# "${arr[@]}", so no word-splitting is ever involved.
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_DEPLOYMENT_MODE="cluster" \
  CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "IFS=\$'\n\t'; source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\"")"
expect_eq "IFS=\$'\\n\\t' in the sourcing shell cannot break enum membership" "cluster|env|true" "$OUT"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
