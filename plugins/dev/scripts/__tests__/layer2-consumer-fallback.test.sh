#!/usr/bin/env bash
# Layer-2 fallback at the five BASH consumer sites (CTL-1214 Phase 1).
# Run: bash plugins/dev/scripts/__tests__/layer2-consumer-fallback.test.sh
#
# Each of these read a relocated key from Layer-1 ONLY, behind a fail-open
# `// empty` + a local default. Slimming .catalyst/config.json therefore does not
# ERROR at any of them — it silently reverts the knob. Every case below asserts
# BOTH halves: the Layer-2 value is resolved, AND the result is not the silent
# default that a regression would produce.
#
# WHY A DEDICATED FILE rather than extending the suites the plan named:
#   • __tests__/catalyst-config.test.sh is scoped to the `catalyst-config` CLI's
#     help/JSON/router contract — consumer resolution is a different subject.
#   • __tests__/orphan-sweep.test.sh is 136 KB and has known CI-flaky log-count
#     assertions; appending here keeps a flake in that file from masking these.
# This file is registered in .github/workflows/execution-core-tests.yml in the
# same change that adds it — CI runs an explicit list, never a glob.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${SCRIPT_DIR}/.." && pwd)"

FAILURES=0
PASSES=0
ok() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; echo "    $2"; }
expect_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }
expect_ne() { if [[ "$2" != "$3" ]]; then ok "$1"; else fail "$1" "expected NOT '$3'"; fi; }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq unavailable"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# mk_l1 <json> -> path to a Layer-1 .catalyst/config.json
mk_l1() {
  local d; d="$(mktemp -d "${TMP}/l1XXXXXX")"
  mkdir -p "${d}/.catalyst"
  printf '%s' "$1" > "${d}/.catalyst/config.json"
  printf '%s' "${d}/.catalyst/config.json"
}
# mk_l2 <config.json body> [node.json body] -> path to the Layer-2 config.json
mk_l2() {
  local d; d="$(mktemp -d "${TMP}/l2XXXXXX")"
  printf '%s' "${1:-\{\}}" > "${d}/config.json"
  [[ -n "${2:-}" ]] && printf '%s' "$2" > "${d}/node.json"
  printf '%s' "${d}/config.json"
}

SLIM_L1='{"catalyst":{"schemaVersion":1,"projectKey":"catalyst-workspace","linear":{"teamKey":"CTL"}}}'

# ───────────────────────────────────────────────────────────────────────────
echo "== orchestrate-dispatch-next: dispatchMode =="
# ⚠️ THE SHARPEST ASSERTION IN THE PHASE. With no fallback a slimmed config
# resolves dispatchMode to "oneshot-legacy" — the wrong ORCHESTRATION MODE for
# the whole fleet, arrived at silently. Assert the resolved value is
# phase-agents AND explicitly that it is not oneshot-legacy.
DN="${SCRIPTS}/orchestrate-dispatch-next"

# The resolution block is extracted and driven directly: running the real script
# would dispatch actual work. The extractor asserts it FOUND the block, so a
# refactor that moves the code fails loudly instead of silently testing nothing.
resolve_dispatch_mode() {
  local l1="$1" l2="$2"
  CATALYST_LAYER2_CONFIG_FILE="$l2" bash -c '
    set -uo pipefail
    CONFIG_PATH="$1"
    SCRIPTS="$2"
    # The extracted block sources lib/catalyst-layer2-read.sh off SCRIPT_DIR,
    # exactly as the real script does.
    SCRIPT_DIR="$2"
    eval "$3"
    printf "%s" "$DISPATCH_MODE"
  ' _ "$l1" "$SCRIPTS" "$BLOCK"
}

# Extract the resolution block from the real script, bounded by two ANCHORS: the
# opening default assignment and the comment that begins the next concern. A
# `/^fi$/` terminator would truncate at the FIRST `fi`, silently testing half the
# ladder — so the extraction is verified by CONTENT below, not just non-emptiness.
BLOCK="$(sed -n '/^DISPATCH_MODE="oneshot-legacy"$/,/^# CTL-452: when dispatchMode resolves/p' "$DN" \
         | sed '$d')"
