#!/usr/bin/env bash
# Shell unit tests for plugins/dev/scripts/lib/catalyst-secret-contract.sh (CTL-1616).
# Standalone per-language suite — cross-stack agreement with lib/secret-contract.mjs is
# covered separately by __tests__/secret-contract-parity.test.sh. Follows the
# __tests__/catalyst-deployment-mode.test.sh conventions (ok/fail/expect_eq,
# PASSES/FAILURES exit code).
#
# SECRET HYGIENE (mirrors __tests__/catalyst-execution-core-github-token.test.sh): every
# probe below runs under `env -i` with HOME repointed at a scratch tmpdir, so a developer's
# real shell LINEAR_API_KEY/GITHUB_TOKEN/age-key file can never leak into a fixture or this
# test's own output. Fixtures are obviously-fake literals.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-secret-contract.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-secret-contract.sh"

# shellcheck disable=SC1090
source "$LIB"

# Defensive secret-hygiene guard for the arm-state section below, which (necessarily) calls
# catalyst_arm_secret directly in THIS process rather than through the `_run`/`env -i`
# wrapper (see that section's own comment for why). Nothing in this file's assertions
# depends on any of these ever being set, but clearing them here means a developer's real
# ambient credential can never even theoretically leak into an arm-state assertion.
unset GH_TOKEN GITHUB_TOKEN LINEAR_API_TOKEN LINEAR_API_KEY GROQ_API_KEY \
  CATALYST_CLOUD_TOKEN SOPS_AGE_KEY_FILE CATALYST_WEBHOOK_SECRET 2>/dev/null || true

FAILURES=0
PASSES=0

ok() {
  local name="$1"
  PASSES=$((PASSES+1))
  echo "  PASS: $name"
}
fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $name"
  echo "    $detail"
}
expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    ok "$name"
  else
    fail "$name" "expected '$expected' got '$actual'"
  fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SANDBOX_HOME="${TMP_DIR}/home"
mkdir -p "$SANDBOX_HOME"

# _run runs a snippet under `env -i` (real environment fully cleared) with HOME pointed at
# the sandbox, plus any extra assignments passed as leading args. Mirrors the isolation
# convention used across this repo's other hermetic __tests__ suites.
#
# B6 FIX: `"${assigns[@]}"` on a POSSIBLY-EMPTY array — most call sites pass zero
# assignments (e.g. `_run 'catalyst_resolve_secret age-key'`) — false-fails under stock
# macOS bash 3.2 (/bin/bash) run with `set -u`/nounset: bash 3.2's array expansion treats
# an empty array's "${arr[@]}" as an unset-parameter reference and aborts with "assigns[@]:
# unbound variable" (this is a real 3.2-vs-4+ behavior difference, fixed upstream in bash
# 4.4; this repo's compatibility bar is 3.2, matching lib/catalyst-secret-contract.sh's own
# stated bar). `"${assigns[@]+"${assigns[@]}"}"` is the standard bash 3.2-safe idiom: the
# `+` alternate-value test only expands the inner "${assigns[@]}" when the array is SET
# (even to zero elements), so an empty array yields nothing instead of triggering nounset.
_run() {
  local -a assigns=()
  while [[ "$1" == *=* ]]; do
    assigns+=("$1")
    shift
  done
  local snippet="$1"
  env -i PATH="$PATH" HOME="$SANDBOX_HOME" "${assigns[@]+"${assigns[@]}"}" \
    bash -c "source '$LIB'; $snippet"
}

# --- idempotent-load guard ------------------------------------------------
expect_eq "idempotent-source guard set" "1" "${_CATALYST_SECRET_CONTRACT_SH_LOADED:-}"

# --- registry shape --------------------------------------------------------
IDS_OUT="$(catalyst_secret_registry_ids | tr '\n' ',')"
expect_eq "13 registry ids in order" \
  "github-token,webhook-secret,linear-webhook-secret,claude-accounts.env,execution-core.env,linear-api-token,linear-orchestrator-actor,linear-worker-actor,linear-heartbeat-actor,linear-heartbeat-api-token,groq-api-key,cloud-token,age-key," \
  "$IDS_OUT"

expect_eq "unknown id delivery is empty, not a crash" "" "$(catalyst_secret_delivery bogus-id-xyz)"
expect_eq "github-token delivery" "bare-file" "$(catalyst_secret_delivery github-token)"
expect_eq "linear-webhook-secret delivery" "bare-file-family" "$(catalyst_secret_delivery linear-webhook-secret)"
expect_eq "linear-api-token delivery" "env-alias" "$(catalyst_secret_delivery linear-api-token)"
expect_eq "cloud-token delivery" "platform-env" "$(catalyst_secret_delivery cloud-token)"
expect_eq "age-key delivery" "local-only" "$(catalyst_secret_delivery age-key)"
expect_eq "age-key rotation class" "n/a" "$(catalyst_secret_rotation_class age-key)"
expect_eq "github-token rotation class" "re-armable" "$(catalyst_secret_rotation_class github-token)"
expect_eq "github-token rotation trigger" "timer" "$(catalyst_secret_rotation_trigger github-token)"
expect_eq "linear-api-token rotation trigger" "on-401" "$(catalyst_secret_rotation_trigger linear-api-token)"
expect_eq "cloud-token bootstrapFor" "cloud" "$(catalyst_secret_bootstrap_for cloud-token)"
expect_eq "age-key bootstrapFor" "cluster" "$(catalyst_secret_bootstrap_for age-key)"
expect_eq "github-token bootstrapFor is empty" "" "$(catalyst_secret_bootstrap_for github-token)"
expect_eq "linear-orchestrator-actor config path" "catalyst.linear.bot.orchestrator" "$(catalyst_secret_config_json_path linear-orchestrator-actor)"
expect_eq "linear-worker-actor config path (distinct from orchestrator)" "catalyst.linear.bot.worker" "$(catalyst_secret_config_json_path linear-worker-actor)"
expect_eq "linear-heartbeat-actor config path" "catalyst.linear.bot.heartbeat" "$(catalyst_secret_config_json_path linear-heartbeat-actor)"
expect_eq "linear-heartbeat-actor requires complete credentials" "clientId clientSecret" "$(catalyst_secret_required_object_fields linear-heartbeat-actor)"
expect_eq "linear-heartbeat token env alias" "heartbeat-token|inherited|env-alias" \
  "$(_run "CATALYST_HEARTBEAT_APP_ACTOR_TOKEN=heartbeat-token" 'catalyst_resolve_secret linear-heartbeat-api-token')"
