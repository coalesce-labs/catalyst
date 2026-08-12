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
# shellcheck disable=SC2088 # literal ~ in a description string, not a path expansion
check "~/.local/bin/sops candidate resolves when it's the only one present" t_sops_local_bin

rm -f "${SOPSDIR}/home/.local/bin/sops"
touch "${SOPSDIR}/pathdir/sops"; chmod +x "${SOPSDIR}/pathdir/sops"
t_sops_path_fallback() {
  # shellcheck disable=SC2034 # reassigns the global CA_SOPS_CANDIDATES that _ca_resolve_sops (sourced from catalyst-stack) reads
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

# 3f. _ca_write_editor_script (CTL-1650 Codex finding #1): the generated EDITOR script
# must NOT use a `--` end-of-options marker before the file arg — BSD/Apple sed rejects
# it with "illegal option" — and must actually work when run with the real system sed.
EDITOR_SCRIPT="${SCRATCH}/editor.sh"
_ca_write_editor_script "$EDITOR_SCRIPT" acct1 acct2

t_editor_script_no_dashdash() {
  ! grep -qF -- '-- "$1"' "$EDITOR_SCRIPT"
}
check "generated editor script contains no '-- ' end-of-options marker before the file arg" t_editor_script_no_dashdash

t_editor_script_executable() { [[ -x "$EDITOR_SCRIPT" ]]; }
check "generated editor script is executable" t_editor_script_executable

# Run it for real against /usr/bin/sed (this suite runs on macOS, so BSD/Apple sed is
# the system sed) so a regression that silently reintroduces `--` (or any other
# BSD-sed incompatibility) is caught by an actual sed invocation, not just a
# string-shape assertion.
EDITOR_FIXTURE="${SCRATCH}/editor-fixture.env"
cat > "$EDITOR_FIXTURE" <<'EOF'
CLAUDE_TOKEN_acct1='tok1'  # a@b.com
CLAUDE_TOKEN_acct2='tok2'  # c@d.com
_catalyst_active_token="$CLAUDE_TOKEN_acct1"
EOF
t_editor_script_runs_with_system_sed() {
  [[ -x /usr/bin/sed ]] || return 0  # skip off-macOS where there's no BSD sed to prove
  PATH="/usr/bin:${PATH}" "$EDITOR_SCRIPT" "$EDITOR_FIXTURE" || return 1
  grep -qx '_catalyst_active_token="$CLAUDE_TOKEN_acct2"' "$EDITOR_FIXTURE"
}
check "generated editor script flips the selector when run with /usr/bin/sed (system BSD sed)" t_editor_script_runs_with_system_sed

t_editor_script_no_backup_left() { [[ ! -f "${EDITOR_FIXTURE}.bak" ]]; }
check "generated editor script cleans up its .bak scratch file" t_editor_script_no_backup_left

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

# ── 4b. _ca_parse_active_handle_stream (CTL-1650 Codex finding #2: stale-selector fix)
# `switch` derives old_handle from a fresh sops decrypt piped straight into this parser
# — never a variable holding the full decrypted content (which carries token values on
# other lines) and never the possibly-stale local claude-accounts.env.
t_stream_parses_piped_content() {
  local out
  out="$(printf "CLAUDE_TOKEN_acct1='tok1'\nCLAUDE_TOKEN_acct5='tok5'\n_catalyst_active_token=\"\$CLAUDE_TOKEN_acct5\"\n" | _ca_parse_active_handle_stream)"
  [[ "$out" == "acct5" ]]
}
check "_ca_parse_active_handle_stream parses the selector from piped stdin (no file)" t_stream_parses_piped_content

t_stream_prefers_fresh_over_stale_local() {
  # Local fixture says acct1 is active (stale)...
  local stale_local="${SCRATCH}/stale-local.env"
  printf "CLAUDE_TOKEN_acct1='tok1'\n_catalyst_active_token=\"\$CLAUDE_TOKEN_acct1\"\n" > "$stale_local"
  # ...but the freshly-pulled (piped) content says acct2 is now active — the stream
  # parser must reflect the fresh value, proving `switch` won't act on the stale file.
  local fresh
  fresh="$(printf "CLAUDE_TOKEN_acct2='tok2'\n_catalyst_active_token=\"\$CLAUDE_TOKEN_acct2\"\n" | _ca_parse_active_handle_stream)"
  [[ "$(_ca_current_active_handle "$stale_local")" == "acct1" ]] && [[ "$fresh" == "acct2" ]]
}
check "stream parser reads the fresh/piped selector even when the local file is stale" t_stream_prefers_fresh_over_stale_local

