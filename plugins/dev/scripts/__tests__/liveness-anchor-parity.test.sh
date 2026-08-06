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

# CTL-1612 round 8 (Codex P2 follow-up): the marker MUST start at column 0 —
# run-tests.sh's aggregate runner recognizes a skipped shell suite via
# `grep -q '^SKIP:' <<<"$out"` (anchored). A leading-space "  SKIP:" (this
# suite's own round-6 copy of secret-contract-parity.test.sh/
# deployment-mode-parity.test.sh's existing pattern — neither is wired into
# run-tests.sh's SHELL_TEST_DIR discovery today, so neither has hit this yet)
# never matches that anchor, so the runner would count a skipped run as an
# unconditional PASS (exit 0, no recognized skip line) — silently reporting
# coverage that never ran on a node/jq-light checkout.
if ! command -v node >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 \
   || [[ ! -f "$MONITOR_SH" ]] || [[ ! -f "$JS_CONFIG" ]]; then
  echo "SKIP: liveness-anchor-parity (node/jq unavailable or files missing: $MONITOR_SH / $JS_CONFIG)"
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

# _run_node_probe [ENV_VAR=VAL ...] — CTL-1612 round 8 (Codex P2 follow-up).
# Runs the JS probe with stdout and stderr captured SEPARATELY, printing
# whatever landed on stderr as a diagnostic (never folded into the compared
# value) whenever it's non-empty. execution-core/config.mjs's console-shim
# warning ("pino unavailable ...", printed on import when pino isn't
# installed — a real, supported, dependency-light checkout state) writes to
# stderr; a bare `2>&1` on the node invocation used to prepend that warning
# onto NODE_OUT, so every string-equality assertion failed even though
# getLivenessAnchorIssue() itself returned the correct value. Sets the
# caller's NODE_OUT var (by design a plain global here — bash has no clean
# multi-value return, and every caller is this file's own top-level cells).
#
# CTL-1612 round 15 (Codex P2 follow-up): also captures the probe's exit
# status into the caller's NODE_RC global. Command substitution only
# captures stdout — a probe that crashes BEFORE writing output (getter
# throws, import fails) produced an empty NODE_OUT with the shell's `$?`
# from the substitution silently discarded, so an expected-empty fixture
# (malformed/missing/non-string/empty-field cases) passed vacuously even
# though the canonical getter never actually ran to completion. Callers must
# check NODE_RC before trusting NODE_OUT as a legitimate "resolved empty".
_run_node_probe() {
  local _err_file
  _err_file="$(mktemp)"
  NODE_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" node "$PROBE_JS" 2>"$_err_file")"
  NODE_RC=$?
  if [[ -s "$_err_file" ]]; then
    echo "    node stderr (diagnostic only — NOT part of the compared value): $(cat "$_err_file")"
  fi
  rm -f "$_err_file"
}

# _expect_node_eq NAME EXPECTED — CTL-1612 round 15 (Codex P2 follow-up):
# shared by _cell and _cell_nojq so the NODE_RC check lives in exactly one
# place. A nonzero NODE_RC fails the cell outright (crash ≠ legitimately
# empty) regardless of what NODE_OUT happens to contain; only a clean exit
# is compared against the expected value.
_expect_node_eq() {
  local _name="$1" _expected="$2"
  if [[ "$NODE_RC" -ne 0 ]]; then
    fail "$_name (node==expected)" "node probe exited $NODE_RC (crash) instead of 0 — NODE_OUT='$NODE_OUT' cannot be trusted as a legitimate empty result"
  else
    expect_eq "$_name (node==expected)" "$_expected" "$NODE_OUT"
  fi
}

# _expect_bash_eq NAME EXPECTED — CTL-1612 post-merge #2978 (Codex P2
# follow-up): the bash-side counterpart to _expect_node_eq above. CONTRACT
# CHECK FIRST (per the finding's own caution — a resolver whose fail-open
# path legitimately returns nonzero-with-empty would need per-fixture
# exit-status PARITY, not a blanket fail): resolve_liveness_anchor_issue()
# was audited and now explicitly `return 0`s on EVERY resolution path
# (env-set, Layer-2-absent, jq-parsed, and — this round's production fix in
# catalyst-monitor.sh — the jq-parse-failure and grep-fallback-no-match
# paths, both of which used to leak a raw nonzero exit code: jq's own
# invalid-JSON status on malformed input, and — because catalyst-monitor.sh
# runs under `set -o pipefail` — grep's own no-match status through the
# grep|head|sed pipeline on an ordinary "field not found" case). Node's
# getLivenessAnchorIssue() has ALWAYS exited 0 unconditionally (try/catch
# around JSON.parse, see execution-core/config.mjs). So post-fix, "exit
# status parity with the node side" collapses to the same blanket
# always-0-on-legitimate-resolution check as _expect_node_eq — not because
# blanket-fail was assumed correct, but because that IS what auditing the
# contract concluded it should be.
_expect_bash_eq() {
  local _name="$1" _expected="$2" _label="${3:-bash==expected}"
  if [[ "$BASH_RC" -ne 0 ]]; then
    fail "$_name ($_label)" "bash probe exited $BASH_RC (crash) instead of 0 — BASH_OUT='$BASH_OUT' cannot be trusted as a legitimate empty result"
  else
    expect_eq "$_name ($_label)" "$_expected" "$BASH_OUT"
  fi
}

