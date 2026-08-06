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

# --- Hostile-probe extensions (Codex remediation on PR #2895, CTL-1617) ---
#
# Four divergence classes the 168-cell matrix above never exercised, because
# each needs a fixture value the matrix's simple string-literal arrays can't
# hold cleanly: an embedded NUL byte, Unicode (not ASCII) whitespace
# padding, a syntactically-valid-JSON-PREFIX-then-garbage file, and a
# JSON escape sequence (a lone UTF-16 surrogate) that only ONE of the two
# parsers accepts. All four are FIXED and assert bash==node==expected, same
# shape as the matrix above: the JS resolver was deliberately NARROWED to
# what bash/jq can match (ASCII-only trim; unpaired-surrogate strings treated
# as layer-malformed), so every exotic input degrades or falls through
# IDENTICALLY on both sides. See the LONE-SURROGATE PARITY comment atop
# _catalyst_deployment_mode_from_file in lib/catalyst-deployment-mode.sh for
# the full rationale.
HOSTILE=0

run_bash_probe() {
  # run_bash_probe [ENV_VAR=VAL ...] -- invokes catalyst_resolve_deployment_mode
  # against $L2_PATH/$L1_PATH under a hermetic env -i, same shape as the
  # per-cell BASH_ARGS above.
  env -i PATH="$PATH" HOME="$HOME" "$@" \
    CATALYST_LAYER2_CONFIG_FILE="$L2_PATH" CATALYST_CONFIG_FILE="$L1_PATH" \
    bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\" \"\$CATALYST_DEPLOYMENT_MODE_RECOGNIZED\" \"\$CATALYST_DEPLOYMENT_MODE_INFERRED\""
}
run_node_probe() {
  env -i PATH="$PATH" HOME="$HOME" "$@" \
    CATALYST_LAYER2_CONFIG_FILE="$L2_PATH" CATALYST_CONFIG_FILE="$L1_PATH" \
    node "$PROBE_JS" 2>&1
}

# --- Probe 1: NUL-escape in JSON (Layer-2) — FIXED, bash==node==expected ---
# {"catalyst":{"deployment":{"mode":"c<NUL>loud"}}} — built via jq's own
# `[0] | implode` (a one-character string whose sole codepoint is 0) rather
# than a literal escape sequence typed directly into this file, since a
# JSON \u-style escape cannot survive this file's own authoring toolchain
# intact (the same reason lib/catalyst-deployment-mode.sh's NUL-BYTE
# CANDIDATE fix uses the same `[0] | implode` construction). Layer-1 holds a
# VALID "cluster" so a
# regression that wrongly falls through (instead of settling degraded at
# layer2) is caught, not masked by an equally-valid default.
rm -f "$L2_PATH" "$L1_PATH"
jq -n '{catalyst:{deployment:{mode: ("c" + ([0] | implode) + "loud")}}}' > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1_PATH"
EXPECTED="single-host|layer2|false|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "hostile: NUL-escape in Layer-2 JSON (bash==expected)" "$EXPECTED" "$BASH_OUT"
expect_eq "hostile: NUL-escape in Layer-2 JSON (node==expected)" "$EXPECTED" "$NODE_OUT"

# --- Probe 2: NBSP-padded env value — FIXED, bash==node==expected ---
# CATALYST_DEPLOYMENT_MODE = NBSP + "cluster" + NBSP (U+00A0 on both sides).
# Built via `[160,...] | implode` for the same authoring reason as Probe 1
# (NBSP is representable in a bash variable — unlike NUL, env vars can hold
# it — so it's built once and passed straight through as env, not a file).
# BOTH trims are ASCII-only by design (parity beats Unicode hospitality), so
# the NBSP padding survives on both sides, fails enum membership on both
# sides, and SETTLES degraded at env on both sides.
rm -f "$L2_PATH" "$L1_PATH"
NBSP_PADDED_CLUSTER="$(jq -n -r '[160,99,108,117,115,116,101,114,160] | implode')"
EXPECTED="single-host|env|false|false"
BASH_OUT="$(run_bash_probe "CATALYST_DEPLOYMENT_MODE=${NBSP_PADDED_CLUSTER}")"
NODE_OUT="$(run_node_probe "CATALYST_DEPLOYMENT_MODE=${NBSP_PADDED_CLUSTER}")"
HOSTILE=$((HOSTILE+1))
expect_eq "hostile: NBSP-padded env value (bash==expected)" "$EXPECTED" "$BASH_OUT"
expect_eq "hostile: NBSP-padded env value (node==expected)" "$EXPECTED" "$NODE_OUT"

