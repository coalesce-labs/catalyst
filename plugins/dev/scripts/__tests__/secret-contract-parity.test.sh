#!/usr/bin/env bash
# Cross-stack parity test for lib/secret-contract.mjs vs lib/catalyst-secret-contract.sh
# (CTL-1616).
#
# Built directly on the proven, CI-exercised cross-stack mechanism in
# __tests__/host-identity.test.sh / __tests__/deployment-mode-parity.test.sh (shell out to
# node, run identical inputs through both implementations, diff the outputs). Three
# non-negotiable properties (design §3):
#
#   1. THREE-WAY ASSERTION — bash == computed-expected AND node == computed-expected, never
#      merely bash == node. Two implementations can agree with each other while both
#      disagreeing with the spec; that is a false-green on the exact property this test
#      exists to guard.
#   2. ROW-ID-SET EQUALITY — the bash and JS registries must enumerate identical id sets. A
#      row added on one side without the other fails closed, loudly.
#   3. PARITY COST SCALES PER PROVIDER TYPE, NOT PER ROW — one representative fixture matrix
#      per delivery type (bare-file, bare-file-family, env-file, env-alias, config-json,
#      platform-env, local-only), not a combinatorial explosion across all 11 rows.
#
# SECRET HYGIENE: every cell runs under `env -i` (real environment fully cleared) with HOME
# repointed at a scratch tmpdir — a developer's real ambient LINEAR_API_KEY/GITHUB_TOKEN/age
# key can never leak into a fixture or this test's own output. Fixtures are
# obviously-fake literals.
#
# Run: bash plugins/dev/scripts/__tests__/secret-contract-parity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-secret-contract.sh"
JS_LIB="${REPO_ROOT}/plugins/dev/scripts/lib/secret-contract.mjs"

FAILURES=0
PASSES=0
SKIPPED=0

ok() { PASSES=$((PASSES+1)); }
fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES+1))
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
   || [[ ! -f "$LIB" ]] || [[ ! -f "$JS_LIB" ]]; then
  echo "  SKIP: secret-contract-parity (node/jq unavailable or libs missing: $LIB / $JS_LIB)"
  echo ""
  echo "Total: 0, Passed: 0, Failed: 0, Skipped: 1"
  exit 0
fi

# shellcheck disable=SC1090
source "$LIB"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SANDBOX_HOME="${TMP_DIR}/home"
mkdir -p "$SANDBOX_HOME"

# ─── Property 2: row-id-set equality ─────────────────────────────────────────────────────
PROBE_IDS_JS="${TMP_DIR}/probe-ids.mjs"
cat > "$PROBE_IDS_JS" <<EOF
import { SECRET_REGISTRY } from "${JS_LIB}";
process.stdout.write(SECRET_REGISTRY.map((r) => r.id).join("\n") + "\n");
EOF
BASH_IDS="$(catalyst_secret_registry_ids)"
JS_IDS="$(node "$PROBE_IDS_JS")"
expect_eq "row-id-set equality: bash registry ids == JS registry ids" "$JS_IDS" "$BASH_IDS"

# Also assert the ORDER matches (not strictly required by "set equality", but a stronger,
# still-true property here since both files are hand-authored to mirror each other row for
# row — a silent reorder is itself worth flagging).
IFS=$'\n' read -r -d '' -a JS_ID_ARR < <(printf '%s\0' "$JS_IDS")
IFS=$'\n' read -r -d '' -a BASH_ID_ARR < <(printf '%s\0' "$BASH_IDS")
expect_eq "row count matches (11)" "11" "${#JS_ID_ARR[@]}"
expect_eq "row count matches (11)" "11" "${#BASH_ID_ARR[@]}"

# ─── Property: per-row THREE-WAY field-parity table (B5) ────────────────────────────────
# For every one of the 11 rows, assert delivery, rotation class/trigger, bootstrapFor,
# configJsonPath, and envNames (ORDER-sensitive — precedence matters, e.g. GH_TOKEN before
# GITHUB_TOKEN) against EXPECTED literals in BOTH languages — not merely bash==node. This is
# the row-level analogue of property 1 (the resolveSecret cells below already do this for
# resolved VALUES; this table does it for the STATIC FACTS every row declares).
PROBE_FIELDS_JS="${TMP_DIR}/probe-fields.mjs"
cat > "$PROBE_FIELDS_JS" <<EOF
import { getSecretRow } from "${JS_LIB}";
const row = getSecretRow(process.env.CSC_FIELD_PROBE_ID);
if (!row) { process.stdout.write("MISSING"); process.exit(0); }
const fields = [
  row.delivery ?? "",
  row.rotation?.class ?? "",
  row.rotation?.trigger ?? "",
  row.bootstrapFor ?? "",
  row.configJsonPath ?? "",
  (row.envNames ?? []).join(","),
];
process.stdout.write(fields.join("|"));
EOF