_block_ok=1
[[ -z "$BLOCK" ]] && _block_ok=0
# Positive controls on the extraction itself: all three rungs must be present.
[[ "$BLOCK" != *"catalyst_layer2_json"* ]] && _block_ok=0
[[ "$BLOCK" != *"dispatchMode"* ]] && _block_ok=0
[[ "$BLOCK" != *"phase-agents | oneshot-legacy | execution-core"* ]] && _block_ok=0
if [[ "$_block_ok" -ne 1 ]]; then
  fail "extract dispatchMode block from orchestrate-dispatch-next" "extraction incomplete — the test would silently assert on a partial ladder"
else
  ok "extract dispatchMode block from orchestrate-dispatch-next"

  L1="$(mk_l1 "$SLIM_L1")"
  L2="$(mk_l2 '{}' '{"catalyst":{"orchestration":{"dispatchMode":"phase-agents"}}}')"
  OUT="$(resolve_dispatch_mode "$L1" "$L2")"
  expect_eq "slimmed Layer-1 + node.json -> phase-agents" "phase-agents" "$OUT"
  expect_ne "slimmed Layer-1 + node.json is NOT the silent default" "$OUT" "oneshot-legacy"

  L1="$(mk_l1 '{"catalyst":{"orchestration":{"dispatchMode":"phase-agents"}}}')"
  L2="$(mk_l2 '{}')"
  OUT="$(resolve_dispatch_mode "$L1" "$L2")"
  expect_eq "un-slimmed Layer-1 alone -> phase-agents (back-compat)" "phase-agents" "$OUT"

  L1="$(mk_l1 '{"catalyst":{"orchestration":{"dispatchMode":"phase-agents"}}}')"
  L2="$(mk_l2 '{}' '{"catalyst":{"orchestration":{"dispatchMode":"execution-core"}}}')"
  OUT="$(resolve_dispatch_mode "$L1" "$L2")"
  expect_eq "Layer-1 wins when present (fallback is a fallback, not an override)" "phase-agents" "$OUT"

  # NEGATIVE CONTROL: with neither layer defining it, the default must still be
  # oneshot-legacy. Without this, every assertion above could pass from a reader
  # that unconditionally returns phase-agents.
  L1="$(mk_l1 "$SLIM_L1")"
  L2="$(mk_l2 '{}')"
  OUT="$(resolve_dispatch_mode "$L1" "$L2")"
  expect_eq "neither layer -> oneshot-legacy default preserved" "oneshot-legacy" "$OUT"

  # An invalid value in Layer-2 must be rejected the same way Layer-1's is.
  L1="$(mk_l1 "$SLIM_L1")"
  L2="$(mk_l2 '{}' '{"catalyst":{"orchestration":{"dispatchMode":"bogus-mode"}}}')"
  OUT="$(resolve_dispatch_mode "$L1" "$L2" 2>/dev/null)"
  expect_eq "invalid Layer-2 value -> default, not the bogus string" "oneshot-legacy" "$OUT"
fi

# ───────────────────────────────────────────────────────────────────────────
echo "== orphan-sweep.sh: catalyst.sweep.* =="
# intervalHours is the one with a real operational bite: Layer-1 sets 1, the code
# default is 2, so a silent revert HALVES the sweep cadence.
# orphan-sweep.sh ships a purpose-built `--print-config` mode (the same seam
# __tests__/orphan-sweep.test.sh drives), so the resolved values are read from
# the real script rather than by re-sourcing it.
sweep_val() {
  local l1="$1" l2="$2" var="$3"
  env -u SWEEP_IDLE_HOURS -u SWEEP_INTERVAL_HOURS -u SWEEP_SALVAGE_PUSH -u SWEEP_MAX_REMOVALS \
      SWEEP_CONFIG_PATH="$l1" CATALYST_LAYER2_CONFIG_FILE="$l2" \
      bash "${SCRIPTS}/orphan-sweep.sh" --print-config 2>/dev/null \
    | sed -n "s/^${var}=//p" | head -1
}

# Harness self-check: --print-config must actually emit the variables, or every
# assertion below compares "" to "" and the suite reports a false green.
_probe="$(SWEEP_CONFIG_PATH=/nonexistent/c.json bash "${SCRIPTS}/orphan-sweep.sh" --print-config 2>/dev/null | sed -n 's/^SWEEP_INTERVAL_HOURS=//p' | head -1)"
if [[ -z "$_probe" ]]; then
  fail "harness: orphan-sweep.sh --print-config emits SWEEP_INTERVAL_HOURS" "got empty — refusing to report sweep results"
