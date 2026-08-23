#!/usr/bin/env bash
# Cross-stack parity test for lib/catalyst-layer2-read.sh (bash) vs
# execution-core/config.mjs's readLayer2Merged() (JS) — CTL-1214 Phase 1.
#
# Modelled on __tests__/deployment-mode-parity.test.sh, including its central
# rule: the expected value for every cell is COMPUTED from the fixture
# definition (the config.json < node.json < cluster-secrets.json deep-merge
# cascade), never copied from either implementation. The assertion is threeway —
#   bash == expected  AND  js == expected
# — because asserting bash == js alone is a false-green on exactly the property
# this file exists to guard: two implementations can agree with each other while
# both disagreeing with the spec.
#
# Fixture matrix: 8 layer triples x 6 dotted keys = 48 cells.
#
# Run: bash plugins/dev/scripts/__tests__/layer2-read-parity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-layer2-read.sh"
JS_CONFIG="${REPO_ROOT}/plugins/dev/scripts/execution-core/config.mjs"

FAILURES=0
PASSES=0
ok() { PASSES=$((PASSES+1)); }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; echo "    $2"; }

for f in "$LIB" "$JS_CONFIG"; do
  [[ -f "$f" ]] || { echo "FAIL: missing $f"; exit 1; }
done
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq unavailable"; exit 0; }