expect_eq "linear-heartbeat token absence is a quiet miss" "|none|env-alias" \
  "$(_run 'catalyst_resolve_secret linear-heartbeat-api-token')"

ENV_NAMES_OUT="$(catalyst_secret_env_names github-token | tr '\n' ',')"
expect_eq "github-token env names" "GH_TOKEN,GITHUB_TOKEN," "$ENV_NAMES_OUT"
ENV_NAMES_EMPTY="$(catalyst_secret_env_names linear-orchestrator-actor | tr '\n' ',')"
expect_eq "linear-orchestrator-actor has no env-name aliases" "" "$ENV_NAMES_EMPTY"

# --- B1 regression: env-name splitting must not depend on the caller's ambient $IFS -------
# A caller that sources this file under the common strict-shell IFS=$'\n\t' (no space in
# it) previously made catalyst_secret_env_names return "GH_TOKEN GITHUB_TOKEN" as ONE
# unsplit token, which then FATALLY ABORTED the whole sourcing process the moment
# _csc_resolve_env_alias_only tried `${!_name-}` on that space-containing "variable name".
_STRICT_IFS=$'\n\t'
ENV_NAMES_STRICT_IFS="$(_run "IFS=${_STRICT_IFS}" 'catalyst_secret_env_names github-token | tr "\n" ","')"
expect_eq "B1: env names split correctly under strict IFS=\$'\\n\\t' (no crash)" \
  "GH_TOKEN,GITHUB_TOKEN," "$ENV_NAMES_STRICT_IFS"
RESOLVE_STRICT_IFS="$(_run "IFS=${_STRICT_IFS}" "GITHUB_TOKEN=strict-ifs-value" 'catalyst_resolve_secret github-token')"
expect_eq "B1: catalyst_resolve_secret resolves github-token under strict IFS (no crash, no bogus 'invalid variable name' abort)" \
  "strict-ifs-value|inherited|bare-file" "$RESOLVE_STRICT_IFS"

# --- isSecretFamilyMember mirror -------------------------------------------
if catalyst_secret_is_family_member "linear-webhook-secret-CTL"; then
  ok "family member: mixed-case team key"
else
  fail "family member: mixed-case team key" "expected match"
fi
if catalyst_secret_is_family_member "linear-webhook-secret-"; then
  fail "bare prefix must NOT be a member" "matched"
else
  ok "bare prefix is not a member"
fi
if catalyst_secret_is_family_member "linear-webhook-secretXXX"; then
  fail "run-on name must NOT be a member" "matched"
else
  ok "run-on name is not a member"
fi

# --- explicit-file-override var derivation ---------------------------------
expect_eq "github-token override var" "CATALYST_GITHUB_TOKEN_FILE" "$(catalyst_secret_explicit_file_override_var github-token)"
expect_eq "webhook-secret override var" "CATALYST_WEBHOOK_SECRET_FILE" "$(catalyst_secret_explicit_file_override_var webhook-secret)"
expect_eq "claude-accounts.env override var (dash AND dot collapse to one underscore)" \
  "CATALYST_CLAUDE_ACCOUNTS_ENV_FILE" "$(catalyst_secret_explicit_file_override_var claude-accounts.env)"

# --- resolveLayer2Path — the §2 canonical chain ----------------------------
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=/explicit/path.json" 'catalyst_secret_resolve_layer2_path')"
expect_eq "layer2 path: explicit override wins" "/explicit/path.json" "$OUT"
OUT="$(_run "CATALYST_MACHINE_CONFIG=/machine/config.json" 'catalyst_secret_resolve_layer2_path')"
expect_eq "layer2 path: CATALYST_MACHINE_CONFIG wins over default" "/machine/config.json" "$OUT"
OUT="$(_run "XDG_CONFIG_HOME=${TMP_DIR}/xdg" 'catalyst_secret_resolve_layer2_path')"
expect_eq "layer2 path: XDG_CONFIG_HOME wins over bare-HOME default" "${TMP_DIR}/xdg/catalyst/config.json" "$OUT"
OUT="$(_run 'catalyst_secret_resolve_layer2_path')"
expect_eq "layer2 path: default ~/.config/catalyst/config.json" "${SANDBOX_HOME}/.config/catalyst/config.json" "$OUT"

# --- catalyst_secret_candidates ---------------------------------------------
OUT="$(_run "CATALYST_GITHUB_TOKEN_FILE=/x/y" 'catalyst_secret_candidates github-token | tr "\n" ","')"
expect_eq "candidates: explicit override short-circuits" "/x/y," "$OUT"
OUT="$(_run "CATALYST_CONFIG_DIR=/cfgdir" 'catalyst_secret_candidates github-token | tr "\n" ","')"
expect_eq "candidates: CATALYST_CONFIG_DIR short-circuits" "/cfgdir/github-token," "$OUT"
OUT="$(_run 'catalyst_secret_candidates github-token | tr "\n" ","')"
expect_eq "candidates: default chain dedupes to one (layer2-dir == xdg-dir by default)" \
  "${SANDBOX_HOME}/.config/catalyst/github-token," "$OUT"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=/other/config.json" "XDG_CONFIG_HOME=/xdg" 'catalyst_secret_candidates github-token | tr "\n" ","')"
expect_eq "candidates: distinct XDG dir yields two candidates" "/other/github-token,/xdg/catalyst/github-token," "$OUT"

# --- resolveSecret: bare-file (github-token) --------------------------------
mkdir -p "${TMP_DIR}/cfg"
printf 'tok-value\n' > "${TMP_DIR}/cfg/github-token"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/cfg" 'catalyst_resolve_secret github-token')"
expect_eq "resolve github-token from CATALYST_CONFIG_DIR" "tok-value|shared-file|bare-file" "$OUT"

