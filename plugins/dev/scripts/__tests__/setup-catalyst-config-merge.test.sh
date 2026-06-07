#!/usr/bin/env bash
# CTL-843: setup-catalyst.sh must merge per-project secrets, never drop unprompted keys.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/setup-catalyst.sh"

FAILURES=0
PASSES=0

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

# Run a function from the sourced script in an isolated subshell.
run_fn() { bash -c 'CATALYST_SETUP_LIB_ONLY=1 source "$1"; shift; "$@"' _ "$SETUP" "$@"; }

if [[ ! -f "$SETUP" ]]; then
  echo "FATAL: setup-catalyst.sh not found at $SETUP" >&2
  exit 1
fi

# ─── Phase 1 tests ───────────────────────────────────────────────────────────

# Test 1: script is sourceable without running main
echo ""
echo "--- Test 1: script is sourceable without running main ---"
set +e
OUTPUT=$(CATALYST_SETUP_LIB_ONLY=1 bash -c 'source "$1"; echo sourced_ok' _ "$SETUP" 2>&1)
RC=$?
set -e
if [[ $RC -eq 0 ]] && echo "$OUTPUT" | grep -q "sourced_ok"; then
  pass "CATALYST_SETUP_LIB_ONLY=1 sources without running main"
else
  fail "script not sourceable or main ran (rc=$RC): $OUTPUT"
fi

# Test 2: merge preserves linear.agent
echo ""
echo "--- Test 2: merge preserves linear.agent ---"
EXISTING=$(jq -n '{catalyst:{linear:{apiToken:"old",agent:{accessToken:"tok",clientId:"id",clientSecret:"sec",webhookSecret:"hmac",botUserId:"uuid"}}}}')
PATCH='{"apiToken":"new","teamKey":"CTL","defaultTeam":"Catalyst"}'
OWNED='["apiToken","teamKey","defaultTeam"]'
set +e
RESULT=$(run_fn merge_catalyst_section "$EXISTING" linear "$PATCH" "$OWNED" 2>/dev/null)
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  fail "merge_catalyst_section exited non-zero"
else
  assert_eq "new"  "$(echo "$RESULT" | jq -r '.catalyst.linear.apiToken // empty')"          "apiToken updated"
  assert_eq "tok"  "$(echo "$RESULT" | jq -r '.catalyst.linear.agent.accessToken // empty')" "agent.accessToken preserved"
  assert_eq "id"   "$(echo "$RESULT" | jq -r '.catalyst.linear.agent.clientId // empty')"    "agent.clientId preserved"
  assert_eq "sec"  "$(echo "$RESULT" | jq -r '.catalyst.linear.agent.clientSecret // empty')"  "agent.clientSecret preserved"
  assert_eq "hmac" "$(echo "$RESULT" | jq -r '.catalyst.linear.agent.webhookSecret // empty')" "agent.webhookSecret preserved"
  assert_eq "uuid" "$(echo "$RESULT" | jq -r '.catalyst.linear.agent.botUserId // empty')"   "agent.botUserId preserved"
fi

# Test 3: merge preserves arbitrary unprompted sibling keys (forward-compat)
echo ""
echo "--- Test 3: merge preserves arbitrary unprompted sibling keys ---"
EXISTING=$(jq -n '{catalyst:{linear:{apiToken:"old",someFutureKey:"future-value"}}}')
set +e
RESULT=$(run_fn merge_catalyst_section "$EXISTING" linear "$PATCH" "$OWNED" 2>/dev/null)
RC=$?
set -e
[[ $RC -ne 0 ]] && fail "merge_catalyst_section exited non-zero" || \
  assert_eq "future-value" "$(echo "$RESULT" | jq -r '.catalyst.linear.someFutureKey // empty')" "unprompted sibling key preserved"

# Test 4: owned keys are authoritative — stale sentry shape keys dropped
echo ""
echo "--- Test 4: stale owned sentry keys dropped on shape change ---"
EXISTING=$(jq -n '{catalyst:{sentry:{org:"myorg",project:"single-proj",authToken:"tok"}}}')
S_PATCH='{"org":"myorg","authToken":"tok"}'
S_OWNED='["org","project","projects","defaultProject","authToken"]'
set +e
RESULT=$(run_fn merge_catalyst_section "$EXISTING" sentry "$S_PATCH" "$S_OWNED" 2>/dev/null)
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  fail "merge_catalyst_section exited non-zero"
else
  assert_eq "false"  "$(echo "$RESULT" | jq '.catalyst.sentry | has("project")')"      "stale .project key removed"
  assert_eq "myorg"  "$(echo "$RESULT" | jq -r '.catalyst.sentry.org // empty')"       "org preserved"
fi

