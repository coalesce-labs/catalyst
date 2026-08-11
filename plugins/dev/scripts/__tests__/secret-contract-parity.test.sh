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
expect_eq "row count matches (13)" "13" "${#JS_ID_ARR[@]}"
expect_eq "row count matches (13)" "13" "${#BASH_ID_ARR[@]}"

# ─── Property: per-row THREE-WAY field-parity table (B5) ────────────────────────────────
# For every one of the 13 rows, assert delivery, rotation class/trigger, bootstrapFor,
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
  linear-api-token linear-orchestrator-actor linear-worker-actor linear-heartbeat-actor
  linear-heartbeat-api-token groq-api-key cloud-token age-key
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
  "$(_fp_row config-json re-armable on-401 '' 'catalyst.linear.bot.heartbeat' '')"
  "$(_fp_row env-alias re-armable on-401 '' '' 'CATALYST_HEARTBEAT_APP_ACTOR_TOKEN')"
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
// CTL-1616 PR6: RECOGNIZED defaults to true when unset — mirrors bash's \${4:-true} default,
// so every pre-PR6 cell (which never sets CSC_PROBE_DEP_RECOGNIZED) exercises the identical
// semantic input on both sides it always did.
const depRecognizedRaw = process.env.CSC_PROBE_DEP_RECOGNIZED;
const depRecognized = depRecognizedRaw === undefined ? true : depRecognizedRaw === "true";
const deploymentMode = depMode ? { mode: depMode, inferred: depInferred === "true", recognized: depRecognized } : undefined;
// CTL-1616 PR4: linear-worker-actor's per-team-legacy tier walks cwd upward — CSC_PROBE_CWD
// threads the same working directory the bash side is cd'd into (see _cell_in_dir) so both
// sides walk from the IDENTICAL starting point.
const cwd = process.env.CSC_PROBE_CWD;
const r = resolveSecret(id, cwd ? { deploymentMode, cwd } : { deploymentMode });
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
    catalyst_resolve_secret \"\$CSC_PROBE_ID\" \"\${CSC_PROBE_DEP_MODE:-}\" \"\${CSC_PROBE_DEP_INFERRED:-true}\" \"\${CSC_PROBE_DEP_RECOGNIZED:-true}\"
  ")"
  NODE_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" node "$PROBE_RESOLVE_JS" 2>&1)"
  expect_eq "$_name (bash==expected)" "$_expected" "$BASH_OUT"
  expect_eq "$_name (node==expected)" "$_expected" "$NODE_OUT"
}