# --- Probe 3: malformed-trailing-content JSON (Layer-2) — FIXED,
# bash==node==expected --- A syntactically valid object immediately
# followed by stray non-JSON text. jq can print a tag for the valid PREFIX
# before erroring on the trailing garbage; the fix discards that partial
# output rather than concatenating it with a fallback "@ABSENT". Layer-1
# holds a valid "cluster" so the malformed Layer-2 file must fall all the
# way through to it.
rm -f "$L2_PATH" "$L1_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cloud"}}} this is not valid trailing json' > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1_PATH"
EXPECTED="cluster|layer1|true|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "hostile: malformed-trailing-content Layer-2 JSON (bash==expected)" "$EXPECTED" "$BASH_OUT"
expect_eq "hostile: malformed-trailing-content Layer-2 JSON (node==expected)" "$EXPECTED" "$NODE_OUT"

# --- Probe 4: lone-surrogate JSON (Layer-2) — FIXED, bash==node==expected ---
# A JSON string containing an unpaired UTF-16 high surrogate escape
# ("clu\ud800ster"). jq's parser rejects the escape and fails to parse the
# WHOLE document (verified: jq-1.7.1 exits 5, "Invalid \uXXXX\uXXXX
# surrogate pair escape"), so the bash resolver treats the file as @ABSENT
# and falls through. The JS resolver is deliberately NARROWED to match:
# readDeploymentModeField treats a mode string carrying an unpaired
# surrogate as layer-malformed (undefined) — BOTH sides fall through to the
# valid Layer-1 "cloud". (Valid surrogate PAIRS parse in both languages and
# are simply non-members — not this case.)
#
# The escape is built via a variable-expansion split (a lone backslash in
# its own variable, concatenated next to a literal "ud800ster") rather than
# a literal \ud800 escape typed directly in this file's source, for the same
# authoring-toolchain reason documented at Probe 1.
rm -f "$L2_PATH" "$L1_PATH"
# shellcheck disable=SC1003 # genuinely a literal single backslash, not an escape attempt
BACKSLASH='\'
printf '%s' "{\"catalyst\":{\"deployment\":{\"mode\":\"clu${BACKSLASH}ud800ster\"}}}" > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cloud"}}}' > "$L1_PATH"
EXPECTED="cloud|layer1|true|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "hostile: lone-surrogate Layer-2 JSON (bash==expected, falls through)" "$EXPECTED" "$BASH_OUT"
expect_eq "hostile: lone-surrogate Layer-2 JSON (node==expected, falls through — JS narrowed to match jq)" "$EXPECTED" "$NODE_OUT"

# --- Probe 4b: lone surrogate in an UNRELATED field (Codex on #2903) --------
# {"mode":"cloud","other":"\ud800"}: jq rejects the WHOLE document, so bash
# falls through — the JS reader must scan the RAW TEXT for unpaired surrogate
# escapes (not just the extracted mode string) to match. A valid recognized
# mode beside a poisoned sibling field must fall through on BOTH sides.
rm -f "$L2_PATH" "$L1_PATH"
printf '%s' "{\"catalyst\":{\"deployment\":{\"mode\":\"cloud\",\"other\":\"x${BACKSLASH}ud800\"}}}" > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1_PATH"
EXPECTED="cluster|layer1|true|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "hostile: lone surrogate in an UNRELATED field (bash==expected, whole document rejected)" "$EXPECTED" "$BASH_OUT"
expect_eq "hostile: lone surrogate in an UNRELATED field (node==expected, raw-text scan matches jq)" "$EXPECTED" "$NODE_OUT"

# Control: a VALID surrogate PAIR anywhere in the document parses in BOTH
# languages — the raw-text scan must not over-reject astral characters.
rm -f "$L2_PATH" "$L1_PATH"
printf '%s' "{\"catalyst\":{\"deployment\":{\"mode\":\"cloud\",\"other\":\"x${BACKSLASH}ud83d${BACKSLASH}ude00\"}}}" > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1_PATH"
EXPECTED="cloud|layer2|true|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "control: valid surrogate PAIR in a sibling field parses (bash==expected)" "$EXPECTED" "$BASH_OUT"
expect_eq "control: valid surrogate PAIR in a sibling field parses (node==expected)" "$EXPECTED" "$NODE_OUT"

