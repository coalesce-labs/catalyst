#!/usr/bin/env bash
# Cross-stack parity test for catalyst-monitor.sh's resolve_liveness_anchor_issue
# vs execution-core/config.mjs's getLivenessAnchorIssue() (CTL-1612 round 6,
# Codex P2 follow-up).
#
# catalyst-monitor.sh's cmd_start gates the app-actor mint on whether a
# liveness anchor is configured, and does so with its OWN small bash mirror of
# getLivenessAnchorIssue() rather than calling the canonical getter (the
# runtime dependency + startup-cost tradeoff of shelling to `bun -e` on every
# monitor start was judged worse than a parity TEST — see the round-6 report).
# That duplication is a single-source-of-truth risk per AGENTS.md: a future
# precedence or default-path change to ONE side without the other would make
# the launcher skip the startup mint while the runtime still reads an anchor
# (stuck without a token), or mint unnecessarily when the runtime finds none.
# This test is what makes that divergence scenario test-detectable — built
# directly on __tests__/secret-contract-parity.test.sh's proven, CI-exercised
# THREE-WAY ASSERTION mechanism (shell out to node, run identical inputs
# through both implementations, diff against a computed-expected literal —
# never merely bash==node, which can agree while both disagree with the spec).
#
# SECRET HYGIENE: every cell runs under `env -i` (real environment fully
# cleared) with HOME repointed at a scratch tmpdir — this machine's real
# ~/.config/catalyst/config.json (which has real orchestrator creds AND a
# real liveness anchor configured) can never leak into a fixture or this
# test's own output.
#
# Run: bash plugins/dev/scripts/__tests__/liveness-anchor-parity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
MONITOR_SH="${REPO_ROOT}/plugins/dev/scripts/catalyst-monitor.sh"
JS_CONFIG="${REPO_ROOT}/plugins/dev/scripts/execution-core/config.mjs"

FAILURES=0
PASSES=0

ok() { PASSES=$((PASSES + 1)); }
fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES + 1))
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
   || [[ ! -f "$MONITOR_SH" ]] || [[ ! -f "$JS_CONFIG" ]]; then
  echo "  SKIP: liveness-anchor-parity (node/jq unavailable or files missing: $MONITOR_SH / $JS_CONFIG)"
  echo ""
  echo "Total: 0, Passed: 0, Failed: 0, Skipped: 1"
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SANDBOX_HOME="${TMP_DIR}/home"
mkdir -p "$SANDBOX_HOME"

# Extract resolve_liveness_anchor_issue's SOURCE into an isolated probe file —
# NOT `source "$MONITOR_SH"` directly, which would run the whole CLI's
# top-level argument dispatch. Uses the exact function-boundary markers
# (`resolve_liveness_anchor_issue() {` ... closing `}`) so a future edit to
# the function's body is picked up automatically; a future RENAME or removal
# fails this extraction loudly instead of silently testing stale bash.
BASH_FN_PROBE="${TMP_DIR}/resolve-liveness-anchor-issue.sh"
awk '/^resolve_liveness_anchor_issue\(\) \{/{flag=1} flag{print} flag && /^}/{exit}' "$MONITOR_SH" > "$BASH_FN_PROBE"
if [[ ! -s "$BASH_FN_PROBE" ]]; then
  echo "FATAL: could not extract resolve_liveness_anchor_issue() from $MONITOR_SH — has it been renamed?" >&2
  exit 1
fi

# JS probe — calls the CANONICAL getter directly.
PROBE_JS="${TMP_DIR}/probe-anchor.mjs"
cat > "$PROBE_JS" <<EOF
import { getLivenessAnchorIssue } from "${JS_CONFIG}";
process.stdout.write(getLivenessAnchorIssue() ?? "");
EOF

# _cell NAME EXPECTED [ENV_VAR=VAL ...] — runs BOTH implementations under
# identical env -i fixtures and asserts bash==expected AND node==expected.
_cell() {
  local _name="$1" _expected="$2"
  shift 2
  local BASH_OUT NODE_OUT
  BASH_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" bash -c "
    source '$BASH_FN_PROBE'
    resolve_liveness_anchor_issue
  ")"
  NODE_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" node "$PROBE_JS" 2>&1)"
  expect_eq "$_name (bash==expected)" "$_expected" "$BASH_OUT"
  expect_eq "$_name (node==expected)" "$_expected" "$NODE_OUT"
}

L2_DIR="${TMP_DIR}/l2cfg"
mkdir -p "$L2_DIR"
L2_FILE="${L2_DIR}/config.json"

# CTL-1612 round 7 (Codex P2 follow-up): a minimal jq-less PATH — grep/head/sed
# (the grep-fallback rung's own dependencies) plus bash itself (env -i's `bash`
# argument is looked up via the NEW restricted PATH being set, not the caller's
# — verified empirically), resolved dynamically here via a PLAIN non-interactive
# `command -v` (portable across the macOS/Linux paths a CI runner may use;
# hardcoding /usr/bin/grep etc. would NOT be portable). jq is deliberately
# absent from this directory and nowhere else is added to PATH, so
# `command -v jq` genuinely fails inside it — proves the grep-fallback rung
# itself, not just that jq happens to still be reachable.
NOJQ_BIN="${TMP_DIR}/nojq-bin"
mkdir -p "$NOJQ_BIN"
for _nojq_tool in grep head sed bash; do
  _nojq_real="$(command -v "$_nojq_tool" 2>/dev/null || true)"
  if [[ -n "$_nojq_real" ]]; then
    ln -sf "$_nojq_real" "${NOJQ_BIN}/${_nojq_tool}"
  else
    echo "FATAL: liveness-anchor-parity jq-less fixture — '$_nojq_tool' not found on PATH" >&2
    exit 1
  fi
