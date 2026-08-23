#!/usr/bin/env bash
# Shell tests for `catalyst-stack codex-account` (CTL-2072): fleet-wide Codex
# account status/switch/sync. Modelled on __tests__/catalyst-stack-claude-account.test.sh
# (check()/PASSES/FAILURES, hermetic scratch fixtures, no network, no real sops
# or cluster repo).
#
# SECRET HYGIENE: the Codex selector carries a HANDLE NAME, never a credential —
# subscription `auth.json` files are rotation-bound and are deliberately never
# copied between hosts (a copied one goes stale the moment the original
# refreshes). Every fixture below is an obviously-fake literal, no test invokes
# the real `sops`, the real cluster repo, or the real `codex` binary.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-codex-account.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

ok() {
  PASSES=$((PASSES + 1))
  echo "  PASS: $1"
}
fail_t() {
  FAILURES=$((FAILURES + 1))
  echo "  FAIL: $1"
  [[ -n "${2:-}" ]] && echo "    $2"
}
check() {
  local name="$1"
  shift
  if "$@" >"${SCRATCH}/out" 2>&1; then
    ok "$name"
  else
    fail_t "$name" "$(sed 's/^/      /' "${SCRATCH}/out")"
  fi
}

echo "catalyst-stack codex-account (CTL-2072) tests"

# shellcheck disable=SC1090
source "$STACK"

# ── 1. handle validation ─────────────────────────────────────────────────────
# The handle reaches a sed program AND a `git commit` message, so it must never
# carry shell or regex metacharacters.
t1() { _cx_valid_handle "acct1"; }
check "accepts acct1" t1
t2() { _cx_valid_handle "acct10"; }
check "accepts acct10" t2
t3() { ! _cx_valid_handle "acct-2"; }
check "rejects acct-2 (dash)" t3
t4() { ! _cx_valid_handle "ACCT2"; }
check "rejects ACCT2 (uppercase)" t4
t5() { ! _cx_valid_handle ""; }
check "rejects empty string" t5
t6() { ! _cx_valid_handle 'acct1;rm -rf /'; }
check "rejects a shell-injection handle" t6
t7() { ! _cx_valid_handle 'acct*'; }
check "rejects a glob handle" t7
t8() { ! _cx_valid_handle "acct"; }
check "rejects bare 'acct' (no digits)" t8

# ── 2. selector parsing ──────────────────────────────────────────────────────
SEL_PLAIN="${SCRATCH}/codex-account.env"
cat >"$SEL_PLAIN" <<'EOF'
# Catalyst Codex account selector (CTL-2072). NOT a credential — a handle name.
_catalyst_active_codex_home="acct2"
EOF

t_parse() {
  local got
  got="$(_cx_parse_active_handle_stream <"$SEL_PLAIN")" || return 1
  [[ "$got" == "acct2" ]]
}
check "parses the handle from a selector line" t_parse

# ⛔ Never guess: an absent selector must fail, not default to acct1.
t_parse_absent() {
  local got rc
  got="$(printf '# nothing here\n' | _cx_parse_active_handle_stream)"
  rc=$?
  [[ $rc -ne 0 && -z "$got" ]]
}
check "absent selector line returns rc1, no output" t_parse_absent

# The parser must read STDIN and never capture it into a variable — a caller may
# pipe a live sops decrypt through it.
t_parse_stream_only() {
  grep -q 'grep' <<<"$(declare -f _cx_parse_active_handle_stream)" || return 1
  # It must not assign the whole stream (e.g. `x=$(cat)`), which would land the
  # decrypted bundle in a variable.
  ! grep -qE '\$\(cat\)|\$\(</dev/stdin\)' <<<"$(declare -f _cx_parse_active_handle_stream)"
}
check "stdin-only parser never captures the stream" t_parse_stream_only

# ── 3. the sed selector flip ─────────────────────────────────────────────────
t_flip_plain() {
  local f="${SCRATCH}/flip_plain.env"
  cp "$SEL_PLAIN" "$f"
  _cx_flip_selector_file "$f" acct2 acct1 || return 1
  grep -q '_catalyst_active_codex_home="acct1"' "$f"
}
check "flips a plain env fixture" t_flip_plain