# Test 5: merge works when section absent (fresh config)
echo ""
echo "--- Test 5: merge works when section absent ---"
set +e
RESULT=$(run_fn merge_catalyst_section '{"catalyst":{}}' exa '{"apiKey":"exakey"}' '["apiKey"]' 2>/dev/null)
RC=$?
set -e
[[ $RC -ne 0 ]] && fail "merge exited non-zero for fresh section" || \
  assert_eq "exakey" "$(echo "$RESULT" | jq -r '.catalyst.exa.apiKey // empty')" "apiKey set in fresh section"

# Test 6: merge works when .catalyst itself is absent
echo ""
echo "--- Test 6: merge works when .catalyst absent ---"
set +e
RESULT=$(run_fn merge_catalyst_section '{}' posthog '{"apiKey":"phkey","projectId":"p1"}' '["apiKey","projectId"]' 2>/dev/null)
RC=$?
set -e
[[ $RC -ne 0 ]] && fail "merge exited non-zero for missing .catalyst" || \
  assert_eq "phkey" "$(echo "$RESULT" | jq -r '.catalyst.posthog.apiKey // empty')" "apiKey set when .catalyst absent"

# ─── Phase 2 tests ───────────────────────────────────────────────────────────

SCRATCH="$(mktemp -d -t setup-catalyst-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

# Test 7: write_secrets_config creates a timestamped backup of an existing file
echo ""
echo "--- Test 7: write_secrets_config creates a timestamped backup ---"
CONF7="${SCRATCH}/config-test7.json"
ORIGINAL='{"catalyst":{"linear":{"apiToken":"original"}}}'
echo "$ORIGINAL" > "$CONF7"
set +e
run_fn write_secrets_config '{"catalyst":{"linear":{"apiToken":"updated"}}}' "$CONF7" 2>/dev/null
RC=$?
BAK7=$(ls "${SCRATCH}"/config-test7.json.bak-* 2>/dev/null | head -1) || true
set -e
if [[ $RC -ne 0 ]]; then
  fail "write_secrets_config exited non-zero"
elif [[ -z "$BAK7" ]]; then
  fail "no backup file created"
else
  assert_eq "$ORIGINAL" "$(cat "$BAK7")" "backup contains original content"
  assert_eq "updated" "$(jq -r '.catalyst.linear.apiToken' "$CONF7")" "config updated"
fi

# Test 8: backup is chmod 600 and final config is chmod 600
echo ""
echo "--- Test 8: backup and config are chmod 600 ---"
CONF8="${SCRATCH}/config-test8.json"
echo '{"catalyst":{}}' > "$CONF8"
set +e
run_fn write_secrets_config '{"catalyst":{"exa":{"apiKey":"k"}}}' "$CONF8" 2>/dev/null
RC=$?
BAK8=$(ls "${SCRATCH}"/config-test8.json.bak-* 2>/dev/null | head -1) || true
set -e
if [[ $RC -ne 0 ]]; then
  fail "write_secrets_config exited non-zero"
else
  CFG_PERMS=$(stat -f "%OLp" "$CONF8" 2>/dev/null || stat -c "%a" "$CONF8" 2>/dev/null)
  assert_eq "600" "$CFG_PERMS" "config file is chmod 600"
  if [[ -n "$BAK8" ]]; then
    BAK_PERMS=$(stat -f "%OLp" "$BAK8" 2>/dev/null || stat -c "%a" "$BAK8" 2>/dev/null)
    assert_eq "600" "$BAK_PERMS" "backup file is chmod 600"
  else
    fail "no backup to check permissions on"
  fi
fi

# Test 9: invalid JSON input leaves the existing file untouched
echo ""
echo "--- Test 9: invalid JSON leaves existing file untouched ---"
CONF9="${SCRATCH}/config-test9.json"
SAFE='{"catalyst":{"linear":{"apiToken":"safe"}}}'
echo "$SAFE" > "$CONF9"
set +e
run_fn write_secrets_config 'not-valid-json' "$CONF9" 2>/dev/null
RC=$?
set -e
if [[ $RC -eq 0 ]]; then
  fail "write_secrets_config should have exited non-zero on invalid JSON"
else
  assert_eq "$SAFE" "$(cat "$CONF9")" "existing file unchanged after invalid JSON attempt"
fi

# Test 10: no backup file created when the config did not exist before
echo ""
echo "--- Test 10: no backup created for new config file ---"
CONF10="${SCRATCH}/config-test10.json"
set +e
run_fn write_secrets_config '{"catalyst":{}}' "$CONF10" 2>/dev/null
RC=$?
BAK10_COUNT=$(ls "${SCRATCH}"/config-test10.json.bak-* 2>/dev/null | wc -l | tr -d ' ') || true
set -e
if [[ $RC -ne 0 ]]; then
  fail "write_secrets_config exited non-zero for new file"