done

# _cell_nojq NAME EXPECTED [ENV_VAR=VAL ...] — like _cell, but the BASH side
# runs under NOJQ_BIN (jq unreachable, forcing the grep-fallback rung); the
# NODE side runs under the NORMAL PATH (JSON.parse never needed jq at all, so
# there is nothing to restrict there — this cell is specifically proving the
# BASH fallback agrees with the UNCHANGED canonical getter, not testing node).
_cell_nojq() {
  local _name="$1" _expected="$2"
  shift 2
  local BASH_OUT NODE_OUT
  BASH_OUT="$(env -i PATH="$NOJQ_BIN" HOME="$SANDBOX_HOME" "$@" bash -c "
    command -v jq >/dev/null 2>&1 && echo 'FATAL: jq unexpectedly reachable in the jq-less fixture' >&2 && exit 1
    source '$BASH_FN_PROBE'
    resolve_liveness_anchor_issue
  ")"
  NODE_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" node "$PROBE_JS" 2>&1)"
  expect_eq "$_name (bash-without-jq==expected)" "$_expected" "$BASH_OUT"
  expect_eq "$_name (node==expected)" "$_expected" "$NODE_OUT"
}

# ─── env wins over Layer-2 ────────────────────────────────────────────────
printf '%s' '{"catalyst":{"cluster":{"livenessAnchorIssue":"CTL-FROM-L2"}}}' > "$L2_FILE"
_cell "env wins over Layer-2 when both are set" "CTL-FROM-ENV" \
  "CATALYST_LIVENESS_ANCHOR_ISSUE=CTL-FROM-ENV" "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── env empty-string falls through to Layer-2 ────────────────────────────
_cell "empty-string env falls through to Layer-2" "CTL-FROM-L2" \
  "CATALYST_LIVENESS_ANCHOR_ISSUE=" "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── Layer-2 only (env unset) ──────────────────────────────────────────────
_cell "Layer-2 catalyst.cluster.livenessAnchorIssue resolves when env is unset" "CTL-FROM-L2" \
  "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── neither set ────────────────────────────────────────────────────────────
printf '%s' '{}' > "$L2_FILE"
_cell "Layer-2 present but missing the field, env unset ⇒ empty" "" \
  "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── Layer-2 file absent ───────────────────────────────────────────────────
_cell "Layer-2 file absent, env unset ⇒ empty (never throws)" "" \
  "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/does-not-exist-config.json"

# ─── Layer-2 file malformed JSON ───────────────────────────────────────────
printf 'not valid json{{{' > "$L2_FILE"
_cell "Layer-2 file malformed JSON, env unset ⇒ empty (never throws)" "" \
  "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── Layer-2 field is a non-string (hostile) ───────────────────────────────
printf '%s' '{"catalyst":{"cluster":{"livenessAnchorIssue":12345}}}' > "$L2_FILE"
_cell "Layer-2 field is a non-string (number) ⇒ empty on both sides, never coerced" "" \
  "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── Layer-2 field is an empty string ──────────────────────────────────────
printf '%s' '{"catalyst":{"cluster":{"livenessAnchorIssue":""}}}' > "$L2_FILE"
_cell "Layer-2 field is an empty string ⇒ empty on both sides, never a resolved empty anchor" "" \
  "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── default path (no CATALYST_LAYER2_CONFIG_FILE at all) ─────────────────
# getLayer2ConfigPath's "legacy path" (the one getLivenessAnchorIssue actually
# reads) falls back to ~/.config/catalyst/config.json when the env var is
# unset — exercise that default resolution identically on both sides via a
# repointed HOME, never touching this machine's real config.
mkdir -p "${SANDBOX_HOME}/.config/catalyst"
printf '%s' '{"catalyst":{"cluster":{"livenessAnchorIssue":"CTL-FROM-HOME-DEFAULT"}}}' \
  > "${SANDBOX_HOME}/.config/catalyst/config.json"
_cell "default path (no CATALYST_LAYER2_CONFIG_FILE) resolves via \$HOME/.config/catalyst/config.json on both sides" \
  "CTL-FROM-HOME-DEFAULT"

# ─── jq-less host (CTL-1612 round 7): the grep-fallback rung ──────────────
printf '%s' '{"catalyst":{"cluster":{"livenessAnchorIssue":"CTL-FROM-L2-NOJQ"}}}' > "$L2_FILE"
_cell_nojq "jq-less: Layer-2 catalyst.cluster.livenessAnchorIssue resolves via the grep fallback" \
  "CTL-FROM-L2-NOJQ" "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{}' > "$L2_FILE"
_cell_nojq "jq-less: Layer-2 present but missing the field ⇒ empty" "" \
  "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

_cell_nojq "jq-less: Layer-2 file absent ⇒ empty (never throws)" "" \
  "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/does-not-exist-config-nojq.json"

printf '%s' '{"catalyst":{"cluster":{"livenessAnchorIssue":12345}}}' > "$L2_FILE"
_cell_nojq "jq-less: Layer-2 field is a non-string (number) ⇒ empty (the grep fallback's quoted-value requirement rejects it, matching the jq select(type==\"string\") branch)" \
  "" "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{"catalyst":{"cluster":{"livenessAnchorIssue":"CTL-FROM-L2-NOJQ"}}}' > "$L2_FILE"
_cell_nojq "jq-less: env still wins over Layer-2 (the fallback rung is never even reached)" \
  "CTL-FROM-ENV-NOJQ" \
  "CATALYST_LIVENESS_ANCHOR_ISSUE=CTL-FROM-ENV-NOJQ" "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

echo ""
echo "────────────────────────────────────────"
echo "Total: $((PASSES + FAILURES)), Passed: ${PASSES}, Failed: ${FAILURES}, Skipped: 0"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