# sops renders the whole env as ONE JSON string line, so `"` appears as `\"`.
t_flip_json_escaped() {
  local f="${SCRATCH}/flip_json.json"
  printf '{"codex-account.env":"# hdr\\n_catalyst_active_codex_home=\\"acct2\\"\\n"}\n' >"$f"
  _cx_flip_selector_file "$f" acct2 acct1 || return 1
  grep -q '_catalyst_active_codex_home=\\"acct1\\"' "$f"
}
check "flips a JSON-escaped sops-shaped fixture" t_flip_json_escaped

t_flip_single_line() {
  local f="${SCRATCH}/flip_one.env"
  cat >"$f" <<'EOF'
# header
_catalyst_active_codex_home="acct2"
# trailer
EOF
  local before after
  before="$(cat "$f")"
  _cx_flip_selector_file "$f" acct2 acct1 || return 1
  after="$(cat "$f")"
  [[ "$(diff <(echo "$before") <(echo "$after") | grep -c '^<')" -eq 1 ]]
}
check "flips exactly one selector, changing 1 line" t_flip_single_line

# acct1 must not match as a prefix of acct10 — the trailing-quote bound is what
# stops it.
t_flip_prefix_safety() {
  local f="${SCRATCH}/flip_prefix.env"
  printf '_catalyst_active_codex_home="acct10"\n' >"$f"
  _cx_flip_selector_file "$f" acct1 acct2 || return 1
  grep -q '_catalyst_active_codex_home="acct10"' "$f"
}
check "acct1 does not match acct10" t_flip_prefix_safety

# ⛔ The `g` flag is load-bearing: sops's decrypted-for-edit temp file is the WHOLE
# env on ONE line, so a g-less program flips only the FIRST occurrence — a decoy
# earlier in the file would eat the substitution and leave the real selector
# untouched while sops still reports "changed".
t_flip_decoy() {
  local f="${SCRATCH}/flip_decoy.json"
  printf '{"codex-account.env":"# old: _catalyst_active_codex_home=\\"acct2\\"\\n_catalyst_active_codex_home=\\"acct2\\"\\n"}\n' >"$f"
  _cx_flip_selector_file "$f" acct2 acct1 || return 1
  # BOTH occurrences flip, and crucially NO acct2 selector survives.
  ! grep -q '_catalyst_active_codex_home=\\"acct2\\"' "$f"
}
check "g-flag: a decoy earlier occurrence is also flipped, real one not skipped" t_flip_decoy

# ── 4. the local apply: symlink flip ─────────────────────────────────────────
mkhomes() { # mkhomes <root> — acct1 + acct2 authed, acctNOAUTH unauthed
  local r="$1"
  mkdir -p "$r/codex-home-acct1" "$r/codex-home-acct2" "$r/codex-home-acctNOAUTH"
  printf '{}\n' >"$r/codex-home-acct1/auth.json"
  printf '{}\n' >"$r/codex-home-acct2/auth.json"
}

t_symlink_flip() {
  local r="${SCRATCH}/apply1"
  mkhomes "$r"
  ln -s "$r/codex-home-acct2" "$r/codex-home"
  ( unset CATALYST_CODEX_HOME; _cx_apply_selector "$r" acct1 ) || return 1
  [[ "$(readlink "$r/codex-home")" == "$r/codex-home-acct1" ]]
}
check "repoints the selector symlink" t_symlink_flip

# ⛔ The flip must not DEREFERENCE the old selector. Behavioural, not a grep:
# on macOS a plain `mv -f newlink selector` follows the existing symlink and
# moves the new link INSIDE the old account's home, leaving the selector pointing
# at the OLD account while returning 0 — a silent no-op that reports success.
t_symlink_no_deref() {
  local r="${SCRATCH}/apply_noderef"
  mkhomes "$r"
  ln -s "$r/codex-home-acct2" "$r/codex-home"
  ( unset CATALYST_CODEX_HOME; _cx_apply_selector "$r" acct1 ) || return 1
  # (a) the selector really moved...
  [[ "$(readlink "$r/codex-home")" == "$r/codex-home-acct1" ]] || return 1
  # (b) ...and nothing was littered inside the OLD account's home.
  [[ -z "$(find "$r/codex-home-acct2" -name 'codex-home.switching.*' -print -quit)" ]]
}
check "the flip does not dereference the old selector (no stray link in the old home)" t_symlink_no_deref