# _cell_in_dir DIR NAME EXPECTED [ENV_VAR=VAL ...] -- like _cell, but both languages resolve
# with their working-directory equivalent (bash $PWD / JS cwd option) set to DIR first —
# exercises linear-worker-actor's per-team-legacy tier (CTL-1616 PR4), which walks that
# directory upward for a .catalyst/config.json.
_cell_in_dir() {
  local _dir="$1" _name="$2" _expected="$3"
  shift 3
  local BASH_OUT NODE_OUT
  BASH_OUT="$(cd "$_dir" && env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" bash -c "
    source '$LIB'
    catalyst_resolve_secret \"\$CSC_PROBE_ID\" \"\${CSC_PROBE_DEP_MODE:-}\" \"\${CSC_PROBE_DEP_INFERRED:-true}\" \"\${CSC_PROBE_DEP_RECOGNIZED:-true}\"
  ")"
  NODE_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" CSC_PROBE_CWD="$_dir" "$@" node "$PROBE_RESOLVE_JS" 2>&1)"
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

# Hostile probe (Codex finding fix): NON-UTF-8 BYTES in a bare-file candidate. Node's
# readFileSync(file,"utf8") REPLACES an invalid byte sequence with U+FFFD rather than
# failing — a bare-file secret containing a stray non-UTF-8 byte would silently decode to a
# MUTATED credential in JS while bash's `cat` preserves the original bytes exactly. Both
# sides MUST reject the candidate identically (fall through), same degrade shape as the
# NUL-byte guard above.
BADUTF8_DIR="${TMP_DIR}/badutf8-cfg"
mkdir -p "$BADUTF8_DIR"
printf '\xff\xfehi' > "${BADUTF8_DIR}/github-token"
_cell "hostile: non-UTF-8 bytes in bare-file candidate — rejected on both sides" \
  "fallback-after-bad-utf8|inherited|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${BADUTF8_DIR}" "GH_TOKEN=fallback-after-bad-utf8"

GOODUTF8_DIR="${TMP_DIR}/goodutf8-cfg"
mkdir -p "$GOODUTF8_DIR"
printf 'tok-\xe2\x9c\x93-value\n' > "${GOODUTF8_DIR}/github-token"
_cell "valid multi-byte UTF-8 in a bare-file candidate is preserved, not rejected" \
  $'tok-\xe2\x9c\x93-value|shared-file|bare-file' \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${GOODUTF8_DIR}"

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
_cell "config-json: reads the dotted path (linear-orchestrator-actor, string-shaped value)" \
  '{"apiKey":"x"}|config-json|config-json' \
  CSC_PROBE_ID=linear-orchestrator-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ACTOR ROW SHAPE (Codex finding fix): the AUTHORITATIVE Layer-2 schema stores
# catalyst.linear.bot.orchestrator/.worker as OBJECTS ({clientId, clientSecret, ...}), never
# a string — this fixture uses a REAL object (source key order deliberately
# clientSecret-before-clientId, to prove the canonicalization is genuinely sorting, not just
# echoing source order) and asserts both sides produce the IDENTICAL canonical (sorted-key)
# JSON string.
printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":{"clientSecret":"s3cr3t","clientId":"abc123"}}}}}' > "$L2_FILE"
_cell "config-json: ACTOR ROW SHAPE — OBJECT-shaped value canonicalizes with sorted keys identically on both sides" \
  '{"clientId":"abc123","clientSecret":"s3cr3t"}|config-json|config-json' \
  CSC_PROBE_ID=linear-orchestrator-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":{}}}}}' > "$L2_FILE"
_cell "config-json: ACTOR ROW SHAPE — an EMPTY object still resolves (canonical '{}'), not silently coerced to none" \
  '{}|config-json|config-json' \
  CSC_PROBE_ID=linear-orchestrator-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{"catalyst":{"linear":{"bot":{"orchestrator":["nope"]}}}}' > "$L2_FILE"
_cell "config-json: ACTOR ROW SHAPE — an ARRAY is rejected on both sides (not a valid credential shape)" \
  "|none|config-json" \
  CSC_PROBE_ID=linear-orchestrator-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# B5: previously-uncovered row — linear-worker-actor (config-json, distinct configJsonPath
# from linear-orchestrator-actor — the judge-unanimous "never collapse these two" graft).
# CTL-1616 PR4 remediation (B1 fix): this row now declares requiredObjectFields
# ({clientId, clientSecret}), so — unlike linear-orchestrator-actor above — a bare STRING
# value at its path can never WIN the gate, in EITHER engine (round-2 CANON RULE 1, see the
# requiredObjectFields row-field comment in lib/secret-contract.mjs) — it always falls
# through to the next tier, even when the string's own text parses as a full credential
# object (see the dedicated "CANON RULE 1" cell below, which pins that exact shape).
# CORRECTION (round-2): the claim that used to live here — that the OLD script's own
# `jq '.clientId // empty'` on a string primitive "errors and yields empty" — is only half
# right. Verified empirically (`git show origin/main:.../linear-comment-post.sh` run in a
# hermetic fixture): jq exits 5 trying to INDEX a string with `.clientId`, and under that
# script's own `set -euo pipefail` this is NOT a quiet per-tier fallthrough — it CRASHES the
# whole script (nonzero exit, comment never posted). "Falls through" is the canon this
# contract deliberately picks for BOTH engines instead (matches current JS, never aborts) —
# it is not a literal reproduction of the pre-fold script's crash. Fixture below updated to
# the row's real credential-object shape to keep exercising "distinct configJsonPath,
# resolved independently of orchestrator's" without contradicting the B1 fix.
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"w-cid","clientSecret":"w-csec"}}}}}' > "$L2_FILE"
_cell "config-json: reads the dotted path (linear-worker-actor, credential-object shape)" \
  '{"clientId":"w-cid","clientSecret":"w-csec"}|config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"
