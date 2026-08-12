#!/usr/bin/env bash
# catalyst-config CLI contract (CTL-1793).
# Run: bash plugins/dev/scripts/__tests__/catalyst-config.test.sh
#
# Covers the CLI shell only (the resolution logic is unit-tested in
# execution-core/config-dump.test.mjs):
#   • the standard --help/-h/bare/unknown contract (cli-help-usage.test.sh shape);
#   • `dump --json` emits PARSEABLE JSON on stdout with nothing else mixed in
#     (a stray log line on stdout would break the cross-host `diff` that is the
#     whole point of the tool);
#   • the router reaches it as `catalyst config` via auto-delegation;
#   • no secret VALUE from a scratch env-file/Layer-2 reaches the output.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${SCRIPT_DIR}/.." && pwd)" # plugins/dev/scripts
TOOL="${SCRIPTS}/catalyst-config"

FAILURES=0
PASSES=0
ok() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	echo "    $2"
}
expect_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }
expect_ne() { if [[ "$2" != "$3" ]]; then ok "$1"; else fail "$1" "expected != '$3'"; fi; }
expect_contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else fail "$1" "output lacks '$3'"; fi; }
expect_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else fail "$1" "output LEAKED '$3'"; fi; }

echo "catalyst-config: help/usage contract"
out="$("$TOOL" --help 2>/dev/null)"
rc=$?
expect_eq "--help exits 0" "0" "$rc"
expect_contains "--help names the tool" "$out" "catalyst-config"
expect_contains "--help has a Usage block" "$out" "Usage:"

out="$("$TOOL" -h 2>/dev/null)"
rc=$?
expect_eq "-h alias exits 0" "0" "$rc"

out="$("$TOOL" 2>&1 >/dev/null)"
rc=$?
expect_ne "bare exits non-zero" "0" "$rc"
expect_contains "bare prints usage to stderr" "$out" "Usage:"

out="$("$TOOL" no-such-cmd 2>&1 >/dev/null)"
rc=$?
expect_ne "unknown subcommand exits non-zero" "0" "$rc"
expect_contains "unknown subcommand prints usage" "$out" "Usage:"

# `--help` must do no work: running it in an empty cwd must not create .catalyst/
TMP_HELP="$(mktemp -d)"
(cd "$TMP_HELP" && "$TOOL" --help >/dev/null 2>&1)
if [[ -e "$TMP_HELP/.catalyst" ]]; then fail "--help does no work" ".catalyst created"; else ok "--help does no work"; fi
rm -rf "$TMP_HELP"

echo "catalyst-config: dump over a scratch HOME"
JS_RUN="$(command -v bun || command -v node || true)"
if [[ -z "$JS_RUN" ]]; then
	echo "  SKIP: no bun/node runtime — dump cases not exercised"
else
	TMP="$(mktemp -d)"
	mkdir -p "$TMP/home/.config/catalyst" "$TMP/repo/.catalyst"
	cat >"$TMP/repo/.catalyst/config.json" <<'JSON'
{ "catalyst": { "orchestration": { "dispatchMode": "phase-agents", "executionCore": { "maxParallel": 4 } } } }
JSON
	cat >"$TMP/home/.config/catalyst/config.json" <<'JSON'
{ "catalyst": { "node": { "class": "worker" }, "host": { "name": "scratch-host" },
  "unstuckSweep": { "mode": "enforce" } } }
JSON
	# The env file carries BOTH a governance override and a credential — the
	# override must surface, the credential value must never appear.
	cat >"$TMP/home/.config/catalyst/execution-core.env" <<'ENVF'