# _csc_fields_for ID — bash-side equivalent of the JS probe above, via the same public
# accessor functions any real consumer would use. No `env -i` needed here (unlike the
# resolveSecret cells below): every accessor is a pure registry-metadata lookup that never
# consults process.env, so ambient shell state cannot influence the result.
_csc_fields_for() {
  local _id="$1" _delivery _rclass _rtrig _bfor _cjpath _envs
  _delivery="$(catalyst_secret_delivery "$_id")"
  _rclass="$(catalyst_secret_rotation_class "$_id")"
  _rtrig="$(catalyst_secret_rotation_trigger "$_id")"
  _bfor="$(catalyst_secret_bootstrap_for "$_id")"
  _cjpath="$(catalyst_secret_config_json_path "$_id")"
  _envs="$(catalyst_secret_env_names "$_id" | tr '\n' ',')"
  _envs="${_envs%,}"
  printf '%s|%s|%s|%s|%s|%s' "$_delivery" "$_rclass" "$_rtrig" "$_bfor" "$_cjpath" "$_envs"
}

# EXPECTED — one row per registry id, built via the SAME join shape as _csc_fields_for/the
# JS probe (delivery|class|trigger|bootstrapFor|configJsonPath|envNames-comma-joined) so a
# mismatch is a genuine data error, never a hand-counted-pipes typo. Verified against
# design §2's seed table and both SECRET_REGISTRY (secret-contract.mjs) and the
# _CSC_* arrays (this file's own bash mirror) at authoring time.
_fp_row() { printf '%s|%s|%s|%s|%s|%s' "$1" "$2" "$3" "$4" "$5" "$6"; }
_FP_IDS=(
  github-token webhook-secret linear-webhook-secret claude-accounts.env execution-core.env
  linear-api-token linear-orchestrator-actor linear-worker-actor groq-api-key cloud-token age-key
)
_FP_EXPECTED=(
  "$(_fp_row bare-file re-armable timer '' '' 'GH_TOKEN,GITHUB_TOKEN')"
  "$(_fp_row bare-file boot-only '' '' '' 'CATALYST_WEBHOOK_SECRET')"
  "$(_fp_row bare-file-family boot-only '' '' '' '')"
  "$(_fp_row env-file boot-only '' '' '' '')"
  "$(_fp_row env-file boot-only '' '' '' '')"
  "$(_fp_row env-alias re-armable on-401 '' '' 'LINEAR_API_TOKEN,LINEAR_API_KEY')"
  "$(_fp_row config-json re-armable on-401 '' 'catalyst.linear.bot.orchestrator' '')"
  "$(_fp_row config-json boot-only '' '' 'catalyst.linear.bot.worker' '')"
  "$(_fp_row config-json boot-only '' '' 'groq.apiKey' 'GROQ_API_KEY')"
  "$(_fp_row platform-env boot-only '' cloud 'catalyst.cloud.tokenEnv' 'CATALYST_CLOUD_TOKEN')"
  "$(_fp_row local-only n/a '' cluster '' 'SOPS_AGE_KEY_FILE')"
)
for _fp_i in "${!_FP_IDS[@]}"; do
  _fp_id="${_FP_IDS[$_fp_i]}"
  _fp_exp="${_FP_EXPECTED[$_fp_i]}"
  _fp_bash="$(_csc_fields_for "$_fp_id")"
  _fp_js="$(CSC_FIELD_PROBE_ID="$_fp_id" node "$PROBE_FIELDS_JS")"
  expect_eq "field-parity[$_fp_id]: bash==expected" "$_fp_exp" "$_fp_bash"
  expect_eq "field-parity[$_fp_id]: node==expected" "$_fp_exp" "$_fp_js"
done