printf '%s' '{}' > "$L2_FILE"
_cell "config-json: linear-worker-actor absent path falls through to none" "|none|config-json" \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── linear-worker-actor: credentialEnvPair + legacyConfigTiers (CTL-1616 PR4) ────────────
# linear-comment-post.sh's THREE config tiers (NEW global bot.worker → OLD per-team agent →
# OLD global agent) + its env-credential-pair tier, folded onto this row. Precedence fixtures
# for ALL-TIERS-PRESENT / ONLY-LEGACY-PRESENT / ONLY-ENV-PRESENT / NOTHING-PRESENT (design
# §9 PR4 success criterion), proven byte-for-byte identical bash==JS — the point of this
# suite. Mirrored in lib/secret-contract.test.mjs and
# __tests__/catalyst-secret-contract.test.sh.
_cell "linear-worker-actor: only-env-present — credentialEnvPair wins" \
  '{"clientId":"EID","clientSecret":"ESEC"}|inherited|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" \
  "CATALYST_LINEAR_AGENT_CLIENT_ID=EID" "CATALYST_LINEAR_AGENT_CLIENT_SECRET=ESEC"

printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"CFG","clientSecret":"CFGSEC"}}}}}' > "$L2_FILE"
_cell "linear-worker-actor: credentialEnvPair with only ONE half set does not win — falls through to config" \
  '{"clientId":"CFG","clientSecret":"CFGSEC"}|config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" \
  "CATALYST_LINEAR_AGENT_CLIENT_ID=EID"

WA_REPO="${L2_DIR}/wa-repo"
mkdir -p "${WA_REPO}/.catalyst"
printf '%s' '{"catalyst":{"projectKey":"proj1"}}' > "${WA_REPO}/.catalyst/config.json"
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}}}}' > "${L2_DIR}/config-proj1.json"

printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"NEW","clientSecret":"NEWSEC"}},"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$L2_FILE"
_cell_in_dir "$WA_REPO" "linear-worker-actor: all-tiers-present — primary (NEW global bot.worker) wins" \
  '{"clientId":"NEW","clientSecret":"NEWSEC"}|config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{}' > "$L2_FILE"
_cell_in_dir "$WA_REPO" "linear-worker-actor: only-per-team-legacy-present — per-team tier wins" \
  '{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

WA_REPO2="${L2_DIR}/wa-repo2"
mkdir -p "${WA_REPO2}/.catalyst"
printf '%s' '{"catalyst":{"projectKey":"proj-no-file"}}' > "${WA_REPO2}/.catalyst/config.json"
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$L2_FILE"
_cell_in_dir "$WA_REPO2" "linear-worker-actor: only-global-legacy-present (own per-team file absent) — global-legacy tier wins" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

WA_NOANCESTRY="${L2_DIR}/wa-no-ancestry"
mkdir -p "$WA_NOANCESTRY"
_cell_in_dir "$WA_NOANCESTRY" "linear-worker-actor: no projectKey anywhere — per-team tier's own fallback-to-global-path still resolves a global-only legacy layout" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{}' > "$L2_FILE"
_cell_in_dir "$WA_NOANCESTRY" "linear-worker-actor: nothing-present — resolves to none" \
  "|none|config-json" \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── B1 REGRESSION FIXTURES (CTL-1616 PR4 remediation): the OLD linear-comment-post.sh
# advanced to the NEXT tier whenever clientId OR clientSecret was empty after a tier's read;
# canonicalizeConfigJsonValue's "any non-null value wins" rule let a CREDENTIAL-FREE or
# PARTIALLY-POPULATED object at a tier's path capture resolution instead, silently starving a
# deeper, fully-populated tier — the caller then hard-failed on the empty fields rather than
# falling through. Each fixture names the winning tier the OLD script would have picked (the
# deeper FULL-credential tier) and proves the fixed engine agrees. Mirrored byte-for-byte in
# lib/secret-contract.test.mjs and __tests__/catalyst-secret-contract.test.sh.
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"partial-cid"}}}}}' > "$L2_FILE"
_cell_in_dir "$WA_REPO" "B1: primary tier holds only clientId (no clientSecret) — per-team-legacy (full) wins" \
  '{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"webhookSecret":"whs","botUserId":"uuid-123"}}}}}' > "$L2_FILE"