t_stream_missing_selector_line() {
  ! printf "CLAUDE_TOKEN_acct1='tok1'\n" | _ca_parse_active_handle_stream >/dev/null 2>&1
}
check "_ca_parse_active_handle_stream fails (not guesses) when the selector line is absent" t_stream_missing_selector_line

t_current_active_handle_contract_unchanged() {
  # _ca_current_active_handle keeps its original file-based contract — `sync` still
  # relies on it, but only AFTER re-materializing the file from a fresh decrypt.
  [[ "$(_ca_current_active_handle "$ACTIVE_FIXTURE")" == "acct3" ]]
}
check "_ca_current_active_handle (file-based) contract is unchanged" t_current_active_handle_contract_unchanged

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

# ── 6. _ca_cluster_repo_dir honors CATALYST_DIR (CTL-1650 Codex finding #4) ─────────
# Mirrors execution-core/config.mjs's getClusterRepoDir(): CATALYST_CLUSTER_DIR is the
# explicit override; absent that, the cluster repo lives under CATALYST_DIR (default
# $HOME/catalyst), not a hardcoded $HOME/catalyst. Run each in a clean `env -i`
# sub-bash (via `source`, so the top-level dispatch guard is skipped — BASH_SOURCE[0]
# != $0 under `bash -c`) so no ambient CATALYST_DIR/CATALYST_CLUSTER_DIR leaks in.
t_cluster_dir_default_home() {
  local out
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-default" bash -c "source '$STACK'; _ca_cluster_repo_dir")"
  [[ "$out" == "${SCRATCH}/home-default/catalyst/catalyst-cluster" ]]
}
check "_ca_cluster_repo_dir defaults to \$HOME/catalyst/catalyst-cluster with no overrides" t_cluster_dir_default_home

t_cluster_dir_honors_catalyst_dir() {
  local out
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" CATALYST_DIR="${SCRATCH}/alt-catalyst-dir" \
      bash -c "source '$STACK'; _ca_cluster_repo_dir")"
  [[ "$out" == "${SCRATCH}/alt-catalyst-dir/catalyst-cluster" ]]
}
check "_ca_cluster_repo_dir resolves under CATALYST_DIR when set (matches execution-core getClusterRepoDir)" t_cluster_dir_honors_catalyst_dir

t_cluster_dir_explicit_override_wins() {
  local out
  out="$(env -i PATH="$PATH" HOME="${SCRATCH}/home-unused" CATALYST_DIR="${SCRATCH}/alt-catalyst-dir" \
      CATALYST_CLUSTER_DIR="${SCRATCH}/explicit-cluster" bash -c "source '$STACK'; _ca_cluster_repo_dir")"
  [[ "$out" == "${SCRATCH}/explicit-cluster" ]]
}
check "CATALYST_CLUSTER_DIR still wins over CATALYST_DIR when both are set" t_cluster_dir_explicit_override_wins

# ── 7. _ca_entry_rejected_reason (CTL-1650 Codex finding #5: reject rate-limited
#      target accounts) — fixtures mirror claude-accounts-usage.mjs's real --json
#      entry shape (gatherAccount/fetchUnifiedLimits). A 429 still carries the unified
#      rate-limit headers, so `.error` stays empty/null on a rejected account — the
#      bug this closes is a probe/verify that only checked `.error`.
t_rejected_allowed_entry() {
  local entry='{"label":"acct1","isActive":false,"error":null,"overallStatus":"allowed","representativeClaim":"five_hour","fiveHour":{"pct":10,"status":"allowed"},"sevenDay":{"pct":5,"status":"allowed"}}'
  [[ -z "$(_ca_entry_rejected_reason "$entry")" ]]
}
check "_ca_entry_rejected_reason: allowed entry is not rejected" t_rejected_allowed_entry

t_rejected_overall_status() {
  local entry='{"label":"acct2","isActive":true,"error":null,"overallStatus":"rejected","representativeClaim":"five_hour","fiveHour":{"pct":100,"status":"rejected"},"sevenDay":{"pct":40,"status":"allowed"}}'
  [[ -n "$(_ca_entry_rejected_reason "$entry")" ]]
}
check "_ca_entry_rejected_reason: overallStatus=rejected is caught" t_rejected_overall_status