else
  ok "harness: orphan-sweep.sh --print-config emits SWEEP_INTERVAL_HOURS"

  L1="$(mk_l1 "$SLIM_L1")"
  # idleHours is deliberately 72, NOT the repo's 48 — 48 is also the CODE
  # DEFAULT, so an assertion against it passes whether or not the fallback works.
  L2="$(mk_l2 '{}' '{"catalyst":{"sweep":{"intervalHours":1,"idleHours":72,"maxRemovalsPerRun":10}}}')"
  OUT="$(sweep_val "$L1" "$L2" SWEEP_INTERVAL_HOURS)"
  expect_eq "slimmed Layer-1 + node.json -> intervalHours 1" "1" "$OUT"
  expect_ne "slimmed Layer-1 + node.json is NOT the code default 2" "$OUT" "2"

  OUT="$(sweep_val "$L1" "$L2" SWEEP_IDLE_HOURS)"
  expect_eq "slimmed Layer-1 + node.json -> idleHours 72" "72" "$OUT"
  expect_ne "slimmed Layer-1 + node.json idleHours is NOT the code default 48" "$OUT" "48"

  L1="$(mk_l1 '{"catalyst":{"sweep":{"intervalHours":1}}}')"
  L2="$(mk_l2 '{}')"
  OUT="$(sweep_val "$L1" "$L2" SWEEP_INTERVAL_HOURS)"
  expect_eq "un-slimmed Layer-1 alone -> intervalHours 1 (back-compat)" "1" "$OUT"

  L1="$(mk_l1 "$SLIM_L1")"
  L2="$(mk_l2 '{}')"
  OUT="$(sweep_val "$L1" "$L2" SWEEP_INTERVAL_HOURS)"
  expect_eq "neither layer -> the code default 2 is preserved" "2" "$OUT"

  # SWEEP_* env still wins over both layers.
  L1="$(mk_l1 "$SLIM_L1")"
  L2="$(mk_l2 '{}' '{"catalyst":{"sweep":{"intervalHours":1}}}')"
  OUT="$(SWEEP_CONFIG_PATH="$L1" CATALYST_LAYER2_CONFIG_FILE="$L2" SWEEP_INTERVAL_HOURS=3 \
         bash "${SCRIPTS}/orphan-sweep.sh" --print-config 2>/dev/null \
         | sed -n 's/^SWEEP_INTERVAL_HOURS=//p' | head -1)"
  expect_eq "SWEEP_INTERVAL_HOURS env still beats both layers" "3" "$OUT"

  # salvagePush keeps its deliberate no-//-default treatment: false is jq-falsy,
  # so a `// empty` would erase a genuine `false` and read as "unset".
  L1="$(mk_l1 "$SLIM_L1")"
  L2="$(mk_l2 '{}' '{"catalyst":{"sweep":{"salvagePush":true}}}')"
  OUT="$(sweep_val "$L1" "$L2" SWEEP_SALVAGE_PUSH)"
  expect_eq "salvagePush true from node.json -> 1" "1" "$OUT"
  L2="$(mk_l2 '{}' '{"catalyst":{"sweep":{"salvagePush":false}}}')"
  OUT="$(sweep_val "$L1" "$L2" SWEEP_SALVAGE_PUSH)"
  expect_eq "salvagePush false from node.json -> 0" "0" "$OUT"
fi

# ───────────────────────────────────────────────────────────────────────────
echo "== feedback-consent.sh / file-feedback.sh: catalyst.feedback.* =="
# ⚠️ The live ~/.config/catalyst/config.json carries catalyst.feedback as a
# STRING, so any Layer-2 read of .catalyst.feedback.autoFile must not die with
# "Cannot index string with autoFile".
FC="${SCRIPTS}/feedback-consent.sh"

L1="$(mk_l1 "$SLIM_L1")"
L2="$(mk_l2 '{}' '{"catalyst":{"feedback":{"autoFile":true}}}')"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="$L2" bash "$FC" check --config "$L1" 2>/dev/null)"
expect_eq "slimmed Layer-1 + node.json autoFile -> granted" "granted" "$OUT"
expect_ne "slimmed Layer-1 + node.json is NOT the silent 'unset'" "$OUT" "unset"