# A partially-applied selector is worse than none: the replace is a single
# rename(2), never rm-then-ln, so no window exists with no selector at all.
t_symlink_atomic() {
  local body
  body="$(declare -f _cx_apply_selector _cx_mv_symlink_nodolow)"
  grep -qE 'mv -h' <<<"$body" || return 1
  grep -qE 'mv -T' <<<"$body" || return 1
  ! grep -qE 'rm -f "\$\{?selector' <<<"$body"
}
check "flip is a rename (mv -h BSD / mv -T GNU), not rm+ln" t_symlink_atomic

t_refuse_missing_home() {
  local r="${SCRATCH}/apply2"
  mkhomes "$r"
  ( unset CATALYST_CODEX_HOME; ! _cx_apply_selector "$r" acct9 )
}
check "refuses to flip onto a missing home" t_refuse_missing_home

t_refuse_no_auth() {
  local r="${SCRATCH}/apply3"
  mkhomes "$r"
  ( unset CATALYST_CODEX_HOME; ! _cx_apply_selector "$r" acctNOAUTH )
}
check "refuses to flip onto a home with no auth.json" t_refuse_no_auth

# A pre-existing REAL directory at the selector path is not ours to delete.
t_refuse_real_dir() {
  local r="${SCRATCH}/apply4"
  mkhomes "$r"
  mkdir -p "$r/codex-home"
  ( unset CATALYST_CODEX_HOME; ! _cx_apply_selector "$r" acct1 ) || return 1
  [[ -d "$r/codex-home" && ! -L "$r/codex-home" ]]
}
check "refuses when the selector path is a real directory (and does not delete it)" t_refuse_real_dir

# ── 5. ⛔ D3's guard: a pin OVERRIDES the symlink ─────────────────────────────
# codexConfig() resolves CATALYST_CODEX_HOME (env) and Layer-1
# catalyst.orchestration.codex.codexHome BEFORE falling back to the symlink. With
# either set, repointing the symlink changes NOTHING — so the switch must fail
# loudly rather than report a success that did not happen.
t_refuse_env_pin() {
  local out
  out="$(CATALYST_CODEX_HOME=/some/pinned/home _cx_assert_selector_unpinned 2>&1)" && return 1
  grep -qi 'CATALYST_CODEX_HOME' <<<"$out"
}
check "fails loudly when CATALYST_CODEX_HOME is set (and names the pin)" t_refuse_env_pin

t_refuse_layer1_pin() {
  local cfgdir="${SCRATCH}/layer1" out
  mkdir -p "$cfgdir"
  printf '{"catalyst":{"orchestration":{"codex":{"codexHome":"/pinned/by/layer1"}}}}\n' >"$cfgdir/config.json"
  out="$( unset CATALYST_CODEX_HOME; CATALYST_CONFIG_FILE="$cfgdir/config.json" _cx_assert_selector_unpinned 2>&1 )" && return 1
  grep -qi 'codexHome' <<<"$out"
}
check "fails loudly when Layer-1 codex.codexHome is set" t_refuse_layer1_pin

# The guard must PASS when nothing is pinned — otherwise it is a check that can
# never be satisfied, and every switch would refuse.
t_unpinned_passes() {
  local cfgdir="${SCRATCH}/layer1ok"
  mkdir -p "$cfgdir"
  printf '{"catalyst":{"orchestration":{}}}\n' >"$cfgdir/config.json"
  ( unset CATALYST_CODEX_HOME; CATALYST_CONFIG_FILE="$cfgdir/config.json" _cx_assert_selector_unpinned )
}
check "positive control: passes when nothing is pinned" t_unpinned_passes

# An empty-string env var is not a pin.
t_empty_env_not_pin() {
  local cfgdir="${SCRATCH}/layer1ok2"
  mkdir -p "$cfgdir"
  printf '{}\n' >"$cfgdir/config.json"
  CATALYST_CODEX_HOME="" CATALYST_CONFIG_FILE="$cfgdir/config.json" _cx_assert_selector_unpinned
}
check "an empty CATALYST_CODEX_HOME is not treated as a pin" t_empty_env_not_pin

# A null Layer-1 value is not a pin either (absent and null must agree).
t_null_layer1_not_pin() {
  local cfgdir="${SCRATCH}/layer1null"
  mkdir -p "$cfgdir"
  printf '{"catalyst":{"orchestration":{"codex":{"codexHome":null}}}}\n' >"$cfgdir/config.json"
  ( unset CATALYST_CODEX_HOME; CATALYST_CONFIG_FILE="$cfgdir/config.json" _cx_assert_selector_unpinned )
}
check "a null Layer-1 codexHome is not a pin" t_null_layer1_not_pin

