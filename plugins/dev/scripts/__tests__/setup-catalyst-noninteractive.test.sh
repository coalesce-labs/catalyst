#!/usr/bin/env bash
# Tests for setup-catalyst.sh headless operation (CTL-842).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/setup-catalyst.sh"
FAILURES=0; PASSES=0
pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1${2:+ ($2)}"; }

echo "=== Phase 1: Source guard + tty probe ==="

# T1: sourcing the script must NOT run main (no banner, exit 0)
out=$(cd "$REPO_ROOT" && bash -c 'source ./setup-catalyst.sh' </dev/null 2>&1)
rc=$?
if [[ $rc -eq 0 && "$out" != *"Catalyst Complete Setup"* ]]; then
  pass "sourcing does not execute main"
else
  fail "sourcing does not execute main" "rc=$rc"
fi

# T2: can_open_tty helper exists and uses the subshell-probe pattern
grep -qE 'can_open_tty\(\)' "$SETUP" \
  && grep -qF '(: </dev/tty)' "$SETUP" \
  && pass "can_open_tty subshell probe present" \
  || fail "can_open_tty subshell probe present"

# T3: main no longer gates the exec on existence-only [ -e /dev/tty ]
grep -qF '[ -e /dev/tty ]' "$SETUP" \
  && fail "existence-only /dev/tty check removed" \
  || pass "existence-only /dev/tty check removed"

# T4: executed (not sourced) entry still calls main — curl|bash safe idiom
grep -qF 'return 0 2>/dev/null' "$SETUP" \
  && pass "sourced-vs-executed guard uses return-probe idiom" \
  || fail "sourced-vs-executed guard uses return-probe idiom"

echo ""
echo "=== Phase 2: ask_yes_no piped-input desync ==="

# Helper: run a snippet in a bash that sources the script first.
run_sourced() { bash -c "source '$SETUP'; $1" 2>/dev/null; }

