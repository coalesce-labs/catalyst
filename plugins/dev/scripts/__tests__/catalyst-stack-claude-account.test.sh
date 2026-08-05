#!/usr/bin/env bash
# Shell tests for `catalyst-stack claude-account` (CTL-1650): fleet-wide Claude
# OAuth-account status/switch/sync. Follows the __tests__/catalyst-stack-parity.test.sh
# / __tests__/catalyst-secret-contract.test.sh conventions (check()/PASSES/FAILURES,
# hermetic scratch fixtures, no network or real sops/cluster-repo calls).
#
# SECRET HYGIENE: every fixture below uses obviously-fake literals (never a real
# token), and no test invokes the real `sops` binary or the real cluster repo —
# `_ca_resolve_sops`/`_ca_age_key_file`/`_ca_cluster_repo_dir` are exercised against
# scratch dirs via CA_SOPS_CANDIDATES / CATALYST_AGE_KEY_FILE / CATALYST_CLUSTER_DIR
# overrides, and the sed selector-flip transform (`_ca_flip_selector_file`) is
# exercised directly against fixture files — never through a real `sops edit`.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-claude-account.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

ok() {
  local name="$1"
  PASSES=$((PASSES+1))
  echo "  PASS: $name"
}
fail_t() {
  local name="$1" detail="${2:-}"
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $name"
  [[ -n "$detail" ]] && echo "    $detail"
}
check() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    ok "$name"
  else
    fail_t "$name" "$(sed 's/^/      /' "${SCRATCH}/out")"
  fi
}

echo "catalyst-stack claude-account (CTL-1650) tests"

# ─── source the script (guarded dispatch) to reach the pure helpers ─────────
# shellcheck disable=SC1090
source "$STACK"

# ── 1. handle validation ─────────────────────────────────────────────────────
t_handle_valid_acct2()      { _ca_valid_handle "acct2"; }
check "accepts acct2" t_handle_valid_acct2
t_handle_valid_acct12()     { _ca_valid_handle "acct12"; }
check "accepts multi-digit acct12" t_handle_valid_acct12
t_handle_reject_dash()      { ! _ca_valid_handle "acct-2"; }
check "rejects acct-2 (dash)" t_handle_reject_dash
t_handle_reject_upper()     { ! _ca_valid_handle "ACCT2"; }
check "rejects ACCT2 (uppercase)" t_handle_reject_upper
t_handle_reject_empty()     { ! _ca_valid_handle ""; }
check "rejects empty string" t_handle_reject_empty
t_handle_reject_injection() { ! _ca_valid_handle 'acct2; rm -rf /'; }
check "rejects shell-injection string" t_handle_reject_injection
t_handle_reject_bare()      { ! _ca_valid_handle "acct"; }
check "rejects bare 'acct' (no digits)" t_handle_reject_bare
t_handle_reject_leading_zero_ok() { _ca_valid_handle "acct01"; }
check "accepts leading-zero digits (acct01) — digits-only rule, not numeric" t_handle_reject_leading_zero_ok

# ── 2. sops-binary resolution order ──────────────────────────────────────────
SOPSDIR="${SCRATCH}/sopsbins"
mkdir -p "${SOPSDIR}/opt/homebrew/bin" "${SOPSDIR}/usr/local/bin" "${SOPSDIR}/usr/bin" "${SOPSDIR}/home/.local/bin" "${SOPSDIR}/pathdir"

t_sops_none_found() {
  CA_SOPS_CANDIDATES=("${SOPSDIR}/opt/homebrew/bin/sops" "${SOPSDIR}/usr/local/bin/sops")
  local out
  out="$(PATH="${SOPSDIR}/pathdir" _ca_resolve_sops)"
  [[ -z "$out" ]]
}
check "no candidate + empty PATH dir resolves nothing" t_sops_none_found

touch "${SOPSDIR}/usr/local/bin/sops"; chmod +x "${SOPSDIR}/usr/local/bin/sops"
touch "${SOPSDIR}/opt/homebrew/bin/sops"; chmod +x "${SOPSDIR}/opt/homebrew/bin/sops"
t_sops_homebrew_wins() {
  CA_SOPS_CANDIDATES=("${SOPSDIR}/opt/homebrew/bin/sops" "${SOPSDIR}/usr/local/bin/sops" "${SOPSDIR}/usr/bin/sops" "${SOPSDIR}/home/.local/bin/sops")
  local out
  out="$(_ca_resolve_sops)"
  [[ "$out" == "${SOPSDIR}/opt/homebrew/bin/sops" ]]
}
check "known-dir order: /opt/homebrew/bin wins over /usr/local/bin when both exist" t_sops_homebrew_wins