# ─── Static JS probe for resolveSecret — reads the SAME env vars the bash side reads via
# its own process.env default, a true black-box parity check of both public entry points.
# Deployment-mode args are threaded through synthetic env names (see below) since the JS
# probe reads them from a small JSON blob rather than positional args (bash's
# catalyst_resolve_secret takes them positionally instead — both call conventions are
# exercised against the SAME semantic inputs per cell).
PROBE_RESOLVE_JS="${TMP_DIR}/probe-resolve.mjs"
cat > "$PROBE_RESOLVE_JS" <<EOF
import { resolveSecret } from "${JS_LIB}";
const id = process.env.CSC_PROBE_ID;
const depMode = process.env.CSC_PROBE_DEP_MODE;
const depInferred = process.env.CSC_PROBE_DEP_INFERRED;
const deploymentMode = depMode ? { mode: depMode, inferred: depInferred === "true" } : undefined;
const r = resolveSecret(id, { deploymentMode });
process.stdout.write((r.value ?? "") + "|" + (r.source ?? "") + "|" + (r.provider ?? ""));
EOF

# _cell NAME EXPECTED [ENV_VAR=VAL ...] -- runs both implementations under identical env -i
# fixtures (CSC_PROBE_ID/_DEP_MODE/_DEP_INFERRED are the JS probe's own inputs; the bash
# side reads CSC_PROBE_ID/_DEP_MODE/_DEP_INFERRED too, via the wrapper below) and asserts
# bash==expected AND node==expected.
_cell() {
  local _name="$1" _expected="$2"
  shift 2
  local BASH_OUT NODE_OUT
  BASH_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" bash -c "
    source '$LIB'
    catalyst_resolve_secret \"\$CSC_PROBE_ID\" \"\${CSC_PROBE_DEP_MODE:-}\" \"\${CSC_PROBE_DEP_INFERRED:-true}\"
  ")"
  NODE_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" node "$PROBE_RESOLVE_JS" 2>&1)"
  expect_eq "$_name (bash==expected)" "$_expected" "$BASH_OUT"
  expect_eq "$_name (node==expected)" "$_expected" "$NODE_OUT"
}

# ─── bare-file: github-token ──────────────────────────────────────────────────────────────
CFG_DIR="${TMP_DIR}/cfg"
mkdir -p "$CFG_DIR"
printf 'tok-value\n' > "${CFG_DIR}/github-token"
_cell "bare-file: resolves from CATALYST_CONFIG_DIR" "tok-value|shared-file|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${CFG_DIR}"

printf 'override-val' > "${TMP_DIR}/explicit-gh-token"
_cell "bare-file: explicit override" "override-val|operator-override|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_GITHUB_TOKEN_FILE=${TMP_DIR}/explicit-gh-token"

_cell "bare-file: falls back to inherited env alias" "inherited-val|inherited|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${TMP_DIR}/does-not-exist-dir" "GH_TOKEN=inherited-val"

_cell "bare-file: nothing anywhere ⇒ none" "|none|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${TMP_DIR}/does-not-exist-dir"

BLANK_DIR="${TMP_DIR}/blank-cfg"
mkdir -p "$BLANK_DIR"
printf '   \n' > "${BLANK_DIR}/github-token"
_cell "bare-file: whitespace-only file treated as absent" "fallback-val|inherited|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${BLANK_DIR}" "GH_TOKEN=fallback-val"

# Hostile probe: NUL-byte-containing file — the CTL-1617 hard-won lesson, generalized from
# JSON fields to raw file bytes. `$(cat)` truncates a NUL in bash; readFileSync does not.
# Both sides MUST reject the candidate identically (fall through), never disagree on a
# silently-truncated partial value.
NUL_DIR="${TMP_DIR}/nul-cfg"
mkdir -p "$NUL_DIR"
printf 'c\x00loud' > "${NUL_DIR}/github-token"
_cell "hostile: NUL-byte in bare-file candidate — rejected on both sides" \
  "fallback-after-nul|inherited|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${NUL_DIR}" "GH_TOKEN=fallback-after-nul"

# ─── unknown id ────────────────────────────────────────────────────────────────────────────
_cell "unknown id: empty triple, never fails the caller" "||" CSC_PROBE_ID=does-not-exist-xyz