_cell_in_dir "$WA_REPO" "B1: primary tier holds a CREDENTIAL-FREE object ({webhookSecret,botUserId}) — per-team-legacy (full) wins" \
  '{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

WA_REPO_NOAGENT="${L2_DIR}/wa-repo-noagent"
mkdir -p "${WA_REPO_NOAGENT}/.catalyst"
printf '%s' '{"catalyst":{"projectKey":"proj-noagent"}}' > "${WA_REPO_NOAGENT}/.catalyst/config.json"
# No config-proj-noagent.json file at all — the per-team-legacy tier's own file is absent.
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"","clientSecret":""}},"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$L2_FILE"
_cell_in_dir "$WA_REPO_NOAGENT" "B1: primary tier holds empty-string clientId/clientSecret — global-legacy (full) wins" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"pid-only"}}}}' > "${L2_DIR}/config-proj1.json"
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$L2_FILE"
_cell_in_dir "$WA_REPO" "B1: primary tier absent, per-team-legacy holds only clientId (no clientSecret) — global-legacy (full) wins" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"
# Restore config-proj1.json to its full-credential shape for the B2 fixture below.
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"TEAMAGENT","clientSecret":"TEAMAGENTSEC"}}}}' > "${L2_DIR}/config-proj1.json"

# ─── B2 REGRESSION FIXTURE: no prior fixture populated BOTH legacy tiers with DISTINCT
# credentials at once, so a swap of _CSC_LEGACY_TIERS's order survived every suite.
printf '%s' '{"catalyst":{"linear":{"agent":{"clientId":"GLOBALAGENT","clientSecret":"GLOBALAGENTSEC"}}}}' > "$L2_FILE"
_cell_in_dir "$WA_REPO" "B2: BOTH legacy tiers present with DISTINCT full credentials — per-team-legacy wins (pins tier order)" \
  '{"clientId":"TEAMAGENT","clientSecret":"TEAMAGENTSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── ROUND-2 B3 REGRESSION FIXTURES: the two proven cross-engine divergences on
# linear-worker-actor's requiredObjectFields gate (both empirically pinned against
# `git show origin/main:.../linear-comment-post.sh` in a hermetic fixture — see the
# requiredObjectFields row-field comment in lib/secret-contract.mjs for the two canon rules
# and their pre-fold empirical results). Mirrored byte-for-byte in
# __tests__/catalyst-secret-contract.test.sh and lib/secret-contract.test.mjs. Each fixture
# ALSO populates a real legacy tier so the assertion proves genuine FALL-THROUGH to a deeper
# tier on BOTH sides — not merely "resolves to none" (which a broken engine could also
# produce by a different, wrong path).
WA_NOANCESTRY_B3="${L2_DIR}/no-ancestry-b3"
mkdir -p "$WA_NOANCESTRY_B3"
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":"{\"clientId\":\"str-cid\",\"clientSecret\":\"str-csec\"}"},"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$L2_FILE"
_cell_in_dir "$WA_NOANCESTRY_B3" "CANON RULE 1: a bare STRING value at the primary tier — even one whose own text parses as a full credential object — falls through, never wins on string content" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

WA_NOANCESTRY_B3B="${L2_DIR}/no-ancestry-b3b"
mkdir -p "$WA_NOANCESTRY_B3B"
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"\n","clientSecret":"\n"}},"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$L2_FILE"
_cell_in_dir "$WA_NOANCESTRY_B3B" "CANON RULE 2: newline-only clientId/clientSecret at the primary tier falls through, never wins on raw non-zero length" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' \
  CSC_PROBE_ID=linear-worker-actor "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# CANON RULE 2, CR-ONLY variant (round-3 verify advisory A-CR-COVERAGE): a bash $()
