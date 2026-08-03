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

# --- Codex round 2: errexit-inheritance safety ------------------------------
# Under `bash --posix` (or shopt -s inherit_errexit) a nonzero jq inside $()
# aborts the whole shell unless the capture runs in a condition context. A
# readable-but-malformed Layer-2 with a valid Layer-1 must fall through and
# exit 0 even under set -e + POSIX mode.
R2_L2="${TMP_DIR}/r2-malformed-l2.json"
R2_L1="${TMP_DIR}/r2-valid-l1.json"
printf '%s' '{"catalyst":{"deployment":{"mode":' > "$R2_L2"
printf '%s' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$R2_L1"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$R2_L2" CATALYST_CONFIG_FILE="$R2_L1" \
  bash --posix -e -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s|rc0' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\"")"
expect_eq "set -e + POSIX mode: malformed Layer-2 falls through, never aborts" "cluster|layer1|rc0" "$OUT"

# --- Codex round 2: multi-document JSON rejected like JSON.parse ------------
# Two valid top-level documents: bare jq streams both (exit 0, two tags);
# JSON.parse rejects the file. --slurp collapses it to length!=1 → @ABSENT.
R2_MULTI="${TMP_DIR}/r2-multidoc-l2.json"
printf '%s\n%s\n' '{"catalyst":{"deployment":{"mode":"cloud"}}}' '{"catalyst":{"deployment":{"mode":"cluster"}}}' > "$R2_MULTI"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$R2_MULTI" CATALYST_CONFIG_FILE="$R2_L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\"")"
expect_eq "multi-document Layer-2 is layer-malformed → falls through" "cluster|layer1" "$OUT"

# --- Codex round 2: BOM-prefixed JSON rejected like JSON.parse --------------
R2_BOM="${TMP_DIR}/r2-bom-l2.json"
printf '\xef\xbb\xbf%s' '{"catalyst":{"deployment":{"mode":"cloud"}}}' > "$R2_BOM"
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$R2_BOM" CATALYST_CONFIG_FILE="$R2_L1" \
  bash -c "source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\"")"
expect_eq "BOM-prefixed Layer-2 is layer-malformed → falls through" "cluster|layer1" "$OUT"

# --- Codex round 2: HOME-unset resolution never probes /.config -------------
# HERMETICITY BOUND: with HOME unset, tilde expansion falls back to the REAL
# passwd home (mirroring os.homedir()) — which this sandbox cannot fake, so an
# end-to-end assertion through the default Layer-2 path reads the developer's
# actual ~/.config/catalyst/config.json and breaks the moment that file
# declares a deployment mode (observed live 2026-08-03 when this machine
# gained its Layer-2 override). Assert the two halves separately instead:
# (1) the tilde fallback derives a real absolute home (never "" → /.config);
# shellcheck disable=SC2016 # single quotes deliberate — the INNER shell must expand
HOME_FALLBACK="$(env -i PATH="$PATH" bash -c 'unset HOME; h=~; printf "%s" "$h"')"
if [[ "$HOME_FALLBACK" == /* && "$HOME_FALLBACK" != "/" ]]; then
  ok "HOME unset: tilde fallback derives an absolute passwd home (never /.config)"
else
  fail "HOME unset: tilde fallback derives an absolute passwd home (never /.config)" \
    "got '$HOME_FALLBACK'"
fi
# (2) the resolver completes under unset HOME with the Layer-2 path pinned
# hermetically (no crash, no set -u abort, Layer-1 settles).
OUT="$(env -i PATH="$PATH" CATALYST_LAYER2_CONFIG_FILE="$MISSING" CATALYST_CONFIG_FILE="$R2_L1" \
  bash -c "unset HOME; source '$LIB'; catalyst_resolve_deployment_mode >/dev/null; printf '%s|%s' \"\$CATALYST_DEPLOYMENT_MODE_RESOLVED\" \"\$CATALYST_DEPLOYMENT_MODE_SOURCE\"")"
expect_eq "HOME unset: resolver completes without crashing (hermetic Layer-2)" "cluster|layer1" "$OUT"

# --- Codex round 2: jq-missing breadcrumb resets per resolution -------------
# First resolution with jq hidden and a readable file → breadcrumb=1; a second
# resolution in the same shell with jq restored must CLEAR it (no stale latch).
R2_STUB="${TMP_DIR}/r2-no-jq-bin"
mkdir -p "$R2_STUB"
for t in bash printf head od tr cat env; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$R2_STUB/$t"
done
OUT="$(env -i PATH="$PATH" HOME="$HOME" CATALYST_LAYER2_CONFIG_FILE="$R2_L1" CATALYST_CONFIG_FILE="$MISSING" \
  bash -c "source '$LIB'
    PATH='$R2_STUB' catalyst_resolve_deployment_mode >/dev/null
    first=\${CATALYST_DEPLOYMENT_MODE_JQ_MISSING:-unset}
    catalyst_resolve_deployment_mode >/dev/null
    second=\${CATALYST_DEPLOYMENT_MODE_JQ_MISSING:-unset}
    printf '%s|%s' \"\$first\" \"\$second\"")"
expect_eq "jq-missing breadcrumb is per-resolution, not a latch" "1|unset" "$OUT"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