t_rejected_binding_window_only() {
  # overallStatus itself isn't "rejected", but the BINDING window (per
  # representativeClaim) is — must still be caught.
  local entry='{"label":"acct3","isActive":true,"error":null,"overallStatus":"allowed_warning","representativeClaim":"seven_day","fiveHour":{"pct":20,"status":"allowed"},"sevenDay":{"pct":100,"status":"rejected"}}'
  [[ -n "$(_ca_entry_rejected_reason "$entry")" ]]
}
check "_ca_entry_rejected_reason: rejected binding (seven_day) window is caught even when overallStatus isn't 'rejected'" t_rejected_binding_window_only

t_rejected_nonbinding_window_ignored() {
  # A rejected NON-binding window (representativeClaim points elsewhere) must not
  # trip a false positive.
  local entry='{"label":"acct4","isActive":false,"error":null,"overallStatus":"allowed","representativeClaim":"five_hour","fiveHour":{"pct":10,"status":"allowed"},"sevenDay":{"pct":100,"status":"rejected"}}'
  [[ -z "$(_ca_entry_rejected_reason "$entry")" ]]
}
check "_ca_entry_rejected_reason: a rejected NON-binding window alone is not flagged" t_rejected_nonbinding_window_ignored

t_rejected_empty_error_field_alone_insufficient() {
  # Reproduces the exact bug: .error is null (unified headers parsed fine on the 429),
  # so an .error-only check would wrongly treat this account as usable.
  local entry='{"label":"acct5","isActive":true,"error":null,"overallStatus":"rejected","representativeClaim":"five_hour","fiveHour":{"pct":100,"status":"rejected"},"sevenDay":{"pct":80,"status":"allowed_warning"}}'
  local err rejected
  err="$(printf '%s' "$entry" | jq -r '.error // empty')"
  rejected="$(_ca_entry_rejected_reason "$entry")"
  [[ -z "$err" ]] && [[ -n "$rejected" ]]
}
check "reproduces the bug: empty .error + rejected status — rejection detector still catches it" t_rejected_empty_error_field_alone_insufficient

t_rejected_missing_representative_claim_falls_back_to_overall() {
  # No representativeClaim at all (defensive: bindingStatus falls back to overallStatus).
  local entry='{"label":"acct6","isActive":false,"error":null,"overallStatus":"rejected","representativeClaim":null,"fiveHour":null,"sevenDay":null}'
  [[ -n "$(_ca_entry_rejected_reason "$entry")" ]]
}
check "_ca_entry_rejected_reason: missing representativeClaim falls back to overallStatus" t_rejected_missing_representative_claim_falls_back_to_overall

# CAT-90 Codex P2: the execution-core daemon sources claude-accounts.env, and it
# must resolve the SAME path this tooling writes. `claude-account switch|sync`
# materializes the token at _ca_accounts_env_file() =
# "${CLAUDE_ACCOUNTS_ENV:-$CA_ACCOUNTS_ENV_DEFAULT}"; a daemon that reads only the
# default path inherits no refreshed token on an override node — or a STALE token
# still sitting at the default — so a restart after a switch keeps running under
# the wrong account. Static parity check: cheap, and it fails loudly if the daemon
# is ever reverted to a hardcoded path.
t_daemon_honors_accounts_env_override() {
  local daemon
  daemon="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/catalyst-execution-core"
  [[ -r "$daemon" ]] || return 1
  grep -q '_accounts_env="\${CLAUDE_ACCOUNTS_ENV:-' "$daemon"
}
check "execution-core daemon honors CLAUDE_ACCOUNTS_ENV (same override as the writer)" t_daemon_honors_accounts_env_override

t_daemon_default_matches_writer_default() {
  local daemon
  daemon="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/catalyst-execution-core"
  # Both must fall back to ~/.config/catalyst/claude-accounts.env.
  grep -q '_accounts_env="\${CLAUDE_ACCOUNTS_ENV:-\${HOME}/.config/catalyst/claude-accounts.env}"' "$daemon"
}
check "execution-core daemon default matches CA_ACCOUNTS_ENV_DEFAULT" t_daemon_default_matches_writer_default

echo ""
TOTAL=$((PASSES + FAILURES))
echo "catalyst-stack-claude-account: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