# capture strips only trailing \n, NOT \r — the exact asymmetry the jq sub("[\r\n]+$")
# approach exists to close. Without this cell, reverting the bash field check to a
# $()-capture form survives the whole suite while diverging cross-engine on "\r".
WA_NOANCESTRY_B3C="${L2_DIR}/no-ancestry-b3c"
mkdir -p "$WA_NOANCESTRY_B3C"
printf '%s' '{"catalyst":{"linear":{"bot":{"worker":{"clientId":"\r","clientSecret":"\r"}},"agent":{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}}}}' > "$L2_FILE"
_cell_in_dir "$WA_NOANCESTRY_B3C" "CANON RULE 2 (CR-only): carriage-return-only fields fall through identically — pins the jq-side EOL strip against a \$()-capture regression" \
  '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}|legacy-config-json|config-json' \
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

# TRAILING NEWLINES IN JSON VALUES (Codex finding fix): a config-json STRING value ending in
# "\n" must resolve BYTE-FOR-BYTE identically on both sides — the bash side previously lost
# the trailing newline at the `_jq_out="$(jq ...)"` boundary (a bare command substitution
# strips ALL trailing newlines from its own captured output).
printf '%s' '{"groq":{"apiKey":"abc\n"}}' > "$L2_FILE"
_cell "hostile: trailing newline in a config-json STRING value is preserved byte-for-byte" \
  $'abc\n|config-json|config-json' \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# Byte-digest cross-check (independent of shell string-comparison quirks): compare a SHA-256
# digest of the raw resolved VALUE bytes on both sides — not just the pipe-joined field
# string, which can hide a byte-level truncation bug behind an apparently-matching test if
# the harness's OWN capture happened to mask it too.
JS_TRAILING_NL_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" CSC_PROBE_ID=groq-api-key node "$PROBE_RESOLVE_JS" 2>&1)"
BASH_TRAILING_NL_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" bash -c "source '$LIB'; catalyst_resolve_secret groq-api-key")"
JS_TRAILING_NL_VAL="${JS_TRAILING_NL_OUT%%|*}"
BASH_TRAILING_NL_VAL="${BASH_TRAILING_NL_OUT%%|*}"
JS_DIGEST="$(printf '%s' "$JS_TRAILING_NL_VAL" | shasum -a 256 | awk '{print $1}')"
BASH_DIGEST="$(printf '%s' "$BASH_TRAILING_NL_VAL" | shasum -a 256 | awk '{print $1}')"
expect_eq "byte-digest parity: trailing-newline config-json value SHA-256 matches" "$JS_DIGEST" "$BASH_DIGEST"

# INVALID ENV NAME (Codex finding fix): CATALYST_CLOUD_TOKEN_ENV / the Layer-2 tokenEnv
# override is operator-controlled text, not registry data — an invalid shell identifier
# (e.g. "BAD-NAME") must degrade to the documented unresolved result on BOTH sides, never a
# bash "invalid variable name" fatal abort (JS's `env?.[envVar]` never crashes on any string).
_cell "hostile: invalid env-name override (CATALYST_CLOUD_TOKEN_ENV) resolves none, never aborts" \
  "|none|platform-env" \
  CSC_PROBE_ID=cloud-token "CATALYST_CLOUD_TOKEN_ENV=BAD-NAME"

printf '%s' '{"catalyst":{"cloud":{"tokenEnv":"BAD-NAME-FROM-LAYER2"}}}' > "$L2_FILE"
_cell "hostile: invalid env-name Layer-2 override resolves none, never aborts" \
  "|none|platform-env" \
  CSC_PROBE_ID=cloud-token "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# JSON ACCEPTANCE NORMALIZATION (Codex finding fix): BOM-prefixed / multi-document / a
# lone-surrogate escape anywhere in the document must all settle @ABSENT-equivalent (none) on
# BOTH sides, matching JSON.parse's rejection of all three (jq natively tolerates a BOM and
# processes multiple top-level documents independently unless slurped).
BOM_L2_FILE="${L2_DIR}/bom-config.json"
printf '\xEF\xBB\xBF{"groq":{"apiKey":"should-not-resolve"}}' > "$BOM_L2_FILE"
_cell "hostile: BOM-prefixed Layer-2 file settles as none on both sides" \
  "|none|config-json" \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${BOM_L2_FILE}"