# ─── bare-file-family: linear-webhook-secret (no scalar value) ────────────────────────────
_cell "bare-file-family: no single scalar value" "||bare-file-family" CSC_PROBE_ID=linear-webhook-secret

# ─── env-file: claude-accounts.env (presence, value is the PATH) ──────────────────────────
ENVFILE_DIR="${TMP_DIR}/envfile-cfg"
mkdir -p "$ENVFILE_DIR"
printf 'CLAUDE_CODE_OAUTH_TOKEN=abc\n' > "${ENVFILE_DIR}/claude-accounts.env"
_cell "env-file: presence, value is the path" \
  "${ENVFILE_DIR}/claude-accounts.env|shared-file|env-file" \
  CSC_PROBE_ID=claude-accounts.env "CATALYST_CONFIG_DIR=${ENVFILE_DIR}"

EMPTY_ENVFILE_DIR="${TMP_DIR}/empty-envfile-cfg"
mkdir -p "$EMPTY_ENVFILE_DIR"
: > "${EMPTY_ENVFILE_DIR}/claude-accounts.env"
_cell "env-file: empty file counts as absent" "|none|env-file" \
  CSC_PROBE_ID=claude-accounts.env "CATALYST_CONFIG_DIR=${EMPTY_ENVFILE_DIR}"

# ─── B5: previously-uncovered row — execution-core.env (same env-file shape as
# claude-accounts.env, distinct id/basename) ────────────────────────────────────────────────
EXECCORE_DIR="${TMP_DIR}/execcore-cfg"
mkdir -p "$EXECCORE_DIR"
printf 'CATALYST_EXECUTOR=codex\n' > "${EXECCORE_DIR}/execution-core.env"
_cell "env-file: execution-core.env presence, value is the path" \
  "${EXECCORE_DIR}/execution-core.env|shared-file|env-file" \
  CSC_PROBE_ID=execution-core.env "CATALYST_CONFIG_DIR=${EXECCORE_DIR}"

EMPTY_EXECCORE_DIR="${TMP_DIR}/empty-execcore-cfg"
mkdir -p "$EMPTY_EXECCORE_DIR"
: > "${EMPTY_EXECCORE_DIR}/execution-core.env"
_cell "env-file: execution-core.env empty file counts as absent" "|none|env-file" \
  CSC_PROBE_ID=execution-core.env "CATALYST_CONFIG_DIR=${EMPTY_EXECCORE_DIR}"

# ─── B5: previously-uncovered row — webhook-secret (same bare-file shape as github-token,
# distinct id/basename/env-alias) ────────────────────────────────────────────────────────────
WEBHOOK_DIR="${TMP_DIR}/webhook-cfg"
mkdir -p "$WEBHOOK_DIR"
printf 'whsec-value\n' > "${WEBHOOK_DIR}/webhook-secret"
_cell "bare-file: webhook-secret resolves from CATALYST_CONFIG_DIR" \
  "whsec-value|shared-file|bare-file" \
  CSC_PROBE_ID=webhook-secret "CATALYST_CONFIG_DIR=${WEBHOOK_DIR}"
_cell "bare-file: webhook-secret falls back to inherited env alias" \
  "wh-inherited|inherited|bare-file" \
  CSC_PROBE_ID=webhook-secret "CATALYST_CONFIG_DIR=${TMP_DIR}/does-not-exist-dir" \
  "CATALYST_WEBHOOK_SECRET=wh-inherited"

# ─── env-alias: linear-api-token ───────────────────────────────────────────────────────────
_cell "env-alias: LINEAR_API_TOKEN wins over LINEAR_API_KEY" "tok-a|inherited|env-alias" \
  CSC_PROBE_ID=linear-api-token "LINEAR_API_TOKEN=tok-a" "LINEAR_API_KEY=tok-b"
_cell "env-alias: LINEAR_API_KEY-only fixture (the CTL-1619 regression class)" \
  "tok-b|inherited|env-alias" CSC_PROBE_ID=linear-api-token "LINEAR_API_KEY=tok-b"
_cell "env-alias: neither set ⇒ none" "|none|env-alias" CSC_PROBE_ID=linear-api-token

