#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
LIB="$ROOT/plugins/dev/scripts/lib/escalate-common.sh"
P=0 F=0
pass() { P=$((P+1)); echo "  PASS: $1"; }
fail() { F=$((F+1)); echo "  FAIL: $1"; }
eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 — expected '$2', got '$1'"; }
has() { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 — missing '$2'"; }
command -v node >/dev/null && command -v jq >/dev/null || { echo "SKIP: node/jq unavailable"; exit 0; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/root/scripts/execution-core"
PLUGIN_ROOT="$TMP/root"; source "$LIB"

printf 'process.stderr.write("boom-from-stderr\\n"); process.exit(3);\n' > "$PLUGIN_ROOT/scripts/execution-core/escalation-explain.mjs"
OUT="$(escalation_explain_json test --type manual 2>"$TMP/err")"
eq "$OUT" '{}' "crash falls back to JSON"
has "$(cat "$TMP/err")" "exited 3" "crash exit is visible"
has "$(cat "$TMP/err")" "boom-from-stderr" "captured stderr is visible"

printf 'process.stdout.write("");\n' > "$PLUGIN_ROOT/scripts/execution-core/escalation-explain.mjs"
OUT="$(escalation_explain_json test 2>"$TMP/err")"
eq "$OUT" '{}' "empty stdout falls back"
has "$(cat "$TMP/err")" "EMPTY stdout" "empty stdout is visible"

printf 'process.stdout.write("garbage");\n' > "$PLUGIN_ROOT/scripts/execution-core/escalation-explain.mjs"
OUT="$(escalation_explain_json test 2>"$TMP/err")"
eq "$OUT" '{}' "invalid JSON falls back"
has "$(cat "$TMP/err")" "not valid JSON" "invalid JSON is visible"

printf 'process.stdout.write(JSON.stringify({escalation_type:"manual"}));\n' > "$PLUGIN_ROOT/scripts/execution-core/escalation-explain.mjs"
OUT="$(escalation_explain_json test 2>"$TMP/err")"
eq "$(jq -r .escalation_type <<<"$OUT")" manual "valid JSON passes through"
eq "$(cat "$TMP/err")" '' "success is silent"

SIG="$TMP/signal.json"; printf '{"status":"running"}\n' > "$SIG"
escalation_write_signal_explanation test "$SIG" failed reason '' 2>"$TMP/err" || true
eq "$(jq -r .status "$SIG")" failed "empty explanation still writes terminal state"
has "$(cat "$TMP/err")" "substituting {}" "empty explanation is visible"
eq "$(find "$TMP" -name '*.tmp.*' | wc -l | tr -d ' ')" 0 "no temporary files remain"

ERR="$(escalation_emit_terminal test monitor-merge CAT-999 reason 2>&1)"; RC=$?
eq "$RC" 0 "missing emitter is fail-open"
has "$ERR" "NOT executable" "missing emitter is visible"
has "$ERR" "no-progress" "missing emitter names consequence"

( set -euo pipefail; source "$LIB"; escalation_explain_json test >/dev/null 2>&1 )
eq "$?" 0 "failure paths are set -e safe"
if command -v shellcheck >/dev/null; then shellcheck -e SC2317 "$ROOT/plugins/dev/scripts/lib/escalate-common.sh" && pass "shellcheck" || fail "shellcheck"; fi
echo "passed=$P failed=$F"
[[ "$F" -eq 0 ]]