printf 'override-val' > "${TMP_DIR}/explicit-gh-token"
OUT="$(_run "CATALYST_GITHUB_TOKEN_FILE=${TMP_DIR}/explicit-gh-token" 'catalyst_resolve_secret github-token')"
expect_eq "resolve github-token from explicit override" "override-val|operator-override|bare-file" "$OUT"

OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/does-not-exist-dir" "GH_TOKEN=inherited-val" 'catalyst_resolve_secret github-token')"
expect_eq "resolve github-token falls back to inherited env alias" "inherited-val|inherited|bare-file" "$OUT"

OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/does-not-exist-dir" 'catalyst_resolve_secret github-token')"
expect_eq "resolve github-token: nothing anywhere ⇒ none" "|none|bare-file" "$OUT"

mkdir -p "${TMP_DIR}/blank-cfg"
printf '   \n' > "${TMP_DIR}/blank-cfg/github-token"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/blank-cfg" "GH_TOKEN=fallback-val" 'catalyst_resolve_secret github-token')"
expect_eq "resolve github-token: whitespace-only file treated as absent" "fallback-val|inherited|bare-file" "$OUT"

# NUL-byte parity fixture: a file with an embedded NUL must be rejected (falls through to
# the env alias), never silently truncated to a partial value.
mkdir -p "${TMP_DIR}/nul-cfg"
printf 'c\x00loud' > "${TMP_DIR}/nul-cfg/github-token"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/nul-cfg" "GH_TOKEN=fallback-after-nul" 'catalyst_resolve_secret github-token')"
expect_eq "resolve github-token: NUL-containing file rejected, falls through" "fallback-after-nul|inherited|bare-file" "$OUT"

# NON-UTF-8 BYTES (Codex finding fix): a file whose bytes are not valid UTF-8 must be
# REJECTED consistently on both sides — never silently served as a mutated credential.
mkdir -p "${TMP_DIR}/badutf8-cfg"
printf '\xff\xfehi' > "${TMP_DIR}/badutf8-cfg/github-token"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/badutf8-cfg" "GH_TOKEN=fallback-after-bad-utf8" 'catalyst_resolve_secret github-token')"
expect_eq "resolve github-token: non-UTF-8 file rejected, falls through" "fallback-after-bad-utf8|inherited|bare-file" "$OUT"

mkdir -p "${TMP_DIR}/goodutf8-cfg"
printf 'tok-\xe2\x9c\x93-value\n' > "${TMP_DIR}/goodutf8-cfg/github-token"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/goodutf8-cfg" 'catalyst_resolve_secret github-token')"
expect_eq "resolve github-token: valid multi-byte UTF-8 is preserved, not rejected" $'tok-\xe2\x9c\x93-value|shared-file|bare-file' "$OUT"

# --- resolveSecret: unknown id ----------------------------------------------
OUT="$(_run 'catalyst_resolve_secret does-not-exist-xyz')"
expect_eq "resolve unknown id: empty triple, never fails the caller" "||" "$OUT"

# --- resolveSecret: bare-file-family (no scalar value) ----------------------
OUT="$(_run 'catalyst_resolve_secret linear-webhook-secret')"
expect_eq "resolve linear-webhook-secret (family row): no single value" "||bare-file-family" "$OUT"

# --- resolveSecret: env-file presence (claude-accounts.env) -----------------
mkdir -p "${TMP_DIR}/envfile-cfg"
printf 'CLAUDE_CODE_OAUTH_TOKEN=abc\n' > "${TMP_DIR}/envfile-cfg/claude-accounts.env"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/envfile-cfg" 'catalyst_resolve_secret claude-accounts.env')"
expect_eq "resolve claude-accounts.env: presence, value is the PATH" \
  "${TMP_DIR}/envfile-cfg/claude-accounts.env|shared-file|env-file" "$OUT"

mkdir -p "${TMP_DIR}/empty-envfile-cfg"
: > "${TMP_DIR}/empty-envfile-cfg/claude-accounts.env"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/empty-envfile-cfg" 'catalyst_resolve_secret claude-accounts.env')"
expect_eq "resolve claude-accounts.env: empty file counts as absent" "|none|env-file" "$OUT"

# --- resolveSecret: env-alias (linear-api-token) ----------------------------
OUT="$(_run "LINEAR_API_TOKEN=tok-a" "LINEAR_API_KEY=tok-b" 'catalyst_resolve_secret linear-api-token')"
expect_eq "linear-api-token: LINEAR_API_TOKEN wins" "tok-a|inherited|env-alias" "$OUT"
OUT="$(_run "LINEAR_API_KEY=tok-b" 'catalyst_resolve_secret linear-api-token')"
expect_eq "linear-api-token: LINEAR_API_KEY-only fixture (CTL-1619 class) resolves" "tok-b|inherited|env-alias" "$OUT"
OUT="$(_run 'catalyst_resolve_secret linear-api-token')"
expect_eq "linear-api-token: neither set ⇒ none" "|none|env-alias" "$OUT"

# --- resolveSecret: config-json (groq-api-key, linear-orchestrator-actor) --
mkdir -p "${TMP_DIR}/l2cfg"
printf '%s' '{"groq":{"apiKey":"from-config"}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" "GROQ_API_KEY=from-env" 'catalyst_resolve_secret groq-api-key')"
expect_eq "groq-api-key: env alias wins over config" "from-env|inherited|config-json" "$OUT"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" 'catalyst_resolve_secret groq-api-key')"
expect_eq "groq-api-key: falls back to config when env unset" "from-config|config-json|config-json" "$OUT"

printf '%s' '{"groq":{"apiKey":false}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" 'catalyst_resolve_secret groq-api-key')"
expect_eq "groq-api-key: bare JSON false settles as none (BLOCKING-1 class), never coerced" "|none|config-json" "$OUT"

printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":"{\"apiKey\":\"x\"}"}}}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" 'catalyst_resolve_secret linear-orchestrator-actor')"
expect_eq "linear-orchestrator-actor: reads the dotted config path (string-shaped value)" '{"apiKey":"x"}|config-json|config-json' "$OUT"

# --- ACTOR ROW SHAPE (Codex finding fix): the AUTHORITATIVE Layer-2 schema stores
# catalyst.linear.bot.orchestrator/.worker as OBJECTS ({clientId, clientSecret, ...}), never
# a string — this fixture uses a REAL object (not a string containing JSON text, which
# masked the pre-fix bug) and asserts the canonicalized (sorted-key) output.
printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":{"clientSecret":"s3cr3t","clientId":"abc123"}}}}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" 'catalyst_resolve_secret linear-orchestrator-actor')"
expect_eq "linear-orchestrator-actor: OBJECT-shaped value canonicalizes with sorted keys" \
  '{"clientId":"abc123","clientSecret":"s3cr3t"}|config-json|config-json' "$OUT"

printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":{}}}}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" 'catalyst_resolve_secret linear-orchestrator-actor')"
expect_eq "linear-orchestrator-actor: an EMPTY object still resolves (canonical '{}')" \
  '{}|config-json|config-json' "$OUT"

printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":["nope"]}}}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" 'catalyst_resolve_secret linear-orchestrator-actor')"
expect_eq "linear-orchestrator-actor: an ARRAY is rejected (not a valid credential shape)" "|none|config-json" "$OUT"

# --- linear-worker-actor: credentialEnvPair + legacyConfigTiers (CTL-1616 PR4) ----------
# Every fixture here is mirrored byte-for-byte in __tests__/secret-contract-parity.test.sh's
# linear-worker-actor cells and in lib/secret-contract.test.mjs's own describe block, proving
# bash and JS agree — not merely each internally self-consistent.
WA_DIR="${TMP_DIR}/wa"
mkdir -p "$WA_DIR"
WA_L2="${WA_DIR}/config.json"

printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"CFG","clientSecret":"CFGSEC"}}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "CATALYST_LINEAR_AGENT_CLIENT_ID=EID" "CATALYST_LINEAR_AGENT_CLIENT_SECRET=ESEC" 'catalyst_resolve_secret linear-worker-actor')"
expect_eq "linear-worker-actor: credentialEnvPair wins over every config tier when both halves present" \
  '{"clientId":"EID","clientSecret":"ESEC"}|inherited|config-json' "$OUT"

OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "CATALYST_LINEAR_AGENT_CLIENT_ID=EID" 'catalyst_resolve_secret linear-worker-actor')"
expect_eq "linear-worker-actor: credentialEnvPair with only ONE half set does not win — falls through" \
  '{"clientId":"CFG","clientSecret":"CFGSEC"}|config-json|config-json' "$OUT"

WA_REPO="${WA_DIR}/repo"
mkdir -p "${WA_REPO}/.catalyst"
printf '%s' '{"catalyst":{"projectKey":"proj1"}}' > "${WA_REPO}/.catalyst/config.json"
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}}}}' > "${WA_DIR}/config-proj1.json"

printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"NEW","clientSecret":"NEWSEC"}},"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_REPO}' && catalyst_resolve_secret linear-worker-actor")"
expect_eq "linear-worker-actor: all-tiers-present — primary (NEW global bot.worker) wins" \
  '{"clientId":"NEW","clientSecret":"NEWSEC"}|config-json|config-json' "$OUT"

printf '%s' '{}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_REPO}' && catalyst_resolve_secret linear-worker-actor")"
expect_eq "linear-worker-actor: only-per-team-legacy-present — per-team tier wins" \
  '{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}|legacy-config-json|config-json' "$OUT"

WA_REPO2="${WA_DIR}/repo2"
mkdir -p "${WA_REPO2}/.catalyst"
printf '%s' '{"catalyst":{"projectKey":"proj-no-file"}}' > "${WA_REPO2}/.catalyst/config.json"
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_REPO2}' && catalyst_resolve_secret linear-worker-actor")"
expect_eq "linear-worker-actor: only-global-legacy-present (projectKey resolves but its own per-team file is absent) — global-legacy tier wins" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' "$OUT"

WA_NOANCESTRY="${WA_DIR}/no-ancestry"
mkdir -p "$WA_NOANCESTRY"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_NOANCESTRY}' && catalyst_resolve_secret linear-worker-actor" 2>/dev/null)"
expect_eq "linear-worker-actor: no projectKey found anywhere — per-team tier's own fallback-to-global-path still resolves the global-only legacy layout" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' "$OUT"

printf '%s' '{}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_NOANCESTRY}' && catalyst_resolve_secret linear-worker-actor" 2>/dev/null)"
expect_eq "linear-worker-actor: nothing present anywhere resolves to none" "|none|config-json" "$OUT"

# --- B1 REGRESSION FIXTURES (CTL-1616 PR4 remediation): the OLD linear-comment-post.sh
# advanced to the NEXT tier whenever clientId OR clientSecret was empty after a tier's read;
# canonicalizeConfigJsonValue's "any non-null value wins" rule let a CREDENTIAL-FREE or
# PARTIALLY-POPULATED object at a tier's path capture resolution instead, silently starving a
# deeper, fully-populated tier — the caller then hard-failed on the empty fields rather than
# falling through. Each fixture names the winning tier the OLD script would have picked (the
# deeper FULL-credential tier) and proves the fixed engine agrees. Mirrored byte-for-byte in
# lib/secret-contract.test.mjs and __tests__/secret-contract-parity.test.sh.
WA_B1_REPO="${WA_DIR}/b1-repo"
mkdir -p "${WA_B1_REPO}/.catalyst"
printf '%s' '{"catalyst":{"projectKey":"proj1"}}' > "${WA_B1_REPO}/.catalyst/config.json"
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}}}}' > "${WA_DIR}/config-proj1.json"

printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"partial-cid"}}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_B1_REPO}' && catalyst_resolve_secret linear-worker-actor")"
expect_eq "B1: primary tier holds only clientId (no clientSecret) — per-team-legacy (full) wins" \
  '{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}|legacy-config-json|config-json' "$OUT"

printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"webhookSecret":"whs","botUserId":"uuid-123"}}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_B1_REPO}' && catalyst_resolve_secret linear-worker-actor")"
expect_eq "B1: primary tier holds a CREDENTIAL-FREE object ({webhookSecret,botUserId}) — per-team-legacy (full) wins" \
  '{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}|legacy-config-json|config-json' "$OUT"

WA_B1_REPO_NOAGENT="${WA_DIR}/b1-repo-noagent"
mkdir -p "${WA_B1_REPO_NOAGENT}/.catalyst"
printf '%s' '{"catalyst":{"projectKey":"proj-noagent"}}' > "${WA_B1_REPO_NOAGENT}/.catalyst/config.json"
# No config-proj-noagent.json file at all — the per-team-legacy tier's own file is absent.
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"","clientSecret":""}},"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_B1_REPO_NOAGENT}' && catalyst_resolve_secret linear-worker-actor")"
expect_eq "B1: primary tier holds empty-string clientId/clientSecret — global-legacy (full) wins" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' "$OUT"

printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"pid-only"}}}}' > "${WA_DIR}/config-proj1.json"
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_B1_REPO}' && catalyst_resolve_secret linear-worker-actor")"
expect_eq "B1: primary tier absent, per-team-legacy holds only clientId (no clientSecret) — global-legacy (full) wins" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' "$OUT"
# Restore config-proj1.json to its full-credential shape for the B2 fixture below.
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"TEAMAGENT","clientSecret":"TEAMAGENTSEC"}}}}' > "${WA_DIR}/config-proj1.json"

# --- B2 REGRESSION FIXTURE: no prior fixture populated BOTH legacy tiers with DISTINCT
# credentials at once, so a swap of _CSC_LEGACY_TIERS's order survived every suite. (The
# actual order-swap MUTATION is performed manually against this file on disk — see the
# CTL-1616 PR4 remediation notes — since `_run` re-sources $LIB fresh in a child process for
# every cell; mutating this suite's own in-memory _CSC_LEGACY_TIERS array would never reach
# that child process and would silently no-op.)
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"GLOBALAGENT","clientSecret":"GLOBALAGENTSEC"}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_B1_REPO}' && catalyst_resolve_secret linear-worker-actor")"
expect_eq "B2: BOTH legacy tiers present with DISTINCT full credentials — per-team-legacy wins (pins tier order)" \
  '{"clientId":"TEAMAGENT","clientSecret":"TEAMAGENTSEC"}|legacy-config-json|config-json' "$OUT"

# --- ROUND-2 B3 REGRESSION FIXTURES (both shapes empirically pinned against
# `git show origin/main:.../linear-comment-post.sh` in a hermetic fixture — see the
# requiredObjectFields row-field comment in lib/secret-contract.mjs for the two canon rules
# and their pre-fold empirical results). Mirrored byte-for-byte in
# __tests__/secret-contract-parity.test.sh and lib/secret-contract.test.mjs. Each fixture
# ALSO populates a real legacy tier so the assertion proves genuine FALL-THROUGH to a deeper
# tier, not merely "resolves to none".
WA_NOANCESTRY_B3="${WA_DIR}/no-ancestry-b3"
mkdir -p "$WA_NOANCESTRY_B3"
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":"{\"clientId\":\"str-cid\",\"clientSecret\":\"str-csec\"}"},"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_NOANCESTRY_B3}' && catalyst_resolve_secret linear-worker-actor" 2>/dev/null)"
expect_eq "CANON RULE 1: a bare STRING value at the primary tier — even one whose own text parses as a full credential object — falls through, never wins on string content" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' "$OUT"

WA_NOANCESTRY_B3B="${WA_DIR}/no-ancestry-b3b"
mkdir -p "$WA_NOANCESTRY_B3B"
printf '%s\n' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"\n","clientSecret":"\n"}},"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$WA_L2"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${WA_L2}" "cd '${WA_NOANCESTRY_B3B}' && catalyst_resolve_secret linear-worker-actor" 2>/dev/null)"
expect_eq "CANON RULE 2: newline-only clientId/clientSecret at the primary tier falls through, never wins on raw non-zero length" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' "$OUT"

# --- TRAILING NEWLINES IN JSON VALUES (Codex finding fix) -------------------
printf '%s' '{"groq":{"apiKey":"abc\n"}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" 'catalyst_resolve_secret groq-api-key')"
expect_eq "groq-api-key: a trailing newline in the JSON string value is preserved byte-for-byte" \
  $'abc\n|config-json|config-json' "$OUT"

# --- JSON ACCEPTANCE NORMALIZATION (Codex finding fix) ----------------------
# BOM-prefixed Layer-2 file: jq tolerates it, JSON.parse rejects it — must settle @ABSENT
# (falls through to none) on the bash side too.
BOM_CFG="${TMP_DIR}/l2cfg/bom-config.json"
printf '\xEF\xBB\xBF{"groq":{"apiKey":"should-not-resolve"}}' > "$BOM_CFG"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${BOM_CFG}" 'catalyst_resolve_secret groq-api-key')"
expect_eq "hostile: BOM-prefixed Layer-2 file settles as none (malformed, matches JSON.parse)" "|none|config-json" "$OUT"

# Multi-document Layer-2 file: jq without -s processes each document independently (emits
# multiple tags); JSON.parse rejects the whole file. Must settle @ABSENT (none) here too.
MULTIDOC_CFG="${TMP_DIR}/l2cfg/multidoc-config.json"
printf '{"groq":{"apiKey":"first-doc"}}{"groq":{"apiKey":"second-doc"}}' > "$MULTIDOC_CFG"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${MULTIDOC_CFG}" 'catalyst_resolve_secret groq-api-key')"
expect_eq "hostile: multi-document Layer-2 file settles as none (malformed, matches JSON.parse)" "|none|config-json" "$OUT"