export CATALYST_STALL_JANITOR=enforce
export LINEAR_API_TOKEN=lin_api_MUST_NOT_LEAK
ENVF

	run_dump() { # <extra args...> — isolated env, scratch HOME, pinned Layer-1
		env -i PATH="$PATH" HOME="$TMP/home" \
			CATALYST_CONFIG_FILE="$TMP/repo/.catalyst/config.json" \
			CATALYST_LAYER2_CONFIG_FILE="$TMP/home/.config/catalyst/config.json" \
			CATALYST_EXECUTION_CORE_ENV="$TMP/home/.config/catalyst/execution-core.env" \
			"$TOOL" dump "$@"
	}

	json="$(run_dump --json 2>/dev/null)"
	rc=$?
	expect_eq "dump --json exits 0" "0" "$rc"

	# Stdout must be PURE JSON — a stray log line breaks cross-host diffing.
	if printf '%s' "$json" | "$JS_RUN" -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        try { const o=JSON.parse(s); process.exit(o && Array.isArray(o.rows) && o.rows.length>0 ? 0 : 1); }
        catch { process.exit(1); }
      });' 2>/dev/null; then
		ok "dump --json emits parseable JSON with rows on stdout"
	else
		fail "dump --json emits parseable JSON with rows on stdout" "stdout was not pure JSON"
	fi

	expect_contains "layer-1 knob is reported from layer1" "$json" '"catalyst.orchestration.dispatchMode"'
	expect_contains "layer-2 knob is reported" "$json" '"scratch-host"'
	expect_contains "a fingerprint is emitted" "$json" '"fingerprint"'

	human="$(run_dump 2>/dev/null)"

	# The env-file-only override must reach the ROW, not merely the key listing.
	# Asserting on the key name alone would pass even with the overlay disabled,
	# because the env-file key set is printed independently of resolution.
	sj_row="$(printf '%s\n' "$human" | grep -E '^[[:space:]]+catalyst\.stallJanitor\.mode[[:space:]]')"
	expect_contains "env-file-only override reaches the row VALUE" "$sj_row" "enforce"
	expect_contains "env-file-only override is labelled env-override" "$sj_row" "env-override (CATALYST_STALL_JANITOR)"
	# ...and a Layer-2 mode with no env override is labelled config (layer2).
	us_row="$(printf '%s\n' "$human" | grep -E '^[[:space:]]+catalyst\.unstuckSweep\.mode[[:space:]]')"
	expect_contains "layer-2 mode value is resolved" "$us_row" "enforce"
	expect_contains "layer-2 mode is labelled config (layer2)" "$us_row" "config (layer2)"

	# Secrets: presence only, value never.
	expect_not_contains "dump --json never leaks a credential VALUE" "$json" "lin_api_MUST_NOT_LEAK"
	expect_not_contains "human dump never leaks a credential VALUE" "$human" "lin_api_MUST_NOT_LEAK"
	expect_contains "human dump reports the credential as present" "$human" "secrets.LINEAR_API_TOKEN"

	# Determinism: two runs over the same inputs fingerprint identically.
	fp1="$(run_dump --json 2>/dev/null | grep -o '"fingerprint": "[a-f0-9]*"' | head -1)"
	fp2="$(run_dump --json 2>/dev/null | grep -o '"fingerprint": "[a-f0-9]*"' | head -1)"
	expect_eq "fingerprint is deterministic across runs" "$fp1" "$fp2"

	# A CHANGED knob must change the fingerprint (this is what makes a host diff meaningful).
	fp3="$(env -i PATH="$PATH" HOME="$TMP/home" \
		CATALYST_CONFIG_FILE="$TMP/repo/.catalyst/config.json" \
		CATALYST_LAYER2_CONFIG_FILE="$TMP/home/.config/catalyst/config.json" \
		CATALYST_EXECUTION_CORE_ENV="$TMP/home/.config/catalyst/execution-core.env" \
		CATALYST_BOARD_HEALTH=enforce \
		"$TOOL" dump --json 2>/dev/null | grep -o '"fingerprint": "[a-f0-9]*"' | head -1)"
	expect_ne "fingerprint changes when a knob changes" "$fp1" "$fp3"

	rm -rf "$TMP"
fi

echo "catalyst-config: router auto-delegation"
# `catalyst config ...` must reach catalyst-config with ZERO router changes.
routed="$(bash -c 'source "$1"; run_tool(){ echo "WOULD-EXEC: $*"; }; dispatch config dump --json' _ "${SCRIPTS}/catalyst" 2>&1)"
expect_contains "'catalyst config' delegates to catalyst-config" "$routed" "WOULD-EXEC:"
expect_contains "'catalyst config' resolves the right tool" "$routed" "catalyst-config"

echo
echo "RESULTS: $PASSES passed, $FAILURES failed"
[[ "$FAILURES" -eq 0 ]]