# ── 6. preconditions ported from claude-account ──────────────────────────────
t_requires_age_key() {
  local out
  out="$(CATALYST_AGE_KEY_FILE="${SCRATCH}/no-such-age.key" \
    CATALYST_CLUSTER_DIR="${SCRATCH}/no-such-cluster" \
    cmd_codex_account_switch acct1 --yes 2>&1)" && return 1
  grep -qi 'age key' <<<"$out"
}
check "switch requires the age key" t_requires_age_key

t_refuses_dirty_clone() {
  local cdir="${SCRATCH}/dirtyclone" agek="${SCRATCH}/age.key" out
  printf 'AGE-SECRET-KEY-FAKE\n' >"$agek"
  mkdir -p "$cdir"
  ( cd "$cdir" && git init -q && git config user.email t@t && git config user.name t \
    && mkdir -p secrets && printf '{}\n' >secrets/node-secret-files.sops.json \
    && git add -A && git commit -qm init && printf 'dirty\n' >bystander.txt ) || return 1
  out="$(CATALYST_AGE_KEY_FILE="$agek" CATALYST_CLUSTER_DIR="$cdir" \
    cmd_codex_account_switch acct1 --yes 2>&1)" && return 1
  grep -qi 'uncommitted or staged' <<<"$out"
}
check "switch refuses a dirty cluster clone" t_refuses_dirty_clone

# The switch must derive old_handle from the freshly PULLED sops content, not the
# locally-materialized file, which goes stale the moment another node switches.
t_old_handle_source() {
  local body
  body="$(declare -f cmd_codex_account_switch)"
  # The old_handle assignment must be fed by a sops decrypt piped into the parser.
  grep -q 'old_handle=' <<<"$body" || return 1
  grep -qE 'sops_bin.*-d --extract.*\| *_cx_parse_active_handle_stream' <<<"$(tr '\n' ' ' <<<"$body")"
}
check "switch derives old_handle from the PULLED sops, not the local file" t_old_handle_source

t_nochange_is_failure() {
  local body
  body="$(declare -f cmd_codex_account_switch)"
  grep -qi 'has not changed' <<<"$body"
}
check "a no-change sops edit is a hard failure" t_nochange_is_failure

t_rollback_on_push_fail() {
  local body
  body="$(declare -f cmd_codex_account_switch)"
  grep -q 'reset --hard HEAD~1' <<<"$body"
}
check "a rejected push rolls the local commit back" t_rollback_on_push_fail

t_pathspec_commit() {
  local body
  body="$(declare -f cmd_codex_account_switch)"
  grep -q -- '-- secrets/node-secret-files.sops.json' <<<"$body"
}
check "the commit is pathspec'd to the secrets file" t_pathspec_commit

# ⛔ No restart. D3: codexConfig() resolves the selector path fresh on every
# dispatch, so repointing the symlink takes effect with no daemon restart. A
# gratuitous cmd_restart would bounce the whole fleet for nothing.
t_no_restart() {
  ! grep -qE 'cmd_restart' <<<"$(declare -f cmd_codex_account_switch cmd_codex_account_sync)"
}
check "neither switch nor sync restarts the stack (D3)" t_no_restart

# ── 7. probe / positive control ──────────────────────────────────────────────
# A fake usage script stands in for codex-accounts-usage.mjs so the probe never
# spawns a real app-server.
mkfake_usage() { # mkfake_usage <file> <json>
  cat >"$1" <<EOF
#!/usr/bin/env node
console.log(process.env.CX_FAKE_JSON || '$2');
EOF
  chmod +x "$1"
}

OKJSON='{"selector":{"activeHandle":"acct1"},"accounts":[{"label":"acct1","isActive":true,"status":"ok","reason":null}]}'
UNAUTHJSON='{"selector":{"activeHandle":"acct1"},"accounts":[{"label":"acct1","isActive":true,"status":"unauthenticated","reason":"codex account authentication required"}]}'
REJECTEDJSON='{"selector":{"activeHandle":"acct1"},"accounts":[{"label":"acct1","isActive":true,"status":"rejected","reason":"rate limit reached on bucket codex: rate_limit_reached"}]}'
MISMATCHJSON='{"selector":{"activeHandle":"acct2"},"accounts":[{"label":"acct1","isActive":false,"status":"ok","reason":null},{"label":"acct2","isActive":true,"status":"ok","reason":null}]}'