# T5: three piped answers hit three consecutive prompts in order (y, n, y)
out=$(printf 'y\nn\ny\n' | run_sourced '
  ask_yes_no "q1?" y && echo A1=yes || echo A1=no
  ask_yes_no "q2?" y && echo A2=yes || echo A2=no
  ask_yes_no "q3?" y && echo A3=yes || echo A3=no' 2>/dev/null | grep "^A")
if [[ "$out" == $'A1=yes\nA2=no\nA3=yes' ]]; then
  pass "piped answers stay aligned"
else
  fail "piped answers stay aligned" "$out"
fi

# T6: empty line means default (default=n)
printf '\n' | run_sourced 'ask_yes_no "q?" n' 2>/dev/null \
  && fail "empty line respects default n" || pass "empty line respects default n"

# T7: EOF (no input at all) falls back to the default instead of failing
run_sourced 'ask_yes_no "q?" y' </dev/null 2>/dev/null \
  && pass "EOF falls back to default y" || fail "EOF falls back to default y"
run_sourced 'ask_yes_no "q?" n' </dev/null 2>/dev/null \
  && fail "EOF falls back to default n" || pass "EOF falls back to default n"

echo ""
echo "=== Phase 3: Non-interactive mode ==="

# T8: parse_args sets NON_INTERACTIVE for --non-interactive and --defaults
for flag in --non-interactive --defaults; do
  out=$(run_sourced "parse_args $flag; echo NI=\$NON_INTERACTIVE" 2>/dev/null)
  [[ "$out" == *"NI=1"* ]] && pass "parse_args $flag" || fail "parse_args $flag" "$out"
done

# T9: CATALYST_AUTONOMOUS=1 implies non-interactive
out=$(CATALYST_AUTONOMOUS=1 run_sourced 'parse_args; echo NI=$NON_INTERACTIVE' 2>/dev/null)
[[ "$out" == *"NI=1"* ]] && pass "CATALYST_AUTONOMOUS implies NI" || fail "CATALYST_AUTONOMOUS implies NI" "$out"

# T10: unknown flag fails loudly
run_sourced 'parse_args --bogus' </dev/null >/dev/null 2>&1 \
  && fail "unknown flag rejected" || pass "unknown flag rejected"

# T11: in NI mode ask_yes_no consumes NOTHING from stdin and returns default
out=$(printf 'n\n' | run_sourced '
  NON_INTERACTIVE=1
  ask_yes_no "q1?" y && echo A1=yes || echo A1=no
  read -r leftover; echo "LEFT=$leftover"' 2>/dev/null | grep -E "^(A|LEFT)")
[[ "$out" == $'A1=yes\nLEFT=n' ]] && pass "NI reads nothing from stdin" || fail "NI reads nothing from stdin" "$out"

# T12: ask_yes_no third arg overrides the NI answer (install offers decline)
printf '' | run_sourced 'NON_INTERACTIVE=1; ask_yes_no "install?" y n' 2>/dev/null \
  && fail "NI override answer n" || pass "NI override answer n"

# T13: prompt_value returns default in NI mode without reading stdin
out=$(printf 'TYPED\n' | run_sourced '
  NON_INTERACTIVE=1
  v=$(prompt_value "Enter ticket prefix" "PROJ"); echo "V=$v"
  read -r leftover; echo "LEFT=$leftover"' 2>/dev/null | grep -E "^(V|LEFT)")
[[ "$out" == $'V=PROJ\nLEFT=TYPED' ]] && pass "prompt_value NI default" || fail "prompt_value NI default" "$out"

# T14: prompt_value EOF → default (interactive path, exhausted pipe)
out=$(run_sourced 'v=$(prompt_value "Name" "dflt"); echo "V=$v"' </dev/null 2>/dev/null)
[[ "$out" == *"V=dflt"* ]] && pass "prompt_value EOF default" || fail "prompt_value EOF default" "$out"

# T15: integration gates — NI skips Linear when no token is discoverable
scratch_home=$(mktemp -d)
out=$(env -u LINEAR_API_TOKEN HOME="$scratch_home" bash -c "source '$SETUP'
  NON_INTERACTIVE=1
  prompt_linear_config '{}' >/dev/null" 2>&1 </dev/null)
rm -rf "$scratch_home"
[[ "$out" == *"Skipping Linear"* ]] && pass "NI skips Linear without token" || fail "NI skips Linear without token" "$out"

# T16: install offers are declined in NI mode (no pip/brew run)
grep -qE 'ask_yes_no "Attempt to install via npm now\?" "?y"? "?n"?' "$SETUP" \
  && pass "humanlayer install offer declines in NI" || fail "humanlayer install offer declines in NI"
grep -qE 'ask_yes_no "Attempt to install jq now\?" "?y"? "?n"?' "$SETUP" \
  && pass "jq install offer declines in NI" || fail "jq install offer declines in NI"

# T17: main parses args before the tty redirect
awk '/^main\(\)/,/^}/' "$SETUP" | head -5 | grep -q 'parse_args' \
  && pass "main calls parse_args first" || fail "main calls parse_args first"

# T19: NI skips Sentry when no token is discoverable
scratch_home=$(mktemp -d)
out=$(env -u SENTRY_AUTH_TOKEN HOME="$scratch_home" bash -c "source '$SETUP'
  NON_INTERACTIVE=1
  prompt_sentry_config '{}' >/dev/null" 2>&1 </dev/null)
rm -rf "$scratch_home"
[[ "$out" == *"Skipping Sentry"* ]] && pass "NI skips Sentry without token" || fail "NI skips Sentry without token" "$out"

# T20: NI skips PostHog and Exa unconditionally (skip notices print to stderr,
# which run_sourced suppresses — use a raw sourced bash here)
out=$(bash -c "source '$SETUP'; NON_INTERACTIVE=1; prompt_posthog_config '{}' >/dev/null" </dev/null 2>&1)
[[ "$out" == *"Skipping PostHog"* ]] && pass "NI skips PostHog" || fail "NI skips PostHog" "$out"
out=$(bash -c "source '$SETUP'; NON_INTERACTIVE=1; prompt_exa_config '{}' >/dev/null" </dev/null 2>&1)
[[ "$out" == *"Skipping Exa"* ]] && pass "NI skips Exa" || fail "NI skips Exa" "$out"

# T21: determine_project_location fails loudly (exit 1) in NI mode
bash -c "source '$SETUP'; NON_INTERACTIVE=1; determine_project_location" </dev/null >/dev/null 2>&1 \
  && fail "determine_project_location exits 1 in NI" || pass "determine_project_location exits 1 in NI"

# T22: --help prints usage and exits 0
out=$(run_sourced 'parse_args --help' </dev/null 2>&1)
rc=$?
[[ $rc -eq 0 && "$out" == *"Usage:"* ]] && pass "--help prints usage, exit 0" || fail "--help prints usage, exit 0" "rc=$rc"

echo ""
echo "=== Phase 4: Documentation shape ==="

# T18: usage header documents the new flags
head -10 "$SETUP" | grep -q -- '--non-interactive' \
  && pass "header documents --non-interactive" || fail "header documents --non-interactive"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