else
  assert_eq "0" "${BAK10_COUNT:-0}" "no backup created for brand-new config"
fi

# Test 11: setup_catalyst_secrets pipeline no longer references /tmp/catalyst-config-temp.json
echo ""
echo "--- Test 11: no fixed /tmp path in script source ---"
if grep -q '/tmp/catalyst-config-temp.json' "$SETUP"; then
  fail "script still references fixed /tmp/catalyst-config-temp.json path"
else
  pass "no fixed /tmp/catalyst-config-temp.json in script source"
fi

# ─── Phase 3 tests ───────────────────────────────────────────────────────────

# Test 12: 'y<Enter>' consumed entirely — no bleed into next read
echo ""
echo "--- Test 12: ask_yes_no 'y<Enter>' consumes exactly one line ---"
set +e
NEXT=$(printf 'y\nSENTINEL\n' | bash -c '
  CATALYST_SETUP_LIB_ONLY=1 source "$1"
  ask_yes_no "Q?" "y" >/dev/null 2>&1
  read -r next
  echo "$next"
' _ "$SETUP" 2>/dev/null)
set -e
assert_eq "SENTINEL" "$NEXT" "next read after ask_yes_no gets SENTINEL (no bleed)"

# Test 13: bare Enter with default y → 0; default n → 1
echo ""
echo "--- Test 13: bare Enter respects default ---"
set +e
printf '\n' | bash -c 'CATALYST_SETUP_LIB_ONLY=1 source "$1"; ask_yes_no "Q?" "y" >/dev/null 2>&1' _ "$SETUP" 2>/dev/null; RC_Y=$?
printf '\n' | bash -c 'CATALYST_SETUP_LIB_ONLY=1 source "$1"; ask_yes_no "Q?" "n" >/dev/null 2>&1' _ "$SETUP" 2>/dev/null; RC_N=$?
set -e
[[ $RC_Y -eq 0 ]] && pass "bare Enter with default y returns 0" || fail "bare Enter with default y should return 0 (got $RC_Y)"
[[ $RC_N -ne 0 ]] && pass "bare Enter with default n returns non-zero" || fail "bare Enter with default n should return non-zero"

# Test 14: 'n<Enter>' → returns 1
echo ""
echo "--- Test 14: 'n<Enter>' returns non-zero ---"
set +e
printf 'n\n' | bash -c 'CATALYST_SETUP_LIB_ONLY=1 source "$1"; ask_yes_no "Q?" "y" >/dev/null 2>&1' _ "$SETUP" 2>/dev/null
RC=$?
set -e
[[ $RC -ne 0 ]] && pass "'n<Enter>' returns non-zero" || fail "'n<Enter>' should return non-zero"

# Test 15: 'yes<Enter>' → returns 0 (full-word answers accepted)
echo ""
echo "--- Test 15: 'yes<Enter>' returns 0 ---"
set +e
printf 'yes\n' | bash -c 'CATALYST_SETUP_LIB_ONLY=1 source "$1"; ask_yes_no "Q?" "n" >/dev/null 2>&1' _ "$SETUP" 2>/dev/null
RC=$?
set -e
[[ $RC -eq 0 ]] && pass "'yes<Enter>' returns 0" || fail "'yes<Enter>' should return 0 (got $RC)"

# Test 16: two consecutive ask_yes_no calls fed 'y\nn\n' answer y then n
echo ""
echo "--- Test 16: consecutive ask_yes_no calls without bleed ---"
set +e
RESULT16=$(printf 'y\nn\n' | bash -c '
  CATALYST_SETUP_LIB_ONLY=1 source "$1"
  if ask_yes_no "First?" "n" >/dev/null 2>&1; then R1=y; else R1=n; fi
  if ask_yes_no "Second?" "y" >/dev/null 2>&1; then R2=y; else R2=n; fi
  echo "${R1}${R2}"
' _ "$SETUP" 2>/dev/null)
set -e
assert_eq "yn" "$RESULT16" "first=y second=n (no stdin bleed)"

# Test 17: script source contains no remaining 'read ... -n 1' outside comments
echo ""
echo "--- Test 17: no 'read ... -n 1' outside comments ---"
NON_COMMENT_READS=$(grep -n 'read.*-n 1' "$SETUP" | grep -Ev '^[0-9]+:[[:space:]]*#' || true)
if [[ -n "$NON_COMMENT_READS" ]]; then
  fail "script still contains 'read ... -n 1' outside comments"
else
  pass "no 'read ... -n 1' outside comments in script source"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo " $PASSES passed, $FAILURES failed"
echo "══════════════════════════════════════════════"

[[ "$FAILURES" -gt 0 ]] && exit 1 || exit 0