# Runtime: config.mjs loads under BOTH node and bun; prefer whichever exists.
JS_RUN=""
command -v bun >/dev/null 2>&1 && JS_RUN="bun"
[[ -z "$JS_RUN" ]] && command -v node >/dev/null 2>&1 && JS_RUN="node"
[[ -z "$JS_RUN" ]] && { echo "SKIP: neither bun nor node available"; exit 0; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# ─── Fixture axes ──────────────────────────────────────────────────────────
# Each triple is: <config.json body>|<node.json body>|<cluster-secrets.json body>
# "-" means the file is ABSENT. "!" means the file is present but MALFORMED
# (which the contract defines as layer-absent, on BOTH stacks).
FIXTURES=(
  "-|-|-"
  '{"catalyst":{"a":"c","n":{"deep":1}}}|-|-'
  '{"catalyst":{"a":"c"}}|{"catalyst":{"a":"n"}}|-'
  '{"catalyst":{"a":"c"}}|{"catalyst":{"a":"n"}}|{"catalyst":{"a":"s"}}'
  '{"catalyst":{"n":{"deep":1}}}|{"catalyst":{"n":{"other":2}}}|-'
  '{"catalyst":{"a":"c","n":{"deep":1}}}|!|-'
  '{"catalyst":{"feedback":"a-string"}}|-|-'
  '{"catalyst":{"b":false,"z":null}}|-|-'
)

KEYS=(
  ".catalyst.a"
  ".catalyst.n.deep"
  ".catalyst.n.other"
  ".catalyst.feedback.autoFile"
  ".catalyst.b"
  ".catalyst.z"
)

# ─── The computed oracle ───────────────────────────────────────────────────
# Independently re-derives the expected answer from the fixture triple, using a
# jq program written from the SPEC (deep-merge the well-formed layers in order;
# a null or unindexable path is an absence). It never consults either
# implementation under test.
# compute_expected <dir> <key> [legacy_file]
#
# CTL-1214 remediation: the legacy (lowest-precedence) file is a PARAMETER, not a
# hardcoded "${dir}/config.json". Both implementations take the pinned
# CATALYST_LAYER2_CONFIG_FILE path itself as that layer, so an oracle that always
# composed config.json could not express the pinned-name case at all — which is
# precisely why the divergence it exists to catch went unobserved.
compute_expected() {
  local dir="$1" key="$2" legacy="${3:-${1}/config.json}"
  local -a good=()
  local f
  for f in "$legacy" "${dir}/node.json" "${dir}/cluster-secrets.json"; do
    [[ -f "$f" ]] || continue
    jq -e 'type == "object"' "$f" >/dev/null 2>&1 || continue
    good+=("$f")
  done
  [[ ${#good[@]} -eq 0 ]] && { printf ''; return 0; }
  jq -rc -n --arg p "$key" '
      reduce inputs as $x ({}; . * $x)
      | try (getpath($p | ltrimstr(".") | split("."))) catch empty
      | if . == null then empty else . end
    ' "${good[@]}" 2>/dev/null || printf ''
}

# ─── The JS side ───────────────────────────────────────────────────────────
# readLayer2Merged() returns { catalyst: {...} }; walk the same dotted path and
# render with the SAME conventions the bash reader uses (scalars bare, objects
# and arrays as compact JSON, null/absent as empty) so a difference in the
# ANSWER is never mistaken for a difference in FORMATTING.
JS_DRIVER="${TMP_DIR}/driver.mjs"
# The config module path is passed through the ENVIRONMENT (JS_CONFIG_URL), never
# interpolated into the driver source. Interpolating it would need bash 4.4's
# ${var@Q} to be safe, and macOS ships bash 3.2 — the unsupported expansion emits
# "bad substitution", writes a truncated driver, and every JS cell then returns
# empty, which reads as a real parity failure rather than a broken harness.
cat > "$JS_DRIVER" <<'JSEOF'
const { readLayer2Merged } = await import(process.env.JS_CONFIG_URL);
const key = process.argv[2];
const merged = readLayer2Merged();
let cur = merged;
for (const seg of key.replace(/^\./, "").split(".")) {
  if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !(seg in cur)) {
    cur = undefined;
    break;
  }
  cur = cur[seg];
}
if (cur === undefined || cur === null) process.stdout.write("");
else if (typeof cur === "object") process.stdout.write(JSON.stringify(cur));
else process.stdout.write(String(cur));
JSEOF
export JS_CONFIG_URL="file://${JS_CONFIG}"

# Harness self-check: prove the JS driver actually RUNS before trusting a matrix
# of empty answers from it. A driver that fails to start returns "" for every
# cell, which is indistinguishable from a genuine absence.
_probe_dir="$(mktemp -d "${TMP_DIR}/probeXXXXXX")"
printf '%s' '{"catalyst":{"probe":"alive"}}' > "${_probe_dir}/config.json"
_probe_out="$(CATALYST_LAYER2_CONFIG_FILE="${_probe_dir}/config.json" "$JS_RUN" "$JS_DRIVER" ".catalyst.probe" 2>&1)"
if [[ "$_probe_out" != "alive" ]]; then
  echo "FAIL: JS driver harness is broken (probe returned '${_probe_out}') — refusing to report parity"
  exit 1
fi

cell=0
for fixture in "${FIXTURES[@]}"; do
  D="$(mktemp -d "${TMP_DIR}/fxXXXXXX")"
  IFS='|' read -r c_body n_body s_body <<< "$fixture"
  write_layer() {
    local body="$1" path="$2"
    [[ "$body" == "-" ]] && return 0
    if [[ "$body" == "!" ]]; then printf '%s' '{ not json at all' > "$path"; return 0; fi
    printf '%s' "$body" > "$path"
  }
  write_layer "$c_body" "${D}/config.json"
  write_layer "$n_body" "${D}/node.json"
  write_layer "$s_body" "${D}/cluster-secrets.json"

  for key in "${KEYS[@]}"; do
    cell=$((cell+1))
    expected="$(compute_expected "$D" "$key")"

    bash_out="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" \
                /bin/bash -c 'source "$1"; catalyst_layer2_json "$2"' _ "$LIB" "$key" 2>/dev/null)"

    js_out="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" \
              "$JS_RUN" "$JS_DRIVER" "$key" 2>/dev/null)"

    if [[ "$bash_out" != "$expected" ]]; then
      fail "cell ${cell} [${fixture}] ${key}: bash != expected" "expected '${expected}' got '${bash_out}'"
    else
      ok
    fi
    if [[ "$js_out" != "$expected" ]]; then
      fail "cell ${cell} [${fixture}] ${key}: js != expected" "expected '${expected}' got '${js_out}'"
    else
      ok
    fi
  done
done

# ─── The pinned-name axis (CTL-1214 remediation) ───────────────────────────
# ⚠️ THE CASE THE MATRIX COULD NOT EXPRESS. Every cell above pins
# `${D}/config.json`, so the one axis the two implementations actually differed
# on — WHICH file the pin names as the legacy layer — was unobservable, while
# catalyst-layer2-read.sh's header claimed agreement "over a fixture matrix".
#
# The fixture puts a DIFFERENT value in config.json than in the pinned
# config-adva.json, so a stack that ignores the pin and reads config.json returns
# a distinguishable wrong answer instead of accidentally agreeing.
D="$(mktemp -d "${TMP_DIR}/pinXXXXXX")"
printf '%s' '{"catalyst":{"probe":"FROM-config.json"}}'      > "${D}/config.json"
printf '%s' '{"catalyst":{"probe":"FROM-config-adva.json"}}' > "${D}/config-adva.json"
PINNED="${D}/config-adva.json"

pin_expected="$(compute_expected "$D" ".catalyst.probe" "$PINNED")"
if [[ "$pin_expected" == "FROM-config-adva.json" ]]; then
  ok
else
  fail "pinned-name oracle composes the PINNED file as the legacy layer" \
       "expected 'FROM-config-adva.json' got '${pin_expected}'"
fi

pin_bash="$(CATALYST_LAYER2_CONFIG_FILE="$PINNED" \
            /bin/bash -c 'source "$1"; catalyst_layer2_json "$2"' _ "$LIB" ".catalyst.probe" 2>/dev/null)"
pin_js="$(CATALYST_LAYER2_CONFIG_FILE="$PINNED" "$JS_RUN" "$JS_DRIVER" ".catalyst.probe" 2>/dev/null)"

if [[ "$pin_bash" == "$pin_expected" ]]; then ok; else
  fail "pinned non-config.json name: bash != expected" "expected '${pin_expected}' got '${pin_bash}'"
fi
if [[ "$pin_js" == "$pin_expected" ]]; then ok; else
  fail "pinned non-config.json name: js != expected" "expected '${pin_expected}' got '${pin_js}'"
fi
if [[ "$pin_bash" == "$pin_js" ]]; then ok; else
  fail "pinned non-config.json name: bash != js" "bash '${pin_bash}' vs js '${pin_js}'"
fi

# Negative control for the case above: the fixture CAN produce the wrong answer,
# so the three assertions are evidence about the readers rather than about a
# fixture in which both files happen to say the same thing.
if [[ "$pin_bash" != "FROM-config.json" ]]; then ok; else
  fail "pinned-name case: bash fell back to config.json" "got '${pin_bash}'"
fi

# And the siblings must STILL resolve off the pinned file's directory — the pin
# changes which file is the legacy layer, never where node.json is looked up.
printf '%s' '{"catalyst":{"probe":"FROM-node.json"}}' > "${D}/node.json"
pin2_expected="$(compute_expected "$D" ".catalyst.probe" "$PINNED")"
pin2_bash="$(CATALYST_LAYER2_CONFIG_FILE="$PINNED" \
             /bin/bash -c 'source "$1"; catalyst_layer2_json "$2"' _ "$LIB" ".catalyst.probe" 2>/dev/null)"
pin2_js="$(CATALYST_LAYER2_CONFIG_FILE="$PINNED" "$JS_RUN" "$JS_DRIVER" ".catalyst.probe" 2>/dev/null)"
if [[ "$pin2_expected" == "FROM-node.json" ]]; then ok; else
  fail "pinned-name + sibling: oracle lets node.json outrank the pinned legacy file" \
       "expected 'FROM-node.json' got '${pin2_expected}'"
fi
if [[ "$pin2_bash" == "$pin2_expected" ]]; then ok; else
  fail "pinned-name + sibling: bash != expected" "expected '${pin2_expected}' got '${pin2_bash}'"
fi
if [[ "$pin2_js" == "$pin2_expected" ]]; then ok; else
  fail "pinned-name + sibling: js != expected" "expected '${pin2_expected}' got '${pin2_js}'"
fi

# ─── Positive control ──────────────────────────────────────────────────────
# The matrix above must actually be able to FAIL. Feed the oracle a fixture whose
# expected value is known by hand and assert the loop's own comparison would
# reject a wrong answer — otherwise "48 cells passed" could just mean the cells
# never resolved anything.
D="$(mktemp -d "${TMP_DIR}/pcXXXXXX")"
printf '%s' '{"catalyst":{"a":"c"}}' > "${D}/config.json"
printf '%s' '{"catalyst":{"a":"n"}}' > "${D}/node.json"
pc_expected="$(compute_expected "$D" ".catalyst.a")"
if [[ "$pc_expected" == "n" ]]; then
  ok
else
  fail "positive control: oracle resolves node-over-config" "expected 'n' got '${pc_expected}'"
fi
if [[ "$pc_expected" != "c" ]]; then
  ok
else
  fail "positive control: oracle is not returning the config.json value" "got '${pc_expected}'"
fi

echo "cells=${cell} (x2 stacks) PASSES=${PASSES} FAILURES=${FAILURES}"
[[ "$FAILURES" -eq 0 ]] || exit 1