rm -f "${SOPSDIR}/opt/homebrew/bin/sops"
t_sops_falls_through_to_local() {
  CA_SOPS_CANDIDATES=("${SOPSDIR}/opt/homebrew/bin/sops" "${SOPSDIR}/usr/local/bin/sops" "${SOPSDIR}/usr/bin/sops" "${SOPSDIR}/home/.local/bin/sops")
  local out
  out="$(_ca_resolve_sops)"
  [[ "$out" == "${SOPSDIR}/usr/local/bin/sops" ]]
}
check "falls through to next known dir when the first is absent" t_sops_falls_through_to_local

rm -f "${SOPSDIR}/usr/local/bin/sops"
touch "${SOPSDIR}/home/.local/bin/sops"; chmod +x "${SOPSDIR}/home/.local/bin/sops"
t_sops_local_bin() {
  CA_SOPS_CANDIDATES=("${SOPSDIR}/opt/homebrew/bin/sops" "${SOPSDIR}/usr/local/bin/sops" "${SOPSDIR}/usr/bin/sops" "${SOPSDIR}/home/.local/bin/sops")
  local out
  out="$(_ca_resolve_sops)"
  [[ "$out" == "${SOPSDIR}/home/.local/bin/sops" ]]
}
check "~/.local/bin/sops candidate resolves when it's the only one present" t_sops_local_bin

rm -f "${SOPSDIR}/home/.local/bin/sops"
touch "${SOPSDIR}/pathdir/sops"; chmod +x "${SOPSDIR}/pathdir/sops"
t_sops_path_fallback() {
  CA_SOPS_CANDIDATES=("${SOPSDIR}/opt/homebrew/bin/sops" "${SOPSDIR}/usr/local/bin/sops" "${SOPSDIR}/usr/bin/sops" "${SOPSDIR}/home/.local/bin/sops")
  local out
  out="$(PATH="${SOPSDIR}/pathdir" _ca_resolve_sops)"
  [[ "$out" == "${SOPSDIR}/pathdir/sops" ]]
}
check "PATH scan is the final fallback when no known dir has sops" t_sops_path_fallback

# ── 3. sed selector-flip transform (real sed, fixture files, no sops/network) ──
# 3a. Plain env-file fixture (what claude-accounts.env looks like on disk).
PLAIN_FIXTURE="${SCRATCH}/plain.env"
cat > "$PLAIN_FIXTURE" <<'EOF'
CLAUDE_TOKEN_acct1='tok1'  # a@b.com
CLAUDE_TOKEN_acct2='tok2'  # c@d.com
_catalyst_active_token="$CLAUDE_TOKEN_acct1"
case "$_catalyst_active_token" in
  *) export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token" ;;
esac
EOF

t_flip_plain_selector() {
  _ca_flip_selector_file "$PLAIN_FIXTURE" acct1 acct2 || return 1
  grep -qx '_catalyst_active_token="$CLAUDE_TOKEN_acct2"' "$PLAIN_FIXTURE"
}
check "plain fixture: flips the reference line acct1 -> acct2" t_flip_plain_selector

t_flip_plain_definitions_untouched() {
  grep -qx "CLAUDE_TOKEN_acct1='tok1'  # a@b.com" "$PLAIN_FIXTURE" \
    && grep -qx "CLAUDE_TOKEN_acct2='tok2'  # c@d.com" "$PLAIN_FIXTURE"
}
check "plain fixture: CLAUDE_TOKEN_acctN= definition lines untouched" t_flip_plain_definitions_untouched

t_flip_plain_no_backup_left() { [[ ! -f "${PLAIN_FIXTURE}.bak" ]]; }
check "plain fixture: .bak scratch file cleaned up" t_flip_plain_no_backup_left

# 3b. JSON-escaped fixture — mirrors the ACTUAL sops-decrypted-for-edit temp file
# shape (empirically verified against a live `sops edit` round-trip during
# development: claude-accounts.env is a JSON string value, so an embedded `"`
# is rendered as the 2-char escape `\"`, and embedded newlines as literal `\n`,
# not real newlines — the whole env file lives on ONE line of the temp file).
JSON_FIXTURE="${SCRATCH}/sops-temp.json"
cat > "$JSON_FIXTURE" <<'EOF'
{
	"claude-accounts.env": "CLAUDE_TOKEN_acct1='tok1'  # a@b.com\nCLAUDE_TOKEN_acct2='tok2'  # c@d.com\n_catalyst_active_token=\"$CLAUDE_TOKEN_acct1\"\ncase \"$_catalyst_active_token\" in\n  *) export CLAUDE_CODE_OAUTH_TOKEN=\"$_catalyst_active_token\" ;;\nesac\n",
	"other-file": "hello\n"
}
EOF
JSON_FIXTURE_BEFORE="${SCRATCH}/sops-temp-before.json"
cp "$JSON_FIXTURE" "$JSON_FIXTURE_BEFORE"

