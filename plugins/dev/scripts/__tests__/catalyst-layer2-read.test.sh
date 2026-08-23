#!/usr/bin/env bash
# Shell unit tests for plugins/dev/scripts/lib/catalyst-layer2-read.sh (CTL-1214
# Phase 1). Standalone per-language suite — cross-stack agreement with
# execution-core/config.mjs's readLayer2Merged() is covered separately by
# __tests__/layer2-read-parity.test.sh, which checks BOTH stacks against a
# computed expected value rather than merely against each other.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-layer2-read.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-layer2-read.sh"

FAILURES=0
PASSES=0

ok() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; echo "    $2"; }
expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then ok "$name"; else fail "$name" "expected '$expected' got '$actual'"; fi
}

if [[ ! -f "$LIB" ]]; then
  echo "FAIL: missing lib $LIB"
  exit 1
fi
# shellcheck disable=SC1090
source "$LIB"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Each case gets its own config dir so a stale sibling can't leak between cases.
new_dir() {
  local d; d="$(mktemp -d "${TMP_DIR}/cfgXXXXXX")"; printf '%s' "$d"
}

echo "== catalyst-layer2-read.sh =="

# --- idempotent-load guard -------------------------------------------------
expect_eq "idempotent-source guard set" "1" "${_CATALYST_LAYER2_READ_SH_LOADED:-}"

# --- 1. all three files absent -> empty, rc 0 (fail-open) ------------------
D="$(new_dir)"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.orchestration.dispatchMode')"; RC=$?
expect_eq "1. all absent -> empty" "" "$OUT"
expect_eq "1. all absent -> rc 0" "0" "$RC"

# --- 2. only config.json defines the path ----------------------------------
D="$(new_dir)"
printf '%s' '{"catalyst":{"orchestration":{"dispatchMode":"phase-agents"}}}' > "${D}/config.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.orchestration.dispatchMode')"
expect_eq "2. config.json only" "phase-agents" "$OUT"

# --- 3. node.json overrides config.json ------------------------------------
D="$(new_dir)"
printf '%s' '{"catalyst":{"orchestration":{"dispatchMode":"oneshot-legacy"}}}' > "${D}/config.json"
printf '%s' '{"catalyst":{"orchestration":{"dispatchMode":"phase-agents"}}}' > "${D}/node.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.orchestration.dispatchMode')"
expect_eq "3. node.json beats config.json" "phase-agents" "$OUT"

# --- 4. cluster-secrets.json overrides node.json ---------------------------
D="$(new_dir)"
printf '%s' '{"catalyst":{"x":{"y":"from-config"}}}' > "${D}/config.json"
printf '%s' '{"catalyst":{"x":{"y":"from-node"}}}' > "${D}/node.json"
printf '%s' '{"catalyst":{"x":{"y":"from-secrets"}}}' > "${D}/cluster-secrets.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.x.y')"
expect_eq "4. cluster-secrets beats node.json" "from-secrets" "$OUT"

# --- 5. deep merge, not replace --------------------------------------------
D="$(new_dir)"
printf '%s' '{"catalyst":{"sweep":{"idleHours":48,"intervalHours":1}}}' > "${D}/config.json"
printf '%s' '{"catalyst":{"sweep":{"maxRemovalsPerRun":10}}}' > "${D}/node.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.sweep.idleHours')"
expect_eq "5a. deep merge keeps config.json sibling" "48" "$OUT"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.sweep.maxRemovalsPerRun')"
expect_eq "5b. deep merge keeps node.json sibling" "10" "$OUT"

# --- 6. malformed JSON in ONE file -> that file is layer-absent -------------
D="$(new_dir)"
printf '%s' '{"catalyst":{"sweep":{"intervalHours":1}}}' > "${D}/config.json"
printf '%s' '{ this is not json' > "${D}/node.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.sweep.intervalHours' 2>/dev/null)"
expect_eq "6. malformed node.json -> config.json still read" "1" "$OUT"

# --- 7. a STRING where an object is expected (the live catalyst.feedback case)
# ~/.config/catalyst/config.json really carries catalyst.feedback as a STRING.
# A naive `jq '.catalyst.feedback.autoFile'` dies with "Cannot index string".
D="$(new_dir)"
printf '%s' '{"catalyst":{"feedback":"https://github.com/coalesce-labs/catalyst.git"}}' > "${D}/config.json"
ERRFILE="${D}/err.txt"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.feedback.autoFile' 2>"$ERRFILE")"; RC=$?
expect_eq "7a. string-where-object -> empty" "" "$OUT"
expect_eq "7b. string-where-object -> rc 0" "0" "$RC"
expect_eq "7c. string-where-object -> no stderr" "" "$(cat "$ERRFILE")"