MULTIDOC_L2_FILE="${L2_DIR}/multidoc-config.json"
printf '{"groq":{"apiKey":"first-doc"}}{"groq":{"apiKey":"second-doc"}}' > "$MULTIDOC_L2_FILE"
_cell "hostile: multi-document Layer-2 file settles as none on both sides" \
  "|none|config-json" \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${MULTIDOC_L2_FILE}"

# The lone \ud800 escape lives in an UNRELATED field; groq.apiKey's own value is otherwise
# perfectly valid — jq rejects the ENTIRE document (verified: exit 5), so JS must degrade
# identically via its raw-text whole-document scan, not merely check the extracted field.
printf '%s' '{"groq":{"apiKey":"from-config"},"unrelated":"clu\ud800ster"}' > "$L2_FILE"
_cell "hostile: unpaired-surrogate escape ANYWHERE in the document settles as none on both sides" \
  "|none|config-json" \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# ─── E4/E6: jq 1.7.1 lone-LOW-surrogate + backslash-run-aware escape scanning parity ───────
# Verified against real jq 1.7.1 (jq-1.7.1-apple): jq ACCEPTS a lone LOW surrogate escape
# (\udc00), substituting U+FFFD and exiting 0 — it only REJECTS lone HIGH escapes (exit 5,
# the control case directly above). The escape text is authored via the BACKSLASH
# variable-expansion split (not a literal \uXXXX typed in this file's own source), matching
# this suite's and deployment-mode-parity.test.sh's existing hostile-cell convention — some
# authoring toolchains normalize a literal backslash-u sequence in a script's own source.
# shellcheck disable=SC1003 # genuinely a literal single backslash, not an escape attempt
BACKSLASH='\'

# E4a: a lone LOW surrogate escape in an UNRELATED field must NOT reject the document — the
# real value at groq.apiKey resolves normally on both sides.
printf '%s' "{\"groq\":{\"apiKey\":\"good\"},\"unrelated\":\"clu${BACKSLASH}udc00ster\"}" > "$L2_FILE"
_cell "E4a: lone LOW surrogate escape in an unrelated field — value resolves normally on both sides" \
  "good|config-json|config-json" \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# E4b: a lone LOW surrogate escape INSIDE the resolved secret value itself — both engines
# must produce the SAME bytes (jq's U+FFFD replacement), verified two ways: the pipe-joined
# field string AND an independent SHA-256 byte-digest cross-check (mirrors the
# trailing-newline byte-digest check above — a shell string-comparison quirk could otherwise
# mask a byte-level divergence that the digest cannot).
printf '%s' "{\"groq\":{\"apiKey\":\"x${BACKSLASH}udc00y\"}}" > "$L2_FILE"
_cell "E4b: lone LOW surrogate escape inside the secret value — U+FFFD-replaced, resolved (not rejected)" \
  $'x\xef\xbf\xbdy|config-json|config-json' \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"
JS_E4B_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" CSC_PROBE_ID=groq-api-key node "$PROBE_RESOLVE_JS" 2>&1)"
BASH_E4B_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" bash -c "source '$LIB'; catalyst_resolve_secret groq-api-key")"
JS_E4B_VAL="${JS_E4B_OUT%%|*}"
BASH_E4B_VAL="${BASH_E4B_OUT%%|*}"
JS_E4B_DIGEST="$(printf '%s' "$JS_E4B_VAL" | shasum -a 256 | awk '{print $1}')"
BASH_E4B_DIGEST="$(printf '%s' "$BASH_E4B_VAL" | shasum -a 256 | awk '{print $1}')"
expect_eq "E4b byte-digest parity: lone-LOW-surrogate U+FFFD replacement SHA-256 matches" "$JS_E4B_DIGEST" "$BASH_E4B_DIGEST"