t_flip_json_selector() {
  _ca_flip_selector_file "$JSON_FIXTURE" acct1 acct2 || return 1
  grep -q '_catalyst_active_token=\\"\$CLAUDE_TOKEN_acct2\\"' "$JSON_FIXTURE"
}
check "JSON-escaped fixture (real sops-temp-file shape): flips the reference" t_flip_json_selector

t_flip_json_definitions_untouched() {
  grep -q "CLAUDE_TOKEN_acct1='tok1'" "$JSON_FIXTURE" \
    && grep -q "CLAUDE_TOKEN_acct2='tok2'" "$JSON_FIXTURE"
}
check "JSON-escaped fixture: CLAUDE_TOKEN_acctN= definition lines untouched" t_flip_json_definitions_untouched

t_flip_json_other_key_untouched() {
  grep -q '"other-file": "hello' "$JSON_FIXTURE"
}
check "JSON-escaped fixture: unrelated sibling key untouched" t_flip_json_other_key_untouched

t_flip_json_no_extra_diff() {
  # Only the selector's handle digit should differ from the original — assert
  # exactly one changed line (one '<' + one '>' from a classic diff).
  local changed
  changed="$(diff "$JSON_FIXTURE_BEFORE" "$JSON_FIXTURE" | grep -c '^[<>]')"
  [[ "$changed" -eq 2 ]]
}
check "JSON-escaped fixture: exactly one line changed (surgical edit)" t_flip_json_no_extra_diff

# 3c. acct1 vs acct10 prefix-collision guard.
PREFIX_FIXTURE="${SCRATCH}/prefix.env"
cat > "$PREFIX_FIXTURE" <<'EOF'
CLAUDE_TOKEN_acct1='tok1'  # a@b.com
CLAUDE_TOKEN_acct10='tokX'  # x@y.com
_catalyst_active_token="$CLAUDE_TOKEN_acct1"
EOF
t_flip_no_prefix_collision() {
  _ca_flip_selector_file "$PREFIX_FIXTURE" acct1 acct2 || return 1
  grep -qx '_catalyst_active_token="$CLAUDE_TOKEN_acct2"' "$PREFIX_FIXTURE" \
    && grep -qx "CLAUDE_TOKEN_acct10='tokX'  # x@y.com" "$PREFIX_FIXTURE"
}
check "acct1 -> acct2 flip does not corrupt a sibling acct10 definition line" t_flip_no_prefix_collision

# 3d. no-op when OLD doesn't match anything (the scenario that makes real sops
# report "File has not changed, exiting." — see the switch flow's handling of it).
NOOP_FIXTURE="${SCRATCH}/noop.env"
cat > "$NOOP_FIXTURE" <<'EOF'
CLAUDE_TOKEN_acct1='tok1'  # a@b.com
_catalyst_active_token="$CLAUDE_TOKEN_acct1"
EOF
NOOP_BEFORE="$(cat "$NOOP_FIXTURE")"
t_flip_noop_when_old_absent() {
  _ca_flip_selector_file "$NOOP_FIXTURE" acct9 acct2 || return 1
  [[ "$(cat "$NOOP_FIXTURE")" == "$NOOP_BEFORE" ]]
}
check "sed is a byte-for-byte no-op when OLD handle isn't the active selector (would trigger sops' 'File has not changed')" t_flip_noop_when_old_absent

# 3e. "File has not changed" detection is a plain substring/case-insensitive match
# on sops' own message text (empirically: "File has not changed, exiting.").
t_detects_unchanged_message() {
  printf '%s' "File has not changed, exiting." | grep -qi "has not changed"
}
check "'File has not changed' detector matches sops' real message text" t_detects_unchanged_message
t_detects_unchanged_message_case() {
  printf '%s' "file HAS NOT changed" | grep -qi "has not changed"
}
check "'File has not changed' detector is case-insensitive" t_detects_unchanged_message_case
t_ok_message_not_flagged() {
  ! printf '%s' "" | grep -qi "has not changed"
}
check "a normal (empty) sops-edit output is not flagged as unchanged" t_ok_message_not_flagged

# ── 4. _ca_current_active_handle ─────────────────────────────────────────────
ACTIVE_FIXTURE="${SCRATCH}/active.env"
cat > "$ACTIVE_FIXTURE" <<'EOF'
CLAUDE_TOKEN_acct1='tok1'  # a@b.com
CLAUDE_TOKEN_acct3='tok3'  # e@f.com
_catalyst_active_token="$CLAUDE_TOKEN_acct3"
EOF
t_current_active_handle() {
  [[ "$(_ca_current_active_handle "$ACTIVE_FIXTURE")" == "acct3" ]]
}
check "_ca_current_active_handle parses the selector line" t_current_active_handle