# ─── config-json: groq-api-key (env-then-config) + linear-orchestrator-actor (config-only) ─
L2_DIR="${TMP_DIR}/l2cfg"
mkdir -p "$L2_DIR"
L2_FILE="${L2_DIR}/config.json"
printf '%s' '{"groq":{"apiKey":"from-config"}}' > "$L2_FILE"
_cell "config-json: env alias wins over config" "from-env|inherited|config-json" \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" "GROQ_API_KEY=from-env"
_cell "config-json: falls back to config when env unset" "from-config|config-json|config-json" \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{"groq":{"apiKey":false}}' > "$L2_FILE"
_cell "hostile: bare JSON false settles as none (BLOCKING-1 class), never coerced" \
  "|none|config-json" CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":"{\"apiKey\":\"x\"}"}}}}' > "$L2_FILE"
_cell "config-json: reads the dotted path (linear-orchestrator-actor)" \
  '{"apiKey":"x"}|config-json|config-json' \
  CSC_PROBE_ID=linear-orchestrator-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# B5: previously-uncovered row — linear-worker-actor (config-json, distinct configJsonPath
# from linear-orchestrator-actor — the judge-unanimous "never collapse these two" graft).
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":"{\"apiKey\":\"w\"}"}}}}' > "$L2_FILE"
_cell "config-json: reads the dotted path (linear-worker-actor)" \
  '{"apiKey":"w"}|config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"
printf '%s' '{}' > "$L2_FILE"
_cell "config-json: linear-worker-actor absent path falls through to none" "|none|config-json" \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# Hostile probe: a JSON string value carrying an embedded NUL escape. jq's own parser
# accepts \u0000-style escapes inside a JSON string; both sides must recognize and reject it the same way
# a bare non-string value is rejected (never truncated/coerced).
printf '%s' '{"groq":{"apiKey":"c\u0000loud"}}' > "$L2_FILE"
_cell "hostile: NUL-escape inside a JSON string value settles as none on both sides" \
  "|none|config-json" CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# Hostile probe (B2): an EMPTY JSON string value at the config-json path. The previous bash
# tagger's docstring falsely claimed "never empty per the select below" (no such select
# existed) — an empty string was misclassified source=config-json instead of falling
# through to none, diverging from lib/secret-contract.mjs's `raw.length > 0` check.
printf '%s' '{"groq":{"apiKey":""}}' > "$L2_FILE"
_cell "hostile (B2): empty JSON string value settles as none on both sides, never a resolved empty secret" \
  "|none|config-json" CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# Hostile probe (B2, second call site): an EMPTY Layer-2 NAME-override string for cloud-token
# — same empty-string-tag bug, distinct call site (_csc_resolve_cloud_token_name /
# resolveCloudTokenName), must fall back to the DEFAULT env-var name, not to an empty
# indirect-expansion variable name (which was a second "invalid variable name" fatal-abort
# class on the bash side pre-fix).
printf '%s' '{"catalyst":{"cloud":{"tokenEnv":""}}}' > "$L2_FILE"
_cell "hostile (B2): empty Layer-2 cloud.tokenEnv override falls back to the default env-var name" \
  "cloud-val|platform-env|platform-env" \
  CSC_PROBE_ID=cloud-token "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" "CATALYST_CLOUD_TOKEN=cloud-val"

# ─── platform-env: cloud-token (two-step name-then-value resolution) ──────────────────────
_cell "platform-env: default name" "cloud-val|platform-env|platform-env" \
  CSC_PROBE_ID=cloud-token "CATALYST_CLOUD_TOKEN=cloud-val"
_cell "platform-env: env-var NAME override" "v|platform-env|platform-env" \
  CSC_PROBE_ID=cloud-token "CATALYST_CLOUD_TOKEN_ENV=MY_TOKEN" "MY_TOKEN=v"
printf '%s' '{"catalyst":{"cloud":{"tokenEnv":"OTHER_VAR"}}}' > "$L2_FILE"
_cell "platform-env: Layer-2 NAME override" "v2|platform-env|platform-env" \
  CSC_PROBE_ID=cloud-token "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" "OTHER_VAR=v2"
_cell "platform-env: name resolves, value unset ⇒ none" "|none|platform-env" CSC_PROBE_ID=cloud-token