# --- Probe 4c: jq-EXACT lone-surrogate semantics (CTL-1616 verifier lesson) ---
# jq 1.7.1 rejects ONLY lone HIGH escapes; a lone LOW is accepted with U+FFFD
# substitution, and an escaped-backslash-then-text "\\ud800" is literal text.
# The JS scanner mirrors all three exactly.
# (1) lone LOW in the mode VALUE: both engines read a U+FFFD-bearing string,
#     a non-member, and SETTLE degraded at that layer.
rm -f "$L2_PATH" "$L1_PATH"
printf '%s' "{\"catalyst\":{\"deployment\":{\"mode\":\"clu${BACKSLASH}udc00ster\"}}}" > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1_PATH"
EXPECTED="single-host|layer2|false|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "jq-exact: lone LOW in the mode value settles degraded (bash==expected)" "$EXPECTED" "$BASH_OUT"
expect_eq "jq-exact: lone LOW in the mode value settles degraded (node==expected)" "$EXPECTED" "$NODE_OUT"
# (2) lone LOW in an UNRELATED field: document accepted by both, mode resolves.
rm -f "$L2_PATH" "$L1_PATH"
printf '%s' "{\"catalyst\":{\"deployment\":{\"mode\":\"cloud\",\"other\":\"x${BACKSLASH}udc00\"}}}" > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1_PATH"
EXPECTED="cloud|layer2|true|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "jq-exact: lone LOW in an unrelated field is accepted (bash==expected)" "$EXPECTED" "$BASH_OUT"
expect_eq "jq-exact: lone LOW in an unrelated field is accepted (node==expected)" "$EXPECTED" "$NODE_OUT"
# (3) escaped backslash + literal "ud800" text (even run — NOT a live escape):
#     valid JSON both parsers accept; the document must not be rejected.
rm -f "$L2_PATH" "$L1_PATH"
printf '%s' "{\"catalyst\":{\"deployment\":{\"mode\":\"cloud\",\"other\":\"${BACKSLASH}${BACKSLASH}ud800\"}}}" > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1_PATH"
EXPECTED="cloud|layer2|true|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "jq-exact: escaped-backslash literal ud800 text is NOT a live escape (bash==expected)" "$EXPECTED" "$BASH_OUT"
expect_eq "jq-exact: escaped-backslash literal ud800 text is NOT a live escape (node==expected)" "$EXPECTED" "$NODE_OUT"

# --- Probe 5: multi-document Layer-2 JSON — FIXED, bash==node==expected ---
# Two valid top-level documents. Bare jq streams both (exit 0, two tags,
# bypassing the exit-status guard); JSON.parse rejects the file. The bash
# reader slurps (-s) so length!=1 classifies as layer-malformed — BOTH sides
# fall through to the valid Layer-1.
rm -f "$L2_PATH" "$L1_PATH"
printf '%s\n%s\n' '{"catalyst":{"deployment":{"mode":"cloud"}}}' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1_PATH"
EXPECTED="cluster|layer1|true|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "hostile: multi-document Layer-2 JSON (bash==expected, falls through)" "$EXPECTED" "$BASH_OUT"
expect_eq "hostile: multi-document Layer-2 JSON (node==expected, falls through)" "$EXPECTED" "$NODE_OUT"

# --- Probe 6: BOM-prefixed Layer-2 JSON — FIXED, bash==node==expected ---
# This jq build tolerates a UTF-8 BOM; JSON.parse throws on one. The bash
# reader byte-sniffs EF BB BF and reports @ABSENT — BOTH sides fall through.
rm -f "$L2_PATH" "$L1_PATH"
printf '\xef\xbb\xbf%s' '{"catalyst":{"deployment":{"mode":"cloud"}}}' > "$L2_PATH"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$L1_PATH"
EXPECTED="cluster|layer1|true|false"
BASH_OUT="$(run_bash_probe)"
NODE_OUT="$(run_node_probe)"
HOSTILE=$((HOSTILE+1))
expect_eq "hostile: BOM-prefixed Layer-2 JSON (bash==expected, falls through)" "$EXPECTED" "$BASH_OUT"
expect_eq "hostile: BOM-prefixed Layer-2 JSON (node==expected, falls through)" "$EXPECTED" "$NODE_OUT"

echo "Hostile probes run: $HOSTILE (NUL-escape / NBSP-padded-env / malformed-trailing-content / lone-HIGH x2 + lone-LOW x2 + literal-text + pair-control / multi-document / BOM; 2 assertions/probe)"
echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES, Skipped: $SKIPPED"
exit "$FAILURES"