# _cell NAME EXPECTED [ENV_VAR=VAL ...] — runs BOTH implementations under
# identical env -i fixtures and asserts bash==expected AND node==expected.
_cell() {
  local _name="$1" _expected="$2"
  shift 2
  local BASH_OUT BASH_RC
  BASH_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" bash -c "
    source '$BASH_FN_PROBE'
    resolve_liveness_anchor_issue
  ")"
  BASH_RC=$?
  _run_node_probe "$@"
  _expect_bash_eq "$_name" "$_expected"
  _expect_node_eq "$_name" "$_expected"
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
  local BASH_OUT BASH_RC
  BASH_OUT="$(env -i PATH="$NOJQ_BIN" HOME="$SANDBOX_HOME" "$@" bash -c "
    command -v jq >/dev/null 2>&1 && echo 'FATAL: jq unexpectedly reachable in the jq-less fixture' >&2 && exit 1
    source '$BASH_FN_PROBE'
    resolve_liveness_anchor_issue
  ")"
  BASH_RC=$?
  _run_node_probe "$@"
  _expect_bash_eq "$_name" "$_expected" "bash-without-jq==expected"
  _expect_node_eq "$_name" "$_expected"
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


# ── Crash-detection self-test (CTL-1612 round 15, Codex P2 follow-up) ──────
# Proves _expect_node_eq actually fails a cell when the node probe crashes,
# rather than silently passing the way the pre-fix version did — Codex
# reproduced a fixture-specific throwing getter still yielding
# "28 passed, 0 failed" and exit 0, because an expected-empty fixture's ""
# happened to match the crash's coincidentally-empty NODE_OUT with the
# nonzero exit status discarded. Points PROBE_JS at a script that throws
# BEFORE writing any stdout (exactly the "exits nonzero before writing
# output" scenario the finding describes) and asserts the resulting FAIL is
# actually recorded. Runs in a saved/restored counter scope so this
# self-test's INTENTIONAL failure doesn't leak into (or get masked by) the
# suite's own pass/fail totals below — the self-test's own outcome is what
# gets folded back in.
echo ""
echo "Crash-detection self-test: a throwing node probe must FAIL the cell, not pass vacuously"
CRASH_PROBE_JS="${TMP_DIR}/probe-anchor-crash.mjs"
cat > "$CRASH_PROBE_JS" <<'EOF'
throw new Error("simulated getLivenessAnchorIssue crash — probe never reaches stdout.write");
EOF
_SAVED_FAILURES=$FAILURES
_SAVED_PASSES=$PASSES
_REAL_PROBE_JS="$PROBE_JS"
PROBE_JS="$CRASH_PROBE_JS"
_run_node_probe
_expect_node_eq "crash-detection self-test" ""
PROBE_JS="$_REAL_PROBE_JS"
if [[ "$FAILURES" -eq $((_SAVED_FAILURES + 1)) && "$PASSES" -eq $_SAVED_PASSES ]]; then
  FAILURES=$_SAVED_FAILURES
  PASSES=$((_SAVED_PASSES + 1))
  echo "  PASS: crash-detection self-test (throwing probe correctly counted as a FAIL, not a vacuous pass)"
else
  FAILURES=$((_SAVED_FAILURES + 1))
  echo "  FAIL: crash-detection self-test — expected exactly 1 new failure and 0 new passes from the throwing probe, got +$((FAILURES - _SAVED_FAILURES)) failures / +$((PASSES - _SAVED_PASSES)) passes"
fi

# ── Bash-side crash-detection self-test (CTL-1612 post-merge #2978, Codex P2
# follow-up) ─────────────────────────────────────────────────────────────
# The bash-side counterpart to the node self-test above — proves
# _expect_bash_eq actually fails a cell when the BASH probe exits nonzero,
# not the vacuous pass Codex reported ("the committed malformed-JSON fixture
# already exercises that shape — the resolver returns an empty value with a
# nonzero jq status while the suite reports the 'never throws' case as
# passing"). Uses a throwaway function body (nonzero exit, empty output) in
# place of the real resolve_liveness_anchor_issue() to simulate that exact
# shape directly, without depending on jq/malformed-JSON machinery for the
# self-test itself. Same saved/restored counter scope as the node self-test,
# for the same reason (the intentional failure this triggers must not leak
# into the suite's real totals).
echo ""
echo "Bash-side crash-detection self-test: a nonzero-exiting bash probe must FAIL the cell, not pass vacuously"
CRASH_FN_PROBE="${TMP_DIR}/crash-resolve-liveness-anchor-issue.sh"
cat >"$CRASH_FN_PROBE" <<'EOF'
resolve_liveness_anchor_issue() {
  return 7
}
EOF
_SAVED_FAILURES=$FAILURES
_SAVED_PASSES=$PASSES
BASH_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" bash -c "
  source '$CRASH_FN_PROBE'
  resolve_liveness_anchor_issue
")"
BASH_RC=$?
_expect_bash_eq "bash-side crash-detection self-test" ""
if [[ "$FAILURES" -eq $((_SAVED_FAILURES + 1)) && "$PASSES" -eq $_SAVED_PASSES ]]; then
  FAILURES=$_SAVED_FAILURES
  PASSES=$((_SAVED_PASSES + 1))
  echo "  PASS: bash-side crash-detection self-test (nonzero-exiting probe correctly counted as a FAIL, not a vacuous pass)"
else
  FAILURES=$((_SAVED_FAILURES + 1))
  echo "  FAIL: bash-side crash-detection self-test — expected exactly 1 new failure and 0 new passes from the nonzero-exiting probe, got +$((FAILURES - _SAVED_FAILURES)) failures / +$((PASSES - _SAVED_PASSES)) passes"
fi

echo ""
echo "────────────────────────────────────────"
echo "Total: $((PASSES + FAILURES)), Passed: ${PASSES}, Failed: ${FAILURES}, Skipped: 0"
[[ $FAILURES -eq 0 ]] && exit 0 || exit 1