# ─── local-only: age-key (presence, NEVER value-resolved) ─────────────────────────────────
AGE_HOME="${TMP_DIR}/agehome"
mkdir -p "${AGE_HOME}/.config/catalyst"
printf 'AGE-SECRET-KEY-fake' > "${AGE_HOME}/.config/catalyst/age.key"
BASH_OUT="$(env -i PATH="$PATH" HOME="$AGE_HOME" bash -c "source '$LIB'; catalyst_resolve_secret age-key")"
NODE_OUT="$(env -i PATH="$PATH" HOME="$AGE_HOME" CSC_PROBE_ID=age-key node "$PROBE_RESOLVE_JS" 2>&1)"
EXPECTED="${AGE_HOME}/.config/catalyst/age.key|present|local-only"
expect_eq "local-only: presence at default path (bash==expected)" "$EXPECTED" "$BASH_OUT"
expect_eq "local-only: presence at default path (node==expected)" "$EXPECTED" "$NODE_OUT"

_cell "local-only: absence" "|absent|local-only" CSC_PROBE_ID=age-key
CUSTOM_AGE="${TMP_DIR}/custom-age.key"
printf 'AGE-SECRET-KEY-fake' > "$CUSTOM_AGE"
_cell "local-only: SOPS_AGE_KEY_FILE override honored" "${CUSTOM_AGE}|present|local-only" \
  CSC_PROBE_ID=age-key "SOPS_AGE_KEY_FILE=${CUSTOM_AGE}"

# ─── cloud guard (design §4) — bash side needs the positional args; JS side needs the
# CSC_PROBE_DEP_MODE/_INFERRED env vars the probe script reads ──────────────────────────────
CLOUDGUARD_DIR="${TMP_DIR}/cloudguard-cfg"
mkdir -p "$CLOUDGUARD_DIR"
printf 'file-value' > "${CLOUDGUARD_DIR}/github-token"

_cell "cloud guard: inferred=true does NOT activate cloud" "file-value|shared-file|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${CLOUDGUARD_DIR}" \
  CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=true
_cell "cloud guard: mode=single-host never activates cloud" "file-value|shared-file|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${CLOUDGUARD_DIR}" \
  CSC_PROBE_DEP_MODE=single-host CSC_PROBE_DEP_INFERRED=false
_cell "cloud guard: mode=cluster never activates cloud (zero new cluster resolution code)" \
  "file-value|shared-file|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${CLOUDGUARD_DIR}" \
  CSC_PROBE_DEP_MODE=cluster CSC_PROBE_DEP_INFERRED=false
_cell "cloud guard: genuinely cloud, no GH_TOKEN ⇒ file NEVER consulted, resolves none" \
  "|none|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${CLOUDGUARD_DIR}" "CATALYST_CLOUD_TOKEN=boot" \
  CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false
_cell "cloud guard: genuinely cloud with env alias present resolves via env, file ignored" \
  "cloud-injected|inherited|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${CLOUDGUARD_DIR}" "GH_TOKEN=cloud-injected" \
  "CATALYST_CLOUD_TOKEN=boot" CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false
_cell "bootstrap short-circuit: cloud-token absent ⇒ every other row's cloud resolution is empty/empty" \
  "||bare-file" CSC_PROBE_ID=github-token "GH_TOKEN=should-not-be-returned" \
  CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false
_cell "bootstrap short-circuit does not apply to cloud-token itself" "|none|platform-env" \
  CSC_PROBE_ID=cloud-token CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false

# Hostile probe (B3): the bootstrap-class secret's VALUE itself begins with "|". The
# previous bash implementation captured the recursive resolve call's pipe-joined
# "value|source|provider" stdout via $(...) and parsed it with `${_boot_out%%|*}` — a
# leading "|" makes that pattern match at position 0, stripping the WHOLE string and
# leaving _boot_val empty even though the bootstrap secret genuinely resolved. Bash would
# then falsely apply the short-circuit (returning null/null) while JS — which reads
# bootstrapResolved.value directly, never a delimited string — resolves github-token
# normally via its env alias. Both sides MUST agree on the non-short-circuited result.
_cell "hostile (B3): cloud-token value beginning with '|' must not falsely trigger the bootstrap short-circuit" \
  "cloud-injected|inherited|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${CLOUDGUARD_DIR}" "GH_TOKEN=cloud-injected" \
  "CATALYST_CLOUD_TOKEN=|leading-pipe-value" CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES, Skipped: $SKIPPED"
exit "$FAILURES"