L1="$(mk_l1 '{"catalyst":{"feedback":{"autoFile":true}}}')"
L2="$(mk_l2 '{}')"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="$L2" bash "$FC" check --config "$L1" 2>/dev/null)"
expect_eq "un-slimmed Layer-1 alone -> granted (back-compat)" "granted" "$OUT"

L1="$(mk_l1 "$SLIM_L1")"
L2="$(mk_l2 '{}')"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="$L2" bash "$FC" check --config "$L1" 2>/dev/null)"
expect_eq "neither layer -> unset (default preserved)" "unset" "$OUT"

# The live string-valued catalyst.feedback must be survivable, not fatal.
L1="$(mk_l1 "$SLIM_L1")"
L2="$(mk_l2 '{"catalyst":{"feedback":"https://github.com/coalesce-labs/catalyst.git"}}')"
ERR="${TMP}/fc-err.txt"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="$L2" bash "$FC" check --config "$L1" 2>"$ERR")"
RC=$?
expect_eq "string-valued catalyst.feedback in Layer-2 -> unset, not a crash" "unset" "$OUT"
expect_eq "string-valued catalyst.feedback -> rc 0" "0" "$RC"
if /usr/bin/grep -qi "cannot index" "$ERR"; then
  fail "string-valued catalyst.feedback -> no jq index error" "$(cat "$ERR")"
else
  ok "string-valued catalyst.feedback -> no jq index error"
fi

# CTL-1214 Phase 3: `grant` must record consent in node.json and leave the
# committed Layer-1 config byte-for-byte alone — otherwise the Phase-4 slimming
# survives only until the next consent grant.
echo "== feedback-consent.sh grant: writes node.json, never Layer-1 =="
L1="$(mk_l1 "$SLIM_L1")"
L2DIR="$(mktemp -d "${TMP}/grantXXXXXX")"
printf '{}' > "${L2DIR}/config.json"
cp "$L1" "${TMP}/grant-before.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${L2DIR}/config.json" bash "$FC" grant --config "$L1" 2>/dev/null)"
expect_eq "grant reports granted" "granted" "$OUT"
if cmp -s "${TMP}/grant-before.json" "$L1"; then
  ok "grant leaves the committed Layer-1 config byte-for-byte unchanged"
else
  fail "grant leaves Layer-1 unchanged" "$(diff "${TMP}/grant-before.json" "$L1" | head -5)"
fi
expect_eq "grant writes autoFile into node.json" "true" \
  "$(jq -r '.catalyst.feedback.autoFile' "${L2DIR}/node.json" 2>/dev/null)"
expect_eq "grant writes the default githubRepo into node.json" "coalesce-labs/catalyst" \
  "$(jq -r '.catalyst.feedback.githubRepo' "${L2DIR}/node.json" 2>/dev/null)"
expect_eq "node.json is 0600" "600" \
  "$(stat -f '%Lp' "${L2DIR}/node.json" 2>/dev/null || stat -c '%a' "${L2DIR}/node.json" 2>/dev/null)"
# The granted consent must then READ back through the Layer-2 arm — a write that
# no read can see would be worse than not writing at all.
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${L2DIR}/config.json" bash "$FC" check --config "$L1" 2>/dev/null)"
expect_eq "the granted consent reads back as granted" "granted" "$OUT"

# A node.json whose catalyst.feedback is a STRING (the live Layer-2 shape) must
# be REPLACED with the object, not indexed into and crashed on.
L1="$(mk_l1 "$SLIM_L1")"
L2DIR="$(mktemp -d "${TMP}/grantstrXXXXXX")"
printf '{}' > "${L2DIR}/config.json"
printf '%s' '{"catalyst":{"feedback":"https://github.com/coalesce-labs/catalyst.git"}}' > "${L2DIR}/node.json"
OUT="$(CATALYST_LAYER2_CONFIG_FILE="${L2DIR}/config.json" bash "$FC" grant --config "$L1" 2>/dev/null)"
expect_eq "grant over a string-valued feedback still reports granted" "granted" "$OUT"
expect_eq "grant over a string-valued feedback yields the object" "true" \
  "$(jq -r '.catalyst.feedback.autoFile' "${L2DIR}/node.json" 2>/dev/null)"

echo
echo "RESULTS: $PASSES passed, $FAILURES failed"
[[ "$FAILURES" -eq 0 ]]