# --- resolveSecret: platform-env (cloud-token) ------------------------------
OUT="$(_run "CATALYST_CLOUD_TOKEN=cloud-val" 'catalyst_resolve_secret cloud-token')"
expect_eq "cloud-token: default name" "cloud-val|platform-env|platform-env" "$OUT"
OUT="$(_run "CATALYST_CLOUD_TOKEN_ENV=MY_TOKEN" "MY_TOKEN=v" 'catalyst_resolve_secret cloud-token')"
expect_eq "cloud-token: env-var NAME override" "v|platform-env|platform-env" "$OUT"
printf '%s' '{"catalyst":{"cloud":{"tokenEnv":"OTHER_VAR"}}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" "OTHER_VAR=v2" 'catalyst_resolve_secret cloud-token')"
expect_eq "cloud-token: Layer-2 NAME override" "v2|platform-env|platform-env" "$OUT"
OUT="$(_run 'catalyst_resolve_secret cloud-token')"
expect_eq "cloud-token: name resolves, value unset ⇒ none" "|none|platform-env" "$OUT"

# --- INVALID ENV NAME (Codex finding fix): CATALYST_CLOUD_TOKEN_ENV / the Layer-2 override
# is operator-controlled text — an invalid shell-identifier value must degrade to the
# documented unresolved result (source=none), never a fatal "invalid variable name" abort.
OUT="$(_run "CATALYST_CLOUD_TOKEN_ENV=BAD-NAME" 'catalyst_resolve_secret cloud-token')"
RC=$?
expect_eq "cloud-token: invalid env-name override does not abort the caller (rc=0)" "0" "$RC"
expect_eq "cloud-token: invalid env-name override resolves none (JS parity), never a crash" "|none|platform-env" "$OUT"

printf '%s' '{"catalyst":{"cloud":{"tokenEnv":"BAD-NAME-FROM-LAYER2"}}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" 'catalyst_resolve_secret cloud-token')"
RC=$?
expect_eq "cloud-token: invalid Layer-2 tokenEnv override does not abort the caller (rc=0)" "0" "$RC"
expect_eq "cloud-token: invalid Layer-2 tokenEnv override resolves none" "|none|platform-env" "$OUT"

# Errexit-safety regression: run the SAME invalid-name probe under `set -e` in a fresh
# process — before the fix, `${!_env_var-}` on an invalid identifier fatally aborted the
# WHOLE process, not just the lookup. (CATALYST_CLOUD_TOKEN_ENV is passed as a leading
# assignment arg to _run, not embedded in the snippet text — _run's own `[[ "$1" == *=* ]]`
# assignment-parsing loop would otherwise misparse a snippet body containing a literal "=".)
ERREXIT_ENV_OUT="$(_run "CATALYST_CLOUD_TOKEN_ENV=BAD-NAME" 'set -e
catalyst_resolve_secret cloud-token')"
ERREXIT_ENV_RC=$?
expect_eq "invalid env name under set -e: caller process exits 0 (no abort)" "0" "$ERREXIT_ENV_RC"
expect_eq "invalid env name under set -e: still resolves none" "|none|platform-env" "$ERREXIT_ENV_OUT"

# --- resolveSecret: local-only (age-key), never fetched ---------------------
mkdir -p "${TMP_DIR}/agehome/.config/catalyst"
printf 'AGE-SECRET-KEY-fake' > "${TMP_DIR}/agehome/.config/catalyst/age.key"
OUT="$(env -i PATH="$PATH" HOME="${TMP_DIR}/agehome" bash -c "source '$LIB'; catalyst_resolve_secret age-key")"
expect_eq "age-key: presence at default path" "${TMP_DIR}/agehome/.config/catalyst/age.key|present|local-only" "$OUT"
OUT="$(_run 'catalyst_resolve_secret age-key')"
expect_eq "age-key: absence" "|absent|local-only" "$OUT"
printf 'AGE-SECRET-KEY-fake' > "${TMP_DIR}/custom-age.key"
OUT="$(_run "SOPS_AGE_KEY_FILE=${TMP_DIR}/custom-age.key" 'catalyst_resolve_secret age-key')"
expect_eq "age-key: SOPS_AGE_KEY_FILE override honored" "${TMP_DIR}/custom-age.key|present|local-only" "$OUT"

# --- cloud guard (design §4) -------------------------------------------------
mkdir -p "${TMP_DIR}/cloudguard-cfg"
printf 'file-value' > "${TMP_DIR}/cloudguard-cfg/github-token"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/cloudguard-cfg" 'catalyst_resolve_secret github-token cloud true')"
expect_eq "cloud guard: inferred=true does NOT activate cloud — file chain still runs" \
  "file-value|shared-file|bare-file" "$OUT"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/cloudguard-cfg" 'catalyst_resolve_secret github-token single-host false')"
expect_eq "cloud guard: mode=single-host never activates cloud" "file-value|shared-file|bare-file" "$OUT"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/cloudguard-cfg" 'catalyst_resolve_secret github-token cluster false')"
expect_eq "cloud guard: mode=cluster never activates cloud (zero new cluster resolution code)" "file-value|shared-file|bare-file" "$OUT"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/cloudguard-cfg" "CATALYST_CLOUD_TOKEN=boot" 'catalyst_resolve_secret github-token cloud false')"
expect_eq "cloud guard: genuinely cloud, no GH_TOKEN ⇒ file NEVER consulted, resolves none" "|none|bare-file" "$OUT"
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/cloudguard-cfg" "GH_TOKEN=cloud-injected" "CATALYST_CLOUD_TOKEN=boot" 'catalyst_resolve_secret github-token cloud false')"
expect_eq "cloud guard: genuinely cloud with env alias present resolves via env" "cloud-injected|inherited|bare-file" "$OUT"
OUT="$(_run "GH_TOKEN=should-not-be-returned" 'catalyst_resolve_secret github-token cloud false')"
expect_eq "bootstrap short-circuit: cloud-token absent ⇒ every other row's cloud resolution is empty/empty" "||bare-file" "$OUT"
OUT="$(_run 'catalyst_resolve_secret cloud-token cloud false')"
expect_eq "bootstrap short-circuit does not apply to cloud-token itself (resolves normally, absent here)" "|none|platform-env" "$OUT"