# E6: a field holding the LITERAL 7-character text \\ud800 (an escaped backslash followed by
# the 5 literal characters "ud800") — valid JSON both parsers accept, and NOT a live escape
# at all (the backslash run before "u" is length 2, EVEN — both backslashes pair off as one
# escaped literal backslash, leaving "ud800" as ordinary text). A backslash-run-BLIND scanner
# false-positives on the bare "\ud800" substring inside that literal text and rejects the
# WHOLE document even though jq parses it fine and groq.apiKey resolves normally.
printf '%s' "{\"groq\":{\"apiKey\":\"good\"},\"unrelated\":\"literal ${BACKSLASH}${BACKSLASH}ud800 text\"}" > "$L2_FILE"
_cell "E6: literal escaped-backslash+text (not a live escape) in an unrelated field does not reject the document" \
  "good|config-json|config-json" \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

# Control: a valid astral surrogate PAIR (𐀀, forming U+10000) is accepted and
# resolved, byte-for-byte, on both sides — the scanner's adjacent-live-pair acceptance path.
printf '%s' "{\"groq\":{\"apiKey\":\"x${BACKSLASH}ud800${BACKSLASH}udc00y\"}}" > "$L2_FILE"
_cell "control: valid astral surrogate pair resolves (accepted, not rejected) on both sides" \
  $'x\xf0\x90\x80\x80y|config-json|config-json' \
  CSC_PROBE_ID=groq-api-key "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}"

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

# ─── cloud guard RECOGNIZED extension (CTL-1616 PR6, design §12 Q3 belt-and-suspenders) ────
# `recognized !== false` is ADDITIVE to the inferred check — a hand-constructed deploymentMode
# with recognized:false must NOT activate cloud even when mode=cloud/inferred=false; omitting
# or explicitly setting recognized:true must activate cloud exactly as before this PR.
_cell "cloud guard: recognized=false does NOT activate cloud (even with mode=cloud, inferred=false)" \
  "file-value|shared-file|bare-file" \
  CSC_PROBE_ID=github-token "CATALYST_CONFIG_DIR=${CLOUDGUARD_DIR}" "GH_TOKEN=env-value-should-not-win" \
  CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false CSC_PROBE_DEP_RECOGNIZED=false
_cell "cloud guard: recognized=true (explicit) activates cloud exactly like recognized omitted" \
  "||bare-file" CSC_PROBE_ID=github-token "GH_TOKEN=should-not-be-returned" \
  CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false CSC_PROBE_DEP_RECOGNIZED=true

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

# CLOUD-TOKEN NAME OVERRIDE (Codex finding fix): genuine cloud mode must resolve cloud-token
# THROUGH the full name-override ladder (env override → Layer-2 override → default), not
# only the hardcoded default env-var name — a direct resolveSecret("cloud-token",
# {deploymentMode}) call previously bypassed that ladder entirely on both sides.
_cell "cloud-token: genuine cloud mode honors CATALYST_CLOUD_TOKEN_ENV override" \
  "the-real-token|platform-env|platform-env" \
  CSC_PROBE_ID=cloud-token "CATALYST_CLOUD_TOKEN_ENV=MY_PLATFORM_TOKEN" "MY_PLATFORM_TOKEN=the-real-token" \
  CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false

printf '%s' '{"catalyst":{"cloud":{"tokenEnv":"OTHER_TOKEN_VAR"}}}' > "$L2_FILE"
_cell "cloud-token: genuine cloud mode honors the Layer-2 catalyst.cloud.tokenEnv override too" \
  "v2|platform-env|platform-env" \
  CSC_PROBE_ID=cloud-token "CATALYST_LAYER2_CONFIG_FILE=${L2_FILE}" "OTHER_TOKEN_VAR=v2" \
  CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false

_cell "cloud-token: override name genuinely consulted in cloud mode — the default var being set does NOT resolve it" \
  "|none|platform-env" \
  CSC_PROBE_ID=cloud-token "CATALYST_CLOUD_TOKEN_ENV=MY_PLATFORM_TOKEN" "CATALYST_CLOUD_TOKEN=should-not-be-used" \
  CSC_PROBE_DEP_MODE=cloud CSC_PROBE_DEP_INFERRED=false

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES, Skipped: $SKIPPED"
exit "$FAILURES"