t_current_active_handle_missing_file() {
  ! _ca_current_active_handle "${SCRATCH}/does-not-exist.env" >/dev/null 2>&1
}
check "_ca_current_active_handle fails (not guesses) when the file is absent" t_current_active_handle_missing_file

NOSELECTOR_FIXTURE="${SCRATCH}/noselector.env"
printf "CLAUDE_TOKEN_acct1='tok1'\n" > "$NOSELECTOR_FIXTURE"
t_current_active_handle_missing_line() {
  ! _ca_current_active_handle "$NOSELECTOR_FIXTURE" >/dev/null 2>&1
}
check "_ca_current_active_handle fails (not guesses) when the selector line is absent" t_current_active_handle_missing_line

# ── 5. age-key / cluster-repo guard failures (run the real dispatch as a
#      subprocess so `fail()`'s exit doesn't kill this test runner; every
#      external side effect — sops, git push, restart — is unreachable because
#      the guard fires first) ──────────────────────────────────────────────
GOOD_AGE_KEY="${SCRATCH}/age.key"
printf 'AGE-SECRET-KEY-FAKE\n' > "$GOOD_AGE_KEY"
GOOD_CLUSTER_DIR="${SCRATCH}/cluster-repo"
mkdir -p "${GOOD_CLUSTER_DIR}/.git"  # only presence of .git is checked

t_guard_missing_age_key() {
  local out rc
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" \
      CATALYST_AGE_KEY_FILE="${SCRATCH}/no-such-age.key" \
      CATALYST_CLUSTER_DIR="$GOOD_CLUSTER_DIR" \
      "$STACK" claude-account switch acct2 --yes 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "cannot decrypt cluster secrets" <<<"$out"
}
check "switch: missing age key fails with the 'cannot decrypt' message" t_guard_missing_age_key

t_guard_missing_cluster_repo() {
  local out rc
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" \
      CATALYST_AGE_KEY_FILE="$GOOD_AGE_KEY" \
      CATALYST_CLUSTER_DIR="${SCRATCH}/no-such-cluster-repo" \
      "$STACK" claude-account switch acct2 --yes 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "no cluster repo clone" <<<"$out"
}
check "switch: missing cluster repo clone fails with a clear message" t_guard_missing_cluster_repo

t_guard_missing_age_key_sync() {
  local out rc
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" \
      CATALYST_AGE_KEY_FILE="${SCRATCH}/no-such-age.key" \
      CATALYST_CLUSTER_DIR="$GOOD_CLUSTER_DIR" \
      "$STACK" claude-account sync --yes 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "cannot decrypt cluster secrets" <<<"$out"
}
check "sync: missing age key fails with the 'cannot decrypt' message" t_guard_missing_age_key_sync

t_invalid_handle_rejected_before_any_guard() {
  local out rc
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" \
      CATALYST_AGE_KEY_FILE="$GOOD_AGE_KEY" \
      CATALYST_CLUSTER_DIR="$GOOD_CLUSTER_DIR" \
      "$STACK" claude-account switch 'not-an-acct' --yes 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "invalid handle" <<<"$out"
}
check "switch: invalid handle format is rejected with a clear message" t_invalid_handle_rejected_before_any_guard

t_switch_no_handle_usage_error() {
  local out rc
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" "$STACK" claude-account switch 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "usage:" <<<"$out"
}
check "switch: no handle prints a usage error" t_switch_no_handle_usage_error

t_claude_account_no_subcommand_usage_error() {
  local out rc
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" "$STACK" claude-account 2>&1)"; rc=$?
  [[ $rc -ne 0 ]] && grep -qi "status" <<<"$out" && grep -qi "switch" <<<"$out" && grep -qi "sync" <<<"$out"
}
check "claude-account: bare subcommand prints usage naming status/switch/sync" t_claude_account_no_subcommand_usage_error

t_claude_account_unknown_subcommand() {
  local out rc
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" "$STACK" claude-account bogus 2>&1)"; rc=$?
  [[ $rc -ne 0 ]]
}
check "claude-account: unknown subcommand exits nonzero" t_claude_account_unknown_subcommand

t_top_level_dispatch_knows_claude_account() {
  local out
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" "$STACK" bogus-command 2>&1)"
  grep -q "claude-account" <<<"$out"
}
check "top-level unknown-command message names claude-account" t_top_level_dispatch_knows_claude_account

echo ""
TOTAL=$((PASSES + FAILURES))
echo "catalyst-stack-claude-account: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