# --- cloud guard RECOGNIZED extension (CTL-1616 PR6, design §12 Q3 belt-and-suspenders) -----
# Mirrors lib/secret-contract.mjs's `deploymentMode.recognized !== false` addition: a 4th
# positional RECOGNIZED arg, defaulting to "true" so every 2/3-arg call above is unaffected.
OUT="$(_run "CATALYST_CONFIG_DIR=${TMP_DIR}/cloudguard-cfg" "GH_TOKEN=env-value-should-not-win" 'catalyst_resolve_secret github-token cloud false false')"
expect_eq "cloud guard: recognized=false does NOT activate cloud even with mode=cloud inferred=false — file chain still runs" \
  "file-value|shared-file|bare-file" "$OUT"
OUT="$(_run "GH_TOKEN=should-not-be-returned" 'catalyst_resolve_secret github-token cloud false true')"
expect_eq "cloud guard: recognized=true (explicit) activates cloud exactly like recognized omitted" \
  "||bare-file" "$OUT"

# --- CLOUD-TOKEN NAME OVERRIDE (Codex finding fix): genuine cloud mode must honor
# CATALYST_CLOUD_TOKEN_ENV / the Layer-2 override, not only the hardcoded default name ------
OUT="$(_run "CATALYST_CLOUD_TOKEN_ENV=MY_PLATFORM_TOKEN" "MY_PLATFORM_TOKEN=the-real-token" 'catalyst_resolve_secret cloud-token cloud false')"
expect_eq "cloud-token: genuine cloud mode honors CATALYST_CLOUD_TOKEN_ENV override" \
  "the-real-token|platform-env|platform-env" "$OUT"

printf '%s' '{"catalyst":{"cloud":{"tokenEnv":"OTHER_TOKEN_VAR"}}}' > "${TMP_DIR}/l2cfg/config.json"
OUT="$(_run "CATALYST_LAYER2_CONFIG_FILE=${TMP_DIR}/l2cfg/config.json" "OTHER_TOKEN_VAR=v2" 'catalyst_resolve_secret cloud-token cloud false')"
expect_eq "cloud-token: genuine cloud mode honors the Layer-2 catalyst.cloud.tokenEnv override too" \
  "v2|platform-env|platform-env" "$OUT"

OUT="$(_run "CATALYST_CLOUD_TOKEN_ENV=MY_PLATFORM_TOKEN" "CATALYST_CLOUD_TOKEN=should-not-be-used" 'catalyst_resolve_secret cloud-token cloud false')"
expect_eq "cloud-token: override name genuinely consulted — the default var being set does NOT resolve it" \
  "|none|platform-env" "$OUT"

# --- arm state: MUST be called directly (not via $()) for state to persist -
catalyst_secret_reset_arm_state
# Seed a synthetic delivery/rotation row is not possible (registry is static data), so this
# section exercises the REAL github-token row against a controlled CATALYST_CONFIG_DIR,
# calling catalyst_arm_secret directly in the SAME shell (not "$(...)"-wrapped) exactly as
# its own docstring requires.
# Deliberately NOT wrapped in a `( ... )` subshell or `$(...)` command substitution: this
# test file's own PASSES/FAILURES tally lives in THIS shell, and (per catalyst_arm_secret's
# own docstring) a subshell would silently discard both the arm-state mutation AND any
# counter increments made inside it — the identical subshell-export trap this whole suite
# exists to guard against, one level up the call stack.
ARM_TMP="${TMP_DIR}/arm-cfg"
mkdir -p "$ARM_TMP"
export CATALYST_CONFIG_DIR="$ARM_TMP"
catalyst_secret_reset_arm_state
printf 'FAKE-TOKEN-XYZ' > "${ARM_TMP}/github-token"
catalyst_arm_secret github-token >/dev/null
expect_eq "arm: first observation establishes baseline" "false|false|false" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"
catalyst_arm_secret github-token >/dev/null
expect_eq "arm: unchanged value ⇒ no rotation" "false|false|false" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"
printf 'FAKE-TOKEN-ROTATED' > "${ARM_TMP}/github-token"
catalyst_arm_secret github-token >/dev/null
expect_eq "arm: changed value ⇒ rotated + restartRequired (Gherkin Scenario 2)" "false|true|true" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"
catalyst_arm_secret github-token >/dev/null
expect_eq "arm: settles again after the rotation is observed once" "false|false|false" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"
unset CATALYST_CONFIG_DIR

catalyst_secret_reset_arm_state
catalyst_arm_secret age-key >/dev/null
expect_eq "arm: age-key (n/a rotation class) is always a no-op" "false|false|false" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"

# --- R1 regression: pipe-containing VALUES survive the arm rotation diff -------------------
# The pre-fix code parsed resolve's pipe-joined stdout with ${x%%|*}, truncating any value
# at its first "|" — two rotations differing only AFTER a pipe compared equal, silently
# losing the rotation AND its restartRequired signal (the literal 2026-08-02 outage
# mechanism this contract exists to report). The fix reads CATALYST_SECRET_LAST_VALUE
# directly; these cells pin the full-byte diff.
ARM_PIPE_TMP="${TMP_DIR}/arm-pipe-cfg"
mkdir -p "$ARM_PIPE_TMP"
export CATALYST_CONFIG_DIR="$ARM_PIPE_TMP"
catalyst_secret_reset_arm_state
printf 'FAKE|first' > "${ARM_PIPE_TMP}/github-token"
catalyst_arm_secret github-token >/dev/null
expect_eq "arm: pipe-containing value — baseline observation" "false|false|false" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"
printf 'FAKE|second' > "${ARM_PIPE_TMP}/github-token"
catalyst_arm_secret github-token >/dev/null
expect_eq "arm: rotation differing only AFTER the pipe is detected (restartRequired fires)" \
  "false|true|true" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"
unset CATALYST_CONFIG_DIR