# Positive control for case 7: the same file DOES resolve a scalar path, so the
# empty answer above is a real absence and not a broken reader.
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.feedback')"
expect_eq "7d. positive control: scalar path still resolves" "https://github.com/coalesce-labs/catalyst.git" "$OUT"

# --- 8. jq absent -> empty + breadcrumb -------------------------------------
D="$(new_dir)"
printf '%s' '{"catalyst":{"sweep":{"intervalHours":1}}}' > "${D}/config.json"
ERRFILE="${D}/err8.txt"
# Hide jq WITHOUT hiding bash itself: an absolute /bin/bash is invoked and the
# empty PATH is applied inside the child, so `command -v jq` misses while the
# interpreter still starts. (A bare `PATH=... bash -c` cannot find `bash`, which
# fails with 127 for the wrong reason and would silently pass a broken assertion.)
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" \
       /bin/bash -c 'PATH=/nonexistent-bin; source "$1"; catalyst_layer2_json ".catalyst.sweep.intervalHours"; echo "BREADCRUMB=${CATALYST_LAYER2_READ_JQ_MISSING:-}" >&2' \
       _ "$LIB" 2>"$ERRFILE")"; RC=$?
expect_eq "8a. jq absent -> empty" "" "$OUT"
expect_eq "8b. jq absent -> rc 0" "0" "$RC"
if /usr/bin/grep -q 'BREADCRUMB=1' "$ERRFILE"; then
  ok "8c. jq absent -> CATALYST_LAYER2_READ_JQ_MISSING breadcrumb set"
else
  fail "8c. jq absent -> breadcrumb set" "stderr was: $(cat "$ERRFILE")"
fi
if /usr/bin/grep -qi 'jq' "$ERRFILE"; then
  ok "8d. jq absent -> one stderr line naming jq"
else
  fail "8d. jq absent -> stderr names jq" "stderr was: $(cat "$ERRFILE")"
fi

# --- 9. HOME unset -> never probes /.config/catalyst/... --------------------
# The catalyst-secret-contract.sh:222 trap. Assert on the resolved DIRECTORY,
# because an absent file and a wrongly-probed absent file both read as "".
OUT="$(env -u HOME -u CATALYST_LAYER2_CONFIG_FILE -u XDG_CONFIG_HOME \
       bash -c 'source "$1"; _catalyst_layer2_dir' _ "$LIB")"
case "$OUT" in
  /.config/catalyst) fail "9. HOME unset -> no bare-root probe" "resolved '$OUT'" ;;
  ""              ) fail "9. HOME unset -> no bare-root probe" "resolved empty" ;;
  *               ) ok "9. HOME unset -> no bare-root probe (resolved '$OUT')" ;;
esac

# --- 10. CATALYST_LAYER2_CONFIG_FILE wins; siblings resolve off ITS dir -----
D="$(new_dir)"
printf '%s' '{"catalyst":{"k":"pinned"}}' > "${D}/node.json"
printf '%s' '{}' > "${D}/config.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.k')"
expect_eq "10. siblings resolve off the pinned file's dir" "pinned" "$OUT"

# --- 11. a null value is an ABSENCE, not the string "null" ------------------
D="$(new_dir)"
printf '%s' '{"catalyst":{"orchestration":{"dispatchMode":null}}}' > "${D}/config.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.orchestration.dispatchMode')"
expect_eq "11. null -> empty (never the literal 'null')" "" "$OUT"

# --- 12. an object/array value round-trips as compact JSON ------------------
D="$(new_dir)"
printf '%s' '{"catalyst":{"feedback":{"labels":["auto-submitted"]}}}' > "${D}/config.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.feedback.labels')"
expect_eq "12. array value -> compact JSON" '["auto-submitted"]' "$OUT"

# --- 13. false is a VALUE, not an absence (the salvagePush trap) ------------
D="$(new_dir)"
printf '%s' '{"catalyst":{"sweep":{"salvagePush":false}}}' > "${D}/config.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${D}/config.json" catalyst_layer2_json '.catalyst.sweep.salvagePush')"
expect_eq "13. false survives (jq-falsy trap)" "false" "$OUT"

echo
echo "PASSES=${PASSES} FAILURES=${FAILURES}"
[[ "$FAILURES" -eq 0 ]] || exit 1