FAKE_USAGE="${SCRATCH}/fake-usage.mjs"
mkfake_usage "$FAKE_USAGE" "$OKJSON"

t_probe_ok() { CX_USAGE_SCRIPT_OVERRIDE="$FAKE_USAGE" CX_FAKE_JSON="$OKJSON" _cx_probe_handle_ok acct1; }
check "positive control: probe succeeds on a healthy target" t_probe_ok

t_probe_unauth() { ! CX_USAGE_SCRIPT_OVERRIDE="$FAKE_USAGE" CX_FAKE_JSON="$UNAUTHJSON" _cx_probe_handle_ok acct1; }
check "probe fails on an unauthenticated target" t_probe_unauth

t_probe_rejected() { ! CX_USAGE_SCRIPT_OVERRIDE="$FAKE_USAGE" CX_FAKE_JSON="$REJECTEDJSON" _cx_probe_handle_ok acct1; }
check "probe fails on a rejected (throttled) target" t_probe_rejected

t_probe_absent() { ! CX_USAGE_SCRIPT_OVERRIDE="$FAKE_USAGE" CX_FAKE_JSON="$OKJSON" _cx_probe_handle_ok acct9; }
check "probe fails on a handle the tool never reported" t_probe_absent

# ⛔ verify must not accept "looks fine" — it re-reads and requires THIS handle.
t_verify_ok() { CX_USAGE_SCRIPT_OVERRIDE="$FAKE_USAGE" CX_FAKE_JSON="$OKJSON" _cx_verify_active acct1 >/dev/null; }
check "positive control: verify passes when the active account IS the requested handle" t_verify_ok

t_verify_mismatch() { ! CX_USAGE_SCRIPT_OVERRIDE="$FAKE_USAGE" CX_FAKE_JSON="$MISMATCHJSON" _cx_verify_active acct1 >/dev/null 2>&1; }
check "verify fails when the active account is not the requested handle" t_verify_mismatch

t_verify_autherr() { ! CX_USAGE_SCRIPT_OVERRIDE="$FAKE_USAGE" CX_FAKE_JSON="$UNAUTHJSON" _cx_verify_active acct1 >/dev/null 2>&1; }
check "verify fails when the requested handle reports an auth error" t_verify_autherr

t_verify_rejected() { ! CX_USAGE_SCRIPT_OVERRIDE="$FAKE_USAGE" CX_FAKE_JSON="$REJECTEDJSON" _cx_verify_active acct1 >/dev/null 2>&1; }
check "verify fails when the requested handle is throttled" t_verify_rejected

# An empty/garbage payload must never verify as success.
t_verify_empty() { ! CX_USAGE_SCRIPT_OVERRIDE="$FAKE_USAGE" CX_FAKE_JSON='{}' _cx_verify_active acct1 >/dev/null 2>&1; }
check "verify fails on an empty payload, never a silent pass" t_verify_empty

# ── 8. dispatch wiring ───────────────────────────────────────────────────────
t_dispatch_present() { grep -qE '^\s+codex-account\)' "$STACK"; }
check "codex-account is wired into the dispatch case" t_dispatch_present

t_usage_lists_subcommands() {
  local out
  out="$(cmd_codex_account 2>&1)" && return 1
  grep -q 'status' <<<"$out" && grep -q 'switch' <<<"$out" && grep -q 'sync' <<<"$out"
}
check "a bare codex-account prints a usage line naming all three subcommands" t_usage_lists_subcommands

t_unknown_sub_fails() {
  # NOTE the subshell: catalyst-stack's fail() is `exit 1`, so calling a cmd_*
  # directly would terminate this whole test script rather than this one check.
  ! ( cmd_codex_account bogus ) >/dev/null 2>&1
}
check "an unknown subcommand fails rather than silently no-op'ing" t_unknown_sub_fails

t_header_documents() { grep -q 'catalyst-stack codex-account status' "$STACK"; }
check "the script header documents codex-account" t_header_documents

t_syntax() { bash -n "$STACK"; }
check "catalyst-stack parses (bash -n)" t_syntax

echo ""
echo "catalyst-stack-codex-account: $((PASSES))/$((PASSES + FAILURES)) passed, $FAILURES failed"
[[ "$FAILURES" -eq 0 ]]