# --- ARM DEPLOYMENT MODE (Codex finding fix, design §8): catalyst_arm_secret must thread
# the SAME deployment-mode args catalyst_resolve_secret takes, so a cloud-mode arm baseline
# consults the identical provider chain direct resolution uses. Scenario: cloud mode with an
# injected env token AND a stale local file — a file-only edit must NOT report a false
# restartRequired, and rotating the REAL (env) token MUST be detected. ---------------------
ARM_CLOUD_TMP="${TMP_DIR}/arm-cloud-cfg"
mkdir -p "$ARM_CLOUD_TMP"
export CATALYST_CONFIG_DIR="$ARM_CLOUD_TMP"
export GH_TOKEN="cloud-injected-v1"
export CATALYST_CLOUD_TOKEN="boot"
catalyst_secret_reset_arm_state
printf 'stale-file-value-v1' > "${ARM_CLOUD_TMP}/github-token"

# Direct resolution (the ground truth arm's baseline must match) resolves via env, not file.
DIRECT_OUT="$(catalyst_resolve_secret github-token cloud false)"
expect_eq "arm-deployment-mode: direct resolution in cloud mode uses the env value, not the stale file" \
  "cloud-injected-v1|inherited|bare-file" "$DIRECT_OUT"

catalyst_arm_secret github-token cloud false >/dev/null
expect_eq "arm-deployment-mode: first observation establishes baseline" "false|false|false" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"

# Rewriting the STALE FILE ONLY must NOT be observed as a rotation.
printf 'stale-file-value-v2-changed' > "${ARM_CLOUD_TMP}/github-token"
catalyst_arm_secret github-token cloud false >/dev/null
expect_eq "arm-deployment-mode: a file-only change is IGNORED — baseline tracks the env-derived value like direct resolution does" \
  "false|false|false" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"

# Rotating the ACTUAL cloud-injected env value MUST be detected.
export GH_TOKEN="cloud-injected-v2-rotated"
catalyst_arm_secret github-token cloud false >/dev/null
expect_eq "arm-deployment-mode: rotating the REAL cloud-injected value IS detected (restartRequired fires)" \
  "false|true|true" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"
unset CATALYST_CONFIG_DIR GH_TOKEN CATALYST_CLOUD_TOKEN

# --- B4 regression: catalyst_arm_secret(unknown id) must not abort a `set -e` caller ------
# Same-shell direct call (no `set -e` in THIS process) — asserts the quiet {armed:false}
# triple, matching lib/secret-contract.mjs's armSecret for an unknown id.
catalyst_secret_reset_arm_state
catalyst_arm_secret does-not-exist-xyz >/dev/null
expect_eq "arm: unknown id returns the quiet false/false/false triple (matches JS armSecret)" \
  "false|false|false" \
  "${CATALYST_SECRET_ARM_ARMED}|${CATALYST_SECRET_ARM_ROTATED}|${CATALYST_SECRET_ARM_RESTART_REQUIRED}"

# The actual regression: run under `set -e` in a FRESH bash -c process (via _run) — before
# the B4 fix, catalyst_secret_rotation_class's rc=1 on an unknown id propagated through the
# bare `_rotation_class=$(...)` assignment and killed this whole process before the echo
# ever ran, so ERREXIT_OUT would come back empty and ERREXIT_RC nonzero.
ERREXIT_OUT="$(_run 'set -e
catalyst_arm_secret does-not-exist-xyz >/dev/null
printf "%s|%s|%s" "$CATALYST_SECRET_ARM_ARMED" "$CATALYST_SECRET_ARM_ROTATED" "$CATALYST_SECRET_ARM_RESTART_REQUIRED"')"
ERREXIT_RC=$?
expect_eq "B4: catalyst_arm_secret(unknown id) under set -e exits 0 (does not abort the caller)" "0" "$ERREXIT_RC"
expect_eq "B4: catalyst_arm_secret(unknown id) under set -e still returns the quiet triple" \
  "false|false|false" "$ERREXIT_OUT"

# ─── SECRET-ENV HYGIENE (#2924 post-merge Codex P2): the resolved VALUE must be
# readable in the resolving shell but NEVER exported (a long-lived daemon shell
# launches its runtime as a child; an exported credential lands in every
# descendant's environment). Exportedness asserted via declare -p (-x flag).
# NOTE: _run treats a leading *=* arg as an env assignment, so the snippet
# below is written =-free and the token rides the assigns slot.
HYGIENE_OUT="$(_run LINEAR_API_TOKEN=tok-hygiene 'catalyst_resolve_secret linear-api-token >/dev/null
printf "%s|" "${CATALYST_SECRET_LAST_VALUE:-ABSENT}"
case "$(declare -p CATALYST_SECRET_LAST_VALUE 2>/dev/null)" in "declare -x"*) printf "exported|" ;; *) printf "notexported|" ;; esac
case "$(declare -p CATALYST_SECRET_LAST_SOURCE 2>/dev/null)" in "declare -x"*) printf "exported" ;; *) printf "notexported" ;; esac')"
expect_eq "hygiene: VALUE readable same-shell, NOT exported; SOURCE breadcrumb exported" \
  "tok-hygiene|notexported|exported" "$HYGIENE_OUT"

# Sticky-export regression (#2925 post-merge P2): if the shell INHERITED the
# breadcrumb already-exported (rolling upgrade from the pre-fix lib), plain
# reassignment keeps bash's -x attribute — _csc_set_result must clear it.
# The stale exported value is seeded via _run's assigns slot (env -i exports it).
HYGIENE_STICKY="$(_run LINEAR_API_TOKEN=tok-hygiene CATALYST_SECRET_LAST_VALUE=stale-exported 'catalyst_resolve_secret linear-api-token >/dev/null
printf "%s|" "${CATALYST_SECRET_LAST_VALUE:-ABSENT}"
case "$(declare -p CATALYST_SECRET_LAST_VALUE 2>/dev/null)" in "declare -x"*) printf "exported" ;; *) printf "notexported" ;; esac')"
expect_eq "hygiene: inherited-exported breadcrumb loses -x on the next resolve (sticky-export cleared)" \
  "tok-hygiene|notexported" "$HYGIENE_STICKY"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES, Skipped: 0"
exit "$FAILURES"
