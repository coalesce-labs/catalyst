#!/usr/bin/env bash
# lib/catalyst-secret-contract.sh — CTL-1616: bash mirror of lib/secret-contract.mjs's
# SECRET_REGISTRY + resolution engine. Bash cannot import the JS leaf, so this is a SECOND,
# independently-maintained implementation of the same registry data and provider-type
# dispatch — kept honest by the fixture-matrix cross-stack parity test at
# __tests__/secret-contract-parity.test.sh (the same `node --input-type=module` mechanism
# __tests__/deployment-mode-parity.test.sh already proves out in CI).
#
# THIS PR IS THE FIRST ISOLATION SLICE — ZERO CONSUMERS. Nothing sources this file except
# its own tests. lib/catalyst-secret-env.sh's catalyst_project_github_token/_webhook_secret
# and execution-core/cluster-sync.mjs's isEnvBackedSecretFile are left untouched — re-pointing
# them onto this registry is later-migration-plan work.
#
# Depends only on bash + jq (jq only for the config-json/platform-env-name rows — every other
# delivery type is pure bash/coreutils). bash >= 3.2 compatible (no ${var,,}, no
# `declare -A`) — matches lib/catalyst-deployment-mode.sh's own compatibility bar.
#
# Idempotent-source guard — safe to source multiple times.
[[ -n "${_CATALYST_SECRET_CONTRACT_SH_LOADED:-}" ]] && return 0
_CATALYST_SECRET_CONTRACT_SH_LOADED=1

# ─── The registry, as parallel indexed arrays (no declare -A — bash 3.2 parity with the
# rest of this codebase's lib/*.sh) ──────────────────────────────────────────────────────
#
# Row order and content MUST mirror SECRET_REGISTRY in lib/secret-contract.mjs exactly — the
# parity test's row-id-set-equality assertion fails loudly if the two drift.
_CSC_IDS=(
  "github-token" "webhook-secret" "linear-webhook-secret" "claude-accounts.env"
  "execution-core.env" "execution-core-secrets.env" "linear-api-token" "linear-orchestrator-actor" "linear-worker-actor"
  "groq-api-key" "cloud-token" "age-key"
)
_CSC_DELIVERY=(
  "bare-file" "bare-file" "bare-file-family" "env-file" "env-file" "env-file" "env-alias" "config-json"
  "config-json" "config-json" "platform-env" "local-only"
)
# Space-joined env-name lists (env var names never contain spaces, so this is a safe
# poor-man's array-in-a-string; split with `read -ra` / a for-loop, never re-quoted as a
# single token).
_CSC_ENV_NAMES=(
  "GH_TOKEN GITHUB_TOKEN" "CATALYST_WEBHOOK_SECRET" "" "" "" "" "LINEAR_API_TOKEN LINEAR_API_KEY"
  "" "" "GROQ_API_KEY" "CATALYST_CLOUD_TOKEN" "SOPS_AGE_KEY_FILE"
)
_CSC_CONFIG_JSON_PATH=(
  "" "" "" "" "" "" "" "catalyst.linear.bot.orchestrator" "catalyst.linear.bot.worker"
  "groq.apiKey" "catalyst.cloud.tokenEnv" ""
)
_CSC_ROTATION_CLASS=(
  "re-armable" "boot-only" "boot-only" "re-armable" "boot-only" "boot-only" "re-armable" "re-armable"
  "boot-only" "boot-only" "boot-only" "n/a"
  # index 3 (claude-accounts.env): CTL-1984 reclassified boot-only → re-armable/timer
)
_CSC_ROTATION_TRIGGER=(
  "timer" "" "" "timer" "" "" "on-401" "on-401" "" "" "" ""
  # index 3 (claude-accounts.env): CTL-1984 — timer trigger mirrors github-token wiring
)
_CSC_BOOTSTRAP_FOR=(
  "" "" "" "" "" "" "" "" "" "" "cloud" "cluster"
)
_CSC_FAMILY_PREFIX=(
  "" "" "linear-webhook-secret-" "" "" "" "" "" "" "" "" ""
)
_CSC_DEFAULT_LOCAL_PATH=(
  "" "" "" "" "" "" "" "" "" "" "" ".config/catalyst/age.key"
)
# CTL-1616 PR4 (append-only, linear-worker-actor only): the env-credential-pair tier
# ("IDVAR:SECRETVAR") and the two legacy config-json fallback tiers
# ("scope:path|scope:path"), mirroring secret-contract.mjs's credentialEnvPair/
# legacyConfigTiers row fields exactly. Empty string for every row that doesn't declare one.
_CSC_CREDENTIAL_ENV_PAIR=(
  "" "" "" "" "" "" "" "" "CATALYST_LINEAR_AGENT_CLIENT_ID:CATALYST_LINEAR_AGENT_CLIENT_SECRET" "" "" ""
)
_CSC_LEGACY_TIERS=(
  "" "" "" "" "" "" "" "" "per-team-legacy:catalyst.linear.agent|global-legacy:catalyst.linear.agent" "" "" ""
)
# _CSC_REQUIRED_OBJECT_FIELDS — CTL-1616 PR4 remediation (B1 fix). Space-joined field names
# a row's OBJECT-shaped config-json value must hold, ALL non-empty, before a tier is allowed
# to WIN — mirrors secret-contract.mjs's row-declared requiredObjectFields exactly (a
# generic, row-declared gate, never a hardcoded id check). Empty string for every row that
# doesn't declare one (only linear-worker-actor does today).
_CSC_REQUIRED_OBJECT_FIELDS=(
  "" "" "" "" "" "" "" "" "clientId clientSecret" "" "" ""
)

# catalyst_secret_required_object_fields ID — echoes the space-joined required field list
# (may echo nothing).
catalyst_secret_required_object_fields() {
  local _i
  _i="$(_csc_index_of "$1")" || { printf ''; return 1; }
  printf '%s' "${_CSC_REQUIRED_OBJECT_FIELDS[$_i]}"
}

# catalyst_secret_credential_env_pair ID — echoes "IDVAR SECRETVAR" (space-joined) or nothing.
catalyst_secret_credential_env_pair() {
  local _i _v
  _i="$(_csc_index_of "$1")" || return 1
  _v="${_CSC_CREDENTIAL_ENV_PAIR[$_i]}"
  [[ -n "$_v" ]] && printf '%s' "${_v/:/ }"
  return 0
}

# catalyst_secret_legacy_tiers ID — prints one "scope|configJsonPath" per line, in order
# (may print nothing).
catalyst_secret_legacy_tiers() {
  local _i _v _tier
  _i="$(_csc_index_of "$1")" || return 1
  _v="${_CSC_LEGACY_TIERS[$_i]}"
  [[ -n "$_v" ]] || return 0
  local -a _tiers=()
  IFS='|' read -r -a _tiers <<< "$_v"
  for _tier in "${_tiers[@]}"; do
    printf '%s\n' "${_tier/:/|}"
  done
}

# _csc_index_of ID — echoes the row index or returns 1 (never prints on miss).
_csc_index_of() {
  local _id="$1" _i
  for _i in "${!_CSC_IDS[@]}"; do
    [[ "${_CSC_IDS[$_i]}" == "$_id" ]] && { printf '%s' "$_i"; return 0; }
  done
  return 1
}

catalyst_secret_registry_ids() {
  printf '%s\n' "${_CSC_IDS[@]}"
}

catalyst_secret_delivery() {
  local _i
  _i="$(_csc_index_of "$1")" || { printf ''; return 1; }
  printf '%s' "${_CSC_DELIVERY[$_i]}"
}

catalyst_secret_rotation_class() {
  local _i
  _i="$(_csc_index_of "$1")" || { printf ''; return 1; }
  printf '%s' "${_CSC_ROTATION_CLASS[$_i]}"
}

catalyst_secret_rotation_trigger() {
  local _i
  _i="$(_csc_index_of "$1")" || { printf ''; return 1; }
  printf '%s' "${_CSC_ROTATION_TRIGGER[$_i]}"
}

catalyst_secret_bootstrap_for() {
  local _i
  _i="$(_csc_index_of "$1")" || { printf ''; return 1; }
  printf '%s' "${_CSC_BOOTSTRAP_FOR[$_i]}"
}

catalyst_secret_config_json_path() {
  local _i
  _i="$(_csc_index_of "$1")" || { printf ''; return 1; }
  printf '%s' "${_CSC_CONFIG_JSON_PATH[$_i]}"
}

catalyst_secret_family_prefix() {
  local _i
  _i="$(_csc_index_of "$1")" || { printf ''; return 1; }
  printf '%s' "${_CSC_FAMILY_PREFIX[$_i]}"
}

# catalyst_secret_env_names ID — prints one env-var name per line (may print nothing).
#
# B1 FIX (verified regression): the previous implementation did `printf '%s\n' $_names` —
# an UNQUOTED expansion that relies on the CALLER's ambient $IFS containing a space to
# split "GH_TOKEN GITHUB_TOKEN" back into two words. A caller that sources this file under
# the common strict-shell IFS=$'\n\t' (no space in it — the SAME class of bug
# lib/catalyst-deployment-mode.sh's own header documents for its mode enum) gets NO
# splitting at all: $_names arrives as ONE token "GH_TOKEN GITHUB_TOKEN" containing an
# embedded space, and _csc_resolve_env_alias_only's `${!_name-}` indirect expansion then
# tries to use that whole string as a variable name — bash FATALLY aborts with "invalid
# variable name", killing the caller's entire process, not just this lookup. `IFS=' ' read
# -ra` below scopes the space-IFS to ONLY this one `read` invocation (a prefix assignment
# on a single command does not leak to the rest of the function or its caller), so
# splitting is correct regardless of what IFS the sourcing script has set. See
# __tests__/catalyst-secret-contract.test.sh's "strict IFS" regression cell.
catalyst_secret_env_names() {
  local _i _names
  _i="$(_csc_index_of "$1")" || return 1
  _names="${_CSC_ENV_NAMES[$_i]}"
  if [[ -n "$_names" ]]; then
    local -a _arr=()
    IFS=' ' read -r -a _arr <<< "$_names"
    printf '%s\n' "${_arr[@]}"
  fi
  return 0
}

# isSecretFamilyMember mirror — absorbed verbatim from cluster-sync.mjs's
# isEnvBackedSecretFile/LINEAR_WEBHOOK_SECRET_PREFIX (see lib/secret-contract.mjs's own
# isSecretFamilyMember docstring for the full provenance). Case-insensitive; requires at
# least one character after the dash. Lowercase via `tr` (bash 3.2-safe; ${var,,} is bash 4+).
catalyst_secret_is_family_member() {
  local _file="$1" _prefix _name
  [[ -n "$_file" ]] || return 1
  _prefix="$(catalyst_secret_family_prefix "linear-webhook-secret")"
  [[ -n "$_prefix" ]] || _prefix="linear-webhook-secret-"
  _name="$(printf '%s' "$_file" | tr '[:upper:]' '[:lower:]')"
  case "$_name" in
    "${_prefix}"?*) return 0 ;;
    *) return 1 ;;
  esac
}

# ─── Layer-2 path resolution — the §2 canonical chain (DELIBERATELY NOT
# catalyst-deployment-mode.sh's chain — see lib/secret-contract.mjs's resolveLayer2Path
# docstring for why these are two different resolvers) ───────────────────────────────────
# CATALYST_LAYER2_CONFIG_FILE > CATALYST_MACHINE_CONFIG > $XDG_CONFIG_HOME/catalyst/config.json
# > ~/.config/catalyst/config.json
catalyst_secret_resolve_layer2_path() {
  if [[ -n "${CATALYST_LAYER2_CONFIG_FILE:-}" ]]; then
    printf '%s' "$CATALYST_LAYER2_CONFIG_FILE"
    return 0
  fi
  if [[ -n "${CATALYST_MACHINE_CONFIG:-}" ]]; then
    printf '%s' "$CATALYST_MACHINE_CONFIG"
    return 0
  fi
  # HOME fallback (parity with lib/catalyst-deployment-mode.sh's own HOME-unset lesson): a
  # bare "${HOME:-}" would silently probe /.config/catalyst/config.json on a HOME-less
  # service environment instead of the real per-user default.
  local _home="${HOME-}"
  [[ -z "$_home" ]] && _home=~
  local _xdg="${XDG_CONFIG_HOME:-${_home}/.config}"
  printf '%s' "${_xdg}/catalyst/config.json"
}

# _csc_b64_decode B64 — decode a base64 string to raw bytes on stdout. macOS/BSD base64 and
# GNU coreutils base64 both accept -d; -D is BSD's long-standing alias, tried as a fallback
# for any base64 build that only recognizes the BSD spelling. Never fails the caller (a
# malformed/empty input decodes to empty output either way).
_csc_b64_decode() {
  local _in="$1"
  if printf '%s' "$_in" | base64 -d 2>/dev/null; then
    return 0
  fi
  printf '%s' "$_in" | base64 -D 2>/dev/null
}

# _csc_b64_decode_var VARNAME B64 — decodes B64 into VARNAME. Deliberately NOT
# `VARNAME="$(_csc_b64_decode "$B64")"` — that bare $() capture would strip ANY trailing
# newline byte off the DECODED value itself (the value is the ENTIRE output of that specific
# command substitution), reintroducing the exact TRAILING-NEWLINE bug this base64 encoding
# exists to fix, one boundary later. `read -d ''` over a process substitution captures every
# byte up to an explicit NUL terminator WITHOUT the trailing-newline-stripping $() performs —
# safe here because jq already rejects any NUL-containing value before base64-encoding it
# (see _csc_read_json_string), so the decoded bytes are guaranteed NUL-free, the one byte
# `read -d ''` cannot represent.
_csc_b64_decode_var() {
  local _varname="$1" _b64="$2"
  IFS= read -r -d '' "$_varname" < <(_csc_b64_decode "$_b64"; printf '\0')
}

# _csc_read_json_string FILE DOTTED_PATH — tagged jq read of a field, mirroring the
# type-aware tagged extraction in lib/catalyst-deployment-mode.sh's
# _catalyst_deployment_mode_from_file (the "a bare `// empty` swallows JSON `false`" lesson —
# a config-json row whose value is `false`/123/an array must settle as ABSENT-to-this-caller,
# never silently coerced to a string). Tags:
#   @ABSENT    — path missing, file unreadable/malformed, jq unavailable, value is JSON null,
#                a BOM-prefixed file, or a multi-document file (see BOM/MULTI-DOC below)
#   @STR64:xxx — value is a JSON STRING, base64-encoded as xxx (see TRAILING-NEWLINE FIX
#                below for why base64, not the value verbatim). xxx MAY decode to the empty
#                string — no `select` filters that out; callers needing "present AND
#                non-empty" check the DECODED length explicitly (see _csc_resolve_config_json
#                / _csc_resolve_cloud_token_name), mirroring lib/secret-contract.mjs's own
#                `raw.length > 0` checks at the equivalent call sites.
#   @OBJ64:xxx — value is a JSON OBJECT, canonicalized (recursively sorted-key, matching
#                lib/secret-contract.mjs's canonicalJsonStringify byte-for-byte) and
#                base64-encoded as xxx (design §2 finding fix: catalyst.linear.bot.
#                orchestrator/.worker store OBJECTS, not strings — see
#                _csc_resolve_config_json, the ONLY caller that accepts this tag;
#                _csc_resolve_cloud_token_name deliberately does NOT, since a NAME override
#                can only ever be a plain string).
#   @NONSTR    — value is present but is an array/boolean/number, OR a string/object whose
#                canonical form carries an embedded NUL (see the NUL-BYTE note below) — never
#                treated as a usable secret.
# Never fails the caller (always echoes a tag, even "@ABSENT" on any error).
#
# TRAILING-NEWLINE FIX (Codex finding fix): the OLD implementation returned the tagged value
# VERBATIM ("@STR:" + $v) through `_jq_out="$(jq ...)"` — and $() strips ALL trailing
# newlines from its OWN captured output. A value like "abc\n" is the LAST thing printed (tag
# then value), so its trailing byte WAS the captured string's trailing byte, and $() silently
# truncated it to "abc" — while lib/secret-contract.mjs's JSON.parse preserves every byte.
# Base64-encoding the value inside jq means the captured string's own trailing byte is
# alphanumeric/+//= — NEVER a newline — so nothing is stripped; decoding afterward recovers
# the exact original bytes, including any trailing newline.
#
# BOM SNIFF (parity, mirrors lib/catalyst-deployment-mode.sh's identical fix verbatim): this
# jq build tolerates a UTF-8 BOM at the start of input; JSON.parse rejects one. A
# BOM-prefixed Layer-2 file must settle @ABSENT (layer-malformed) on BOTH sides.
#
# --slurp / MULTI-DOCUMENT (parity, mirrors catalyst-deployment-mode.sh): jq without -s
# processes each top-level JSON value in a file independently — a file holding TWO valid
# documents exits 0 and emits two tags (garbage once collapsed through the $() boundary
# below), while JSON.parse rejects the whole file (trailing-content SyntaxError). Slurping
# collapses that to one array whose length exposes the multi-document case (length != 1 →
# @ABSENT) — a single document is unaffected (length == 1, .[0] is that one document).
_csc_read_json_string() {
  local _f="$1" _path="$2" _jq_out _jq_rc
  [[ -r "$_f" ]] || { printf '@ABSENT'; return 0; }
  command -v jq >/dev/null 2>&1 || { printf '@ABSENT'; return 0; }
  local _first3
  _first3="$(head -c 3 "$_f" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  if [[ "$_first3" == "efbbbf" ]]; then
    printf '@ABSENT'
    return 0
  fi
  # ERREXIT SAFETY: the assignment runs in an `if` condition so a nonzero jq exit cannot
  # abort a caller running under `set -e`/inherit_errexit.
  # NUL-BYTE CANDIDATE: a bash command substitution silently TRUNCATES an embedded NUL byte,
  # so a raw value with an embedded NUL between "c" and "loud" would otherwise arrive at the
  # caller already collapsed to a DIFFERENT (truncated) string than what jq/JS actually saw.
  # Detect it INSIDE jq (mirrors lib/catalyst-deployment-mode.sh's identical fix) and settle
  # it as @NONSTR before it ever crosses the $() boundary. Applied identically to the
  # canonicalized OBJECT form (see @OBJ64 above) via the same $canon-carrying branch.
  if _jq_out="$(jq -rs --arg p "$_path" '
    if length != 1 then "@ABSENT" else .[0] |
    (getpath($p | split("."))) as $v |
    if $v == null then "@ABSENT"
    elif ($v | type) == "string" then
      (if ($v | contains([0] | implode)) then "@NONSTR" else "@STR64:" + ($v | @base64) end)
    elif ($v | type) == "object" then
      ($v | walk(if type == "object" then to_entries | sort_by(.key) | from_entries else . end) | tojson) as $canon |
      (if ($canon | contains([0] | implode)) then "@NONSTR" else "@OBJ64:" + ($canon | @base64) end)
    else "@NONSTR"
    end
    end
  ' "$_f" 2>/dev/null)"; then
    _jq_rc=0
  else
    _jq_rc=$?
  fi
  [[ $_jq_rc -eq 0 ]] || { printf '@ABSENT'; return 0; }
  printf '%s' "$_jq_out"
}

# ─── Bare-file candidate search — generalizes catalyst-secret-env.sh's _catalyst_secret_dirs
# / github-auth-preflight.mjs's githubTokenFileCandidates to any row's basename ────────────

# catalyst_secret_explicit_file_override_var ID — mirrors explicitFileOverrideEnvName in
# lib/secret-contract.mjs: uppercase, replace every run of non-alnum with ONE underscore
# (tr -s squeezes consecutive substitutions from -c into a single underscore, matching the
# JS regex's `+` quantifier).
catalyst_secret_explicit_file_override_var() {
  local _upper
  _upper="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_' | tr -s '_')"
  # Strip a leading/trailing underscore artifact from tr -c mapping a leading/trailing
  # non-alnum char — none of the registry ids have one, but this keeps the helper honest for
  # any future id that might.
  _upper="${_upper#_}"
  _upper="${_upper%_}"
  printf 'CATALYST_%s_FILE' "$_upper"
}

# catalyst_secret_candidates ID — prints the bare-file candidate search chain, one per line,
# in priority order: explicit override → CATALYST_CONFIG_DIR → cluster-sync's own destination
# dir → XDG dir. Mirrors secretFileCandidates(id, env) exactly.
catalyst_secret_candidates() {
  local _id="$1" _override_var _override
  _override_var="$(catalyst_secret_explicit_file_override_var "$_id")"
  _override="${!_override_var:-}"
  if [[ -n "$_override" ]]; then
    printf '%s\n' "$_override"
    return 0
  fi
  if [[ -n "${CATALYST_CONFIG_DIR:-}" ]]; then
    printf '%s/%s\n' "$CATALYST_CONFIG_DIR" "$_id"
    return 0
  fi
  local _home="${HOME-}"
  [[ -z "$_home" ]] && _home=~
  local _l2="${CATALYST_LAYER2_CONFIG_FILE:-${_home}/.config/catalyst/config.json}"
  local _c1
  _c1="$(dirname "$_l2")/${_id}"
  local _xdg_base="${XDG_CONFIG_HOME:-${_home}/.config}"
  local _c2="${_xdg_base}/catalyst/${_id}"
  printf '%s\n' "$_c1"
  [[ "$_c2" != "$_c1" ]] && printf '%s\n' "$_c2"
  return 0
}

# _csc_strip_eol / _csc_is_blank / _csc_contains_nul — self-contained equivalents of
# _catalyst_strip_eol / _catalyst_is_blank (lib/catalyst-secret-env.sh). Deliberately NOT
# sourced from that file — this pair stays a self-contained leaf (design §2's "one new pair
# of zero-import leaves"), and duplicating three small primitives is cheaper than coupling
# two independently-owned files. _csc_is_blank uses an EXPLICIT ASCII whitespace set, not
# [[:space:]] — the CTL-1617 locale lesson: [[:space:]] is LOCALE DATA (macOS classifies NBSP
# as space under a UTF-8 locale; a C-locale Linux runner does not), so the same file would
# blank-check differently per host under the locale-dependent class.
_csc_strip_eol() {
  local s="$1"
  while [[ "$s" == *$'\n' || "$s" == *$'\r' ]]; do
    s="${s%$'\n'}"
    s="${s%$'\r'}"
  done
  printf '%s' "$s"
}
_csc_is_blank() {
  local _v="$1" _ws=$' \t\n\v\f\r'
  [[ -z "${_v//["$_ws"]/}" ]]
}
# _csc_contains_nul FILE — true iff FILE's bytes contain an embedded NUL. PARITY GUARD
# (generalizes the JSON-field NUL lesson to raw file bytes): `$(cat "$file")` truncates at
# the first NUL, so without this check a NUL-containing file would resolve to a silently
# TRUNCATED value here while lib/secret-contract.mjs's readFileSync sees the full byte
# string — two different "resolved" values for the same file.
#
# WHY NOT `grep -q $'\x00'`: a NUL byte can never survive as a literal argv byte at all —
# execve() arguments are themselves NUL-terminated C strings, so `$'\x00'` is silently
# dropped to an EMPTY bash string before grep ever sees it, and `grep -q ""` (an empty
# pattern) matches unconditionally — every file would wrongly report "contains NUL" and
# every bare-file candidate would be skipped. This is the SAME "NUL dies at a boundary"
# class the JSON-field lesson names, one boundary earlier (argv, not $()).
#
# The fix routes around the boundary instead of trying to cross it: `tr`'s own operand
# parser (not bash, not execve) interprets the 4 literal characters `\`, `0`, `0`, `0` as an
# octal escape for the NUL byte — portable POSIX `tr` behavior on both GNU and BSD — so
# `tr -d '\000'` can delete every NUL from the file's byte stream without a real NUL ever
# needing to exist as a shell argument. Comparing byte counts before/after then detects
# whether anything was deleted, entirely via `wc -c`, which is itself NUL-safe (it counts
# bytes, never treats one as a string terminator).
_csc_contains_nul() {
  local _f="$1" _orig _stripped
  [[ -r "$_f" ]] || return 1
  _orig="$(wc -c < "$_f" 2>/dev/null)" || return 1
  _stripped="$(LC_ALL=C tr -d '\000' < "$_f" 2>/dev/null | wc -c)" || return 1
  [[ "$_orig" -ne "$_stripped" ]]
}

# _csc_is_valid_utf8 FILE — true iff every byte in FILE forms valid UTF-8. PARITY GUARD
# (Codex finding fix, generalizes the NUL-byte lesson above to the FULL byte-validity
# question): Node's readFileSync(file, "utf8") REPLACES any invalid UTF-8 byte sequence with
# U+FFFD rather than failing, so lib/secret-contract.mjs's JS side would silently decode a
# bare-file secret containing a stray non-UTF-8 byte (e.g. a leading 0xFF 0xFE) into a
# MUTATED credential, while this file's `cat` preserves the original bytes exactly — two
# different "resolved" values for the same file. Neither behavior is safe to prefer: a
# credential that cannot round-trip UTF-8 identically cannot be represented identically in
# both engines, so BOTH sides REJECT the candidate (falls through to the next candidate,
# same degrade shape as the NUL-byte guard) rather than one silently serving a mutated view.
# `iconv -f UTF-8 -t UTF-8` is a standard, portable (GNU + BSD/macOS) round-trip validity
# check: it exits non-zero the instant it hits a byte sequence that cannot be interpreted as
# UTF-8, without ever needing to hold the (possibly credential-bearing) decoded text in a
# shell variable.
_csc_is_valid_utf8() {
  local _f="$1"
  [[ -r "$_f" ]] || return 1
  command -v iconv >/dev/null 2>&1 || return 0
  iconv -f UTF-8 -t UTF-8 "$_f" >/dev/null 2>&1
}

# catalyst_secret_read_first_nonblank_file — tries each of "$@" in order; on the first
# readable, non-NUL, non-blank (after EOL-strip) candidate, prints the value and returns 0.
# Prints nothing and returns 1 if no candidate qualifies. (Deliberately does NOT report which
# candidate won via a global — this is always called through $(...) by its one caller below,
# and a global set inside a command-substitution subshell would be discarded before the
# caller could read it; see the SUBSHELL-EXPORT CAVEAT on _csc_resolve_config_json for the
# general shape of that trap.)
catalyst_secret_read_first_nonblank_file() {
  local _f _raw _val
  for _f in "$@"; do
    [[ -r "$_f" ]] || continue
    _csc_contains_nul "$_f" && continue
    _csc_is_valid_utf8 "$_f" || continue
    _raw="$(cat "$_f" 2>/dev/null)" || continue
    _val="$(_csc_strip_eol "$_raw")"
    if ! _csc_is_blank "$_val"; then
      printf '%s' "$_val"
      return 0
    fi
  done
  return 1
}

# ─── Per-delivery-type resolvers ─────────────────────────────────────────────────────────
# Every _csc_resolve_* function sets CATALYST_SECRET_LAST_VALUE / _SOURCE / _PROVIDER and
# echoes "value|source|provider" (empty fields when unresolved) — mirroring the
# lib/catalyst-deployment-mode.sh probe-output convention the parity test already exercises.

_csc_set_result() {
  # Exported side-channel breadcrumbs (mirrors CATALYST_DEPLOYMENT_MODE_RESOLVED's
  # convention in lib/catalyst-deployment-mode.sh) — a future consumer (not this PR) reads
  # these after calling catalyst_resolve_secret without needing to reparse the pipe-joined
  # stdout. Unused WITHIN this file itself, hence the shellcheck disable.
  # shellcheck disable=SC2034
  CATALYST_SECRET_LAST_VALUE="$1"
  # shellcheck disable=SC2034
  CATALYST_SECRET_LAST_SOURCE="$2"
  # shellcheck disable=SC2034
  CATALYST_SECRET_LAST_PROVIDER="$3"
  # SECRET HYGIENE (#2924 post-merge Codex P2): the VALUE is deliberately NOT
  # exported — every reader is same-shell, and an exported value would be
  # inherited by every child of a long-lived daemon shell (catalyst-broker /
  # catalyst-execution-core launch their runtimes from the resolving shell),
  # putting the credential in each child's environment. The non-secret
  # SOURCE/PROVIDER breadcrumbs stay exported for logging convenience.
  # Bash's export attribute is STICKY across reassignment (#2925 post-merge
  # Codex P2): a shell that inherited the variable already-exported (rolling
  # upgrade from the pre-fix lib, or any caller's own export) would keep
  # leaking the NEW value — so the attribute is cleared explicitly each time.
  export -n CATALYST_SECRET_LAST_VALUE 2>/dev/null || true
  export CATALYST_SECRET_LAST_SOURCE CATALYST_SECRET_LAST_PROVIDER
  printf '%s|%s|%s' "$1" "$2" "$3"
}

_csc_resolve_env_alias_only() {
  local _id="$1" _delivery _name _val
  _delivery="$(catalyst_secret_delivery "$_id")"
  while IFS= read -r _name; do
    [[ -n "$_name" ]] || continue
    _val="${!_name-}"
    if [[ -n "$_val" ]]; then
      _csc_set_result "$_val" "inherited" "$_delivery"
      return 0
    fi
  done < <(catalyst_secret_env_names "$_id")
  _csc_set_result "" "none" "$_delivery"
}

_csc_resolve_bare_file() {
  local _id="$1" _delivery _override_var _override _val _c
  _delivery="$(catalyst_secret_delivery "$_id")"
  _override_var="$(catalyst_secret_explicit_file_override_var "$_id")"
  _override="${!_override_var:-}"
  local -a _cands=()
  while IFS= read -r _c; do [[ -n "$_c" ]] && _cands+=("$_c"); done < <(catalyst_secret_candidates "$_id")
  if _val="$(catalyst_secret_read_first_nonblank_file "${_cands[@]}")"; then
    local _source="shared-file"
    [[ -n "$_override" ]] && _source="operator-override"
    _csc_set_result "$_val" "$_source" "$_delivery"
    return 0
  fi
  # Fall back to an inherited env alias, matching resolveBareFile in lib/secret-contract.mjs.
  _csc_resolve_env_alias_only "$_id"
}

_csc_resolve_bare_file_family() {
  local _id="$1" _delivery
  _delivery="$(catalyst_secret_delivery "$_id")"
  _csc_set_result "" "" "$_delivery"
}

_csc_resolve_env_file_presence() {
  local _id="$1" _delivery _c
  _delivery="$(catalyst_secret_delivery "$_id")"
  while IFS= read -r _c; do
    [[ -n "$_c" ]] || continue
    if [[ -f "$_c" && -s "$_c" ]]; then
      _csc_set_result "$_c" "shared-file" "$_delivery"
      return 0
    fi
  done < <(catalyst_secret_candidates "$_id")
  _csc_set_result "" "none" "$_delivery"
}

# _csc_resolve_legacy_per_team_path — CTL-1616 PR4 (linear-worker-actor only). Mirrors
# linear-comment-post.sh's _find_layer2_config VERBATIM, including its loud stderr warning
# (that warning is exactly what __tests__/linear-comment-post.test.sh's CTL-1111 cells 13/14
# assert on, so it stays here, not in secret-contract.mjs's zero-side-effect JS mirror): walk
# $PWD upward for a .catalyst/config.json, read .catalyst.projectKey (nested) or a bare
# top-level .projectKey (legacy layout), and build the sibling config-<key>.json NEXT TO the
# canonical Layer-2 directory (dirname of catalyst_secret_resolve_layer2_path) — not a
# hardcoded ${HOME}/.config/catalyst literal, consistent with this row's own primary tier
# already reading through the canonical chain. Falls back to the canonical global path itself
# when no projectKey is found anywhere in the ancestry.
_csc_resolve_legacy_per_team_path() {
  local _dir="$PWD" _cfg _key
  while [[ "$_dir" != "/" ]]; do
    _cfg="$_dir/.catalyst/config.json"
    if [[ -f "$_cfg" ]]; then
      _key="$(jq -r '.catalyst.projectKey // .projectKey // empty' "$_cfg" 2>/dev/null)" || true
      if [[ -n "$_key" ]]; then
        printf '%s/config-%s.json' "$(dirname "$(catalyst_secret_resolve_layer2_path)")" "$_key"
        return 0
      fi
    fi
    _dir="$(dirname "$_dir")"
  done
  echo "catalyst-secret-contract: no projectKey in any .catalyst/config.json from $PWD upward — per-team config-<key>.json NOT resolved; falling back to global config.json" >&2
  catalyst_secret_resolve_layer2_path
}

# _csc_meets_required_object_fields ID JSON — CTL-1616 PR4 remediation (B1 fix; round-2 B3
# fix below). Mirrors lib/secret-contract.mjs's meetsRequiredObjectFields: a row with no
# requiredObjectFields declared passes trivially (echoes nothing declared -> return 0); a
# row that DOES declare fields requires JSON to be a JSON OBJECT with every named field
# present as a non-empty (post-EOL-strip — CANON RULE 2, see
# _CSC_REQUIRED_OBJECT_FIELDS above) string. JSON here is always an already-decoded
# canonical value handed in ONLY when the caller (_csc_config_json_tag_accepted) has already
# confirmed the ORIGINAL tag was "@OBJ64:" — never a plain "@STR64:" string reinterpreted as
# JSON (CANON RULE 1: see the tag-gating fix on that function; a JSON.parse/jq round-trip of
# a STRING's own text is exactly the B3 bug this avoids). Never aborts the caller (jq errors
# are swallowed via 2>/dev/null, matching every other jq call site in this file).
#
# ROUND-2 B3 FIX: the field value is now stripped of a TRAILING RUN of \r/\n bytes INSIDE the
# same jq invocation (`sub("[\r\n]+$";"")`, Oniguruma regex, byte-for-byte the same rule as
# JS's `stripEol`'s `.replace(/[\r\n]+$/, "")`) before the emptiness check — not left to bash's
# own $() capture, which only ever strips trailing "\n" bytes and would silently leave a
# trailing lone "\r" (or a "\r\n\r\n" mixed run) unstripped, an LF/CR asymmetry a purely-
# implicit $() reliance would introduce between the two engines.
_csc_meets_required_object_fields() {
  local _id="$1" _json="$2" _fields _field _val
  _fields="$(catalyst_secret_required_object_fields "$_id")"
  [[ -n "$_fields" ]] || return 0
  local -a _farr=()
  IFS=' ' read -r -a _farr <<< "$_fields"
  for _field in "${_farr[@]}"; do
    _val="$(printf '%s' "$_json" | jq -r --arg f "$_field" '
      if type == "object" and ((.[$f] | type) == "string") then
        (.[$f] | sub("[\r\n]+$"; ""))
      else "" end
    ' 2>/dev/null)"
    [[ -n "$_val" ]] || return 1
  done
  return 0
}

# _csc_config_json_tag_accepted ID TAG — ROUND-2 B3 FIX. Returns 0 (accept) iff TAG (an
# "@OBJ64:"/"@STR64:"/"@ABSENT"/"@NONSTR" value from _csc_read_json_string) is eligible to be
# decoded and checked against ID's requiredObjectFields gate; 1 (reject, fall through
# immediately) otherwise. CANON RULE 1 (see the requiredObjectFields row-field comment in
# lib/secret-contract.mjs): when ID declares requiredObjectFields, ONLY "@OBJ64:" is
# eligible — a bare "@STR64:" (the ORIGINAL value was a JSON STRING) is rejected here
# unconditionally, before ever being decoded, REGARDLESS of what its own text would parse to.
#
# WHY GATE ON THE TAG, NOT ON DECODED CONTENT: the previous implementation accepted both tags
# and asked _csc_meets_required_object_fields to sort it out — but that function pipes the
# ALREADY-DECODED text back into `jq`, which happily RE-PARSES a string's own text as JSON.
# A tier storing '"{\"clientId\":\"x\",\"clientSecret\":\"y\"}"' (a JSON STRING whose content
# looks like a full credential object) would decode to that exact object-shaped text, jq would
# re-parse it as an object, and the gate would incorrectly WIN — while
# lib/secret-contract.mjs's meetsRequiredObjectFields never reparses (it inspects
# `typeof raw`, the type JSON.parse/jq already assigned the value, once) and correctly falls
# through. The "@OBJ64:"/"@STR64:" tag already carries that original-type fact losslessly (set
# by _csc_read_json_string BEFORE any decoding), so gating on the TAG closes the divergence at
# its source instead of trying to out-guess jq's stdin-is-always-JSON re-parsing behavior.
#
# A row with no requiredObjectFields declared is unaffected — both tags stay eligible here,
# matching every other config-json row's pre-existing (pre-PR4) behavior; the ACTOR ROW SHAPE
# FIX this file's own history documents (accepting @STR64 for the generic groq-api-key shape)
# is untouched.
_csc_config_json_tag_accepted() {
  local _id="$1" _tag="$2" _req_fields
  case "$_tag" in
    "@OBJ64:"*) return 0 ;;
    "@STR64:"*)
      _req_fields="$(catalyst_secret_required_object_fields "$_id")"
      [[ -z "$_req_fields" ]]
      return $?
      ;;
    *) return 1 ;;
  esac
}

_csc_resolve_config_json() {
  local _id="$1" _delivery _path _l2 _tagged
  _delivery="$(catalyst_secret_delivery "$_id")"
  # ENV-PAIR TIER (CTL-1616 PR4, linear-worker-actor only): checked BEFORE the primary
  # configJsonPath tier — mirrors linear-comment-post.sh's own precedence exactly. BOTH
  # halves must be present (an id with no secret, or vice versa, is not a usable credential).
  local _pair _idvar _secvar _idval _secval
  if _pair="$(catalyst_secret_credential_env_pair "$_id")" && [[ -n "$_pair" ]]; then
    _idvar="${_pair%% *}"
    _secvar="${_pair#* }"
    _idval="${!_idvar-}"
    _secval="${!_secvar-}"
    if [[ -n "$_idval" && -n "$_secval" ]]; then
      local _obj
      _obj="$(jq -nc --arg id "$_idval" --arg sec "$_secval" '{clientId:$id, clientSecret:$sec}')"
      _csc_set_result "$_obj" "inherited" "$_delivery"
      return 0
    fi
  fi
  if [[ -n "$(catalyst_secret_env_names "$_id")" ]]; then
    # SUBSHELL-EXPORT CAVEAT (mirrors lib/catalyst-deployment-mode.sh's own documented fix):
    # calling _csc_resolve_env_alias_only inside a $(...) command substitution would run it
    # in a SUBSHELL, and the CATALYST_SECRET_LAST_* globals it sets would be discarded the
    # instant $() returns — so this call is made DIRECTLY (redirecting only stdout, not
    # wrapping the whole invocation in $()), keeping it in THIS function's own shell so the
    # globals it sets survive to the check below.
    _csc_resolve_env_alias_only "$_id" >/dev/null
    if [[ "$CATALYST_SECRET_LAST_SOURCE" == "inherited" ]]; then
      _csc_set_result "$CATALYST_SECRET_LAST_VALUE" "inherited" "$_delivery"
      return 0
    fi
  fi
  _path="$(catalyst_secret_config_json_path "$_id")"
  _l2="$(catalyst_secret_resolve_layer2_path)"
  _tagged="$(_csc_read_json_string "$_l2" "$_path")"
  # ACTOR ROW SHAPE FIX (Codex finding fix): accepts BOTH the "@STR64:" tag (a JSON string —
  # the pre-existing groq-api-key/generic shape) AND the "@OBJ64:" tag (a JSON OBJECT — the
  # catalyst.linear.bot.orchestrator/.worker shape, canonicalized+base64'd by
  # _csc_read_json_string), mirroring lib/secret-contract.mjs's canonicalizeConfigJsonValue
  # exactly: string-or-plain-object both resolve; array/boolean/number (@NONSTR) stay
  # rejected. B2 FIX (empty-value guard, generalized): require the DECODED value to be
  # non-empty — an empty string decodes to an empty string (falls through to "none", matching
  # lib/secret-contract.mjs's `raw.length > 0`); an empty object decodes to the 2-byte
  # canonical string "{}" (non-empty — DOES resolve, matching
  # canonicalizeConfigJsonValue's "empty object still resolves" behavior).
  #
  # ROUND-2 B3 FIX: the "accepts BOTH tags" claim above is now GATED by
  # _csc_config_json_tag_accepted, not a bare case-pattern match — for a row that declares
  # requiredObjectFields, a "@STR64:" tag is rejected unconditionally (CANON RULE 1), never
  # reaching _csc_meets_required_object_fields at all. See that helper's docstring.
  if _csc_config_json_tag_accepted "$_id" "$_tagged"; then
    local _decoded
    _csc_b64_decode_var _decoded "${_tagged#@*:}"
    # B1 FIX: a decoded-but-INCOMPLETE credential object (e.g. {clientId} alone, or a
    # credential-free object like {webhookSecret,botUserId}) must NOT capture resolution
    # here — falls through to the legacy tiers below instead, mirroring the OLD script's
    # per-tier `[[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]` advance rule exactly. A row
    # with no requiredObjectFields declared is unaffected (the gate passes trivially).
    if [[ -n "$_decoded" ]] && _csc_meets_required_object_fields "$_id" "$_decoded"; then
      _csc_set_result "$_decoded" "config-json" "$_delivery"
      return 0
    fi
  fi
  # LEGACY TIERS (CTL-1616 PR4, linear-worker-actor only): tried, in order, ONLY once the
  # primary tier misses above — preserves linear-comment-post.sh's fallthrough exactly
  # (design §8 PR4 / §9's "all three tiers preserved verbatim"). B1 fix: "misses" now means
  # EITHER absent OR (for a row declaring requiredObjectFields) present-but-incomplete.
  local _tier_line _tier_scope _tier_path _tier_l2 _tier_tagged _tier_decoded
  while IFS= read -r _tier_line; do
    [[ -n "$_tier_line" ]] || continue
    _tier_scope="${_tier_line%%|*}"
    _tier_path="${_tier_line#*|}"
    if [[ "$_tier_scope" == "per-team-legacy" ]]; then
      _tier_l2="$(_csc_resolve_legacy_per_team_path)"
    else
      _tier_l2="$(catalyst_secret_resolve_layer2_path)"
    fi
    _tier_tagged="$(_csc_read_json_string "$_tier_l2" "$_tier_path")"
    # ROUND-2 B3 FIX: same tag-gating as the primary tier above (CANON RULE 1) — a legacy
    # tier's own "@STR64:" value is equally rejected unconditionally when ID declares
    # requiredObjectFields, never reaching _csc_meets_required_object_fields.
    if _csc_config_json_tag_accepted "$_id" "$_tier_tagged"; then
      _csc_b64_decode_var _tier_decoded "${_tier_tagged#@*:}"
      if [[ -n "$_tier_decoded" ]] && _csc_meets_required_object_fields "$_id" "$_tier_decoded"; then
        _csc_set_result "$_tier_decoded" "legacy-config-json" "$_delivery"
        return 0
      fi
    fi
  done < <(catalyst_secret_legacy_tiers "$_id")
  _csc_set_result "" "none" "$_delivery"
}

# catalyst_secret_cloud_token_name ID — CTL-1616 PR5. NAME-ONLY resolution of the cloud-token
# row's env-var NAME: env override (CATALYST_CLOUD_TOKEN_ENV) → Layer-2
# catalyst.cloud.tokenEnv → default. NEVER reads the value of the resolved variable — mirrors
# lib/secret-contract.mjs's EXPORTED resolveCloudTokenName(env) byte-for-byte (same
# env-override / Layer-2 / default precedence, same STRICT string-only Layer-2 acceptance —
# see the STRICT STRING-ONLY note below). PUBLIC (catalyst_ prefix, not _csc_) so
# health-responder.sh's bash-fallback ladder can call this directly instead of hand-rolling its
# own jq-based ladder (design §9 PR5: "both cloud-token readers agree byte-for-byte on the
# resolved env-var name"). Echoes "envVar|source" and sets
# CATALYST_SECRET_TOKEN_NAME/_SOURCE (mirrors _csc_set_result's exported-breadcrumb
# convention) so a caller that only needs the NAME (not a resolve-and-check-presence round
# trip) can skip re-parsing the pipe-joined echo.
catalyst_secret_cloud_token_name() {
  local _id="${1:-cloud-token}" _path _l2 _tagged _env_var _source
  _path="$(catalyst_secret_config_json_path "$_id")"
  if [[ -n "${CATALYST_CLOUD_TOKEN_ENV:-}" ]]; then
    _env_var="$CATALYST_CLOUD_TOKEN_ENV"
    _source="env"
  else
    _l2="$(catalyst_secret_resolve_layer2_path)"
    _tagged="$(_csc_read_json_string "$_l2" "$_path")"
    # B2 FIX: same non-empty guard as _csc_resolve_config_json — an empty Layer-2 NAME
    # override must fall through to the default env-var name, matching
    # lib/secret-contract.mjs's resolveCloudTokenName `l2Name.length > 0` check. STRICT
    # STRING-ONLY BY DESIGN (unlike _csc_resolve_config_json): only the "@STR64:" tag is
    # accepted here — an "@OBJ64:" (object-shaped) override is deliberately NOT
    # canonicalized-and-used-as-a-name, mirroring lib/secret-contract.mjs's
    # resolveCloudTokenName, which reads catalyst.cloud.tokenEnv via the SAME readJsonField
    # call but applies its OWN `typeof l2Name === "string"` check (never routes through
    # canonicalizeConfigJsonValue) — a NAME override can only ever be a plain
    # env-var-name string, so an object there falls back to the default name on both sides.
    case "$_tagged" in
      "@STR64:"*)
        local _decoded
        _csc_b64_decode_var _decoded "${_tagged#@STR64:}"
        if [[ -n "$_decoded" ]]; then
          _env_var="$_decoded"
          _source="layer2"
        else
          _env_var="$(catalyst_secret_env_names "$_id" | head -n1)"
          _source="default"
        fi
        ;;
      *)
        _env_var="$(catalyst_secret_env_names "$_id" | head -n1)"
        _source="default"
        ;;
    esac
  fi
  CATALYST_SECRET_TOKEN_NAME="$_env_var"
  # shellcheck disable=SC2034
  CATALYST_SECRET_TOKEN_NAME_SOURCE="$_source"
  export CATALYST_SECRET_TOKEN_NAME CATALYST_SECRET_TOKEN_NAME_SOURCE
  printf '%s|%s' "$_env_var" "$_source"
}

# _csc_resolve_cloud_token_name — cloud-token's two-step resolution: NAME (via
# catalyst_secret_cloud_token_name above — single implementation, not a second copy), then
# that variable's VALUE. Mode-independent — always platform-env, never touches a file.
_csc_resolve_cloud_token_name() {
  local _id="$1" _delivery _env_var _val
  _delivery="$(catalyst_secret_delivery "$_id")"
  catalyst_secret_cloud_token_name "$_id" >/dev/null
  _env_var="$CATALYST_SECRET_TOKEN_NAME"
  # INVALID ENV NAME FIX (Codex finding fix): CATALYST_CLOUD_TOKEN_ENV / the Layer-2
  # tokenEnv override is OPERATOR-CONTROLLED text, not registry data — a value like
  # "BAD-NAME" (or anything else outside [A-Za-z_][A-Za-z0-9_]*) fed straight into
  # `${!_env_var-}` FATALLY ABORTS the whole process with "invalid variable name" (verified;
  # same failure CLASS as the B1/B3 fixes elsewhere in this file, at a call site those fixes
  # didn't cover). lib/secret-contract.mjs's `env?.[envVar]` never crashes on any string —
  # an invalid identifier there is simply a lookup that finds nothing. Validating BEFORE the
  # indirect expansion makes an invalid override degrade to the documented unresolved result
  # (source=none) identically on both sides, never an abort. The `[[ =~ ]]` test itself
  # cannot trip errexit (a failed conditional in an `if`/`[[` context never does).
  if [[ "$_env_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    _val="${!_env_var-}"
  else
    _val=""
  fi
  if [[ -n "$_val" ]]; then
    _csc_set_result "$_val" "platform-env" "$_delivery"
  else
    _csc_set_result "" "none" "$_delivery"
  fi
}

# _csc_resolve_local_only_presence — age-key. PRESENCE-CHECKED ONLY: this function must never
# `cat`/read the candidate file's contents — `[[ -f ]]`/`-s` alone.
_csc_resolve_local_only_presence() {
  local _id="$1" _delivery _override _home _default_rel _path
  _delivery="$(catalyst_secret_delivery "$_id")"
  _override="$(catalyst_secret_env_names "$_id" | head -n1)"
  local _override_val="${!_override-}"
  if [[ -n "$_override_val" ]]; then
    _path="$_override_val"
  else
    _home="${HOME-}"
    [[ -z "$_home" ]] && _home=~
    _default_rel="$(_csc_index_of "$_id")"
    _default_rel="${_CSC_DEFAULT_LOCAL_PATH[$_default_rel]}"
    _path="${_home}/${_default_rel}"
  fi
  if [[ -f "$_path" ]]; then
    _csc_set_result "$_path" "present" "$_delivery"
  else
    _csc_set_result "" "absent" "$_delivery"
  fi
}

# ─── The public engine ───────────────────────────────────────────────────────────────────

# _csc_cloud_bootstrap_id — the id of the row whose bootstrapFor === "cloud" (cloud-token).
_csc_cloud_bootstrap_id() {
  local _i
  for _i in "${!_CSC_BOOTSTRAP_FOR[@]}"; do
    [[ "${_CSC_BOOTSTRAP_FOR[$_i]}" == "cloud" ]] && { printf '%s' "${_CSC_IDS[$_i]}"; return 0; }
  done
  return 1
}

# catalyst_resolve_secret ID [DEPLOYMENT_MODE] [INFERRED(true|false)] [RECOGNIZED(true|false)]
# — mirrors resolveSecret(id, {env, deploymentMode}). Echoes "value|source|provider" and sets
# CATALYST_SECRET_LAST_VALUE/_SOURCE/_PROVIDER. Never fails the caller (always echoes a
# 3-field pipe-joined string, empty fields on miss/unresolved).
#
# CLOUD GUARD: activates ONLY when DEPLOYMENT_MODE == "cloud" AND INFERRED == "false" AND
# RECOGNIZED != "false" — mirrors the JS engine's `deploymentMode.mode === "cloud" &&
# deploymentMode.inferred === false && deploymentMode.recognized !== false` guard exactly
# (design §12 Q3 belt-and-suspenders extension — see lib/secret-contract.mjs's resolveSecret
# docstring for the full rationale). RECOGNIZED defaults to "true" so every existing 2/3-arg
# call site keeps today's behavior unchanged — this is an ADDITIVE 4th positional arg, never a
# breaking one. Any other combination (including DEPLOYMENT_MODE unset, "single-host",
# "cluster", "cloud" with INFERRED != "false", or "cloud"/inferred=false with RECOGNIZED ==
# "false") runs the normal per-delivery-type file/config chain — the "never skips the file
# chain for single-host/cluster" invariant.
catalyst_resolve_secret() {
  local _id="$1" _dep_mode="${2:-}" _dep_inferred="${3:-true}" _dep_recognized="${4:-true}"
  local _idx _delivery
  if ! _idx="$(_csc_index_of "$_id")"; then
    _csc_set_result "" "" ""
    return 0
  fi
  _delivery="${_CSC_DELIVERY[$_idx]}"

  if [[ "$_dep_mode" == "cloud" && "$_dep_inferred" == "false" && "$_dep_recognized" != "false" ]]; then
    local _bootstrap_for="${_CSC_BOOTSTRAP_FOR[$_idx]}"
    if [[ "$_bootstrap_for" != "cloud" ]]; then
      local _bid
      if _bid="$(_csc_cloud_bootstrap_id)"; then
        local _boot_val
        # B3 FIX: DIRECT CALL, NOT wrapped in $(...) — mirrors the SUBSHELL-EXPORT CAVEAT
        # documented on _csc_resolve_config_json/catalyst_arm_secret. The previous
        # implementation captured the recursive call's pipe-joined "value|source|provider"
        # stdout via $() and parsed it with `${_boot_out%%|*}` — a cloud-token VALUE that
        # itself BEGINS WITH "|" makes that pattern match at position 0, so `%%|*` strips
        # the ENTIRE string and _boot_val came back empty even though the bootstrap secret
        # genuinely resolved — bash then falsely short-circuited every other cloud-mode
        # secret to null while the JS engine (which reads bootstrapResolved.value directly,
        # never a delimited string) resolves normally. Reading the
        # CATALYST_SECRET_LAST_VALUE breadcrumb that _csc_set_result exports in THIS shell
        # (no subshell forked by a bare `>/dev/null` redirection, so the export survives)
        # avoids parsing delimited stdout at all.
        # No deployment-mode args passed onward — cloud-token's own resolution is
        # mode-independent (matches resolveCloudTokenName's JS docstring), so this recurses
        # exactly one level and terminates.
        catalyst_resolve_secret "$_bid" >/dev/null
        _boot_val="$CATALYST_SECRET_LAST_VALUE"
        if [[ -z "$_boot_val" ]]; then
          _csc_set_result "" "" "$_delivery"
          return 0
        fi
      fi
    fi
    # PLATFORM-ENV NAME OVERRIDE FIX (Codex finding fix): a bare _csc_resolve_env_alias_only
    # here only ever checks the row's static env-name list — for cloud-token that is JUST
    # the hardcoded default "CATALYST_CLOUD_TOKEN" — so an operator-configured
    # CATALYST_CLOUD_TOKEN_ENV or Layer-2 catalyst.cloud.tokenEnv override was silently
    # ignored the moment genuine cloud mode activated, even though that SAME override IS
    # honored one level up (the bootstrap check above recurses via `catalyst_resolve_secret
    # "$_bid"` with NO deployment-mode args, which falls through to the normal case
    # dispatch below → _csc_resolve_cloud_token_name). Dispatching platform-env rows through
    # _csc_resolve_cloud_token_name here too — the SAME function, not a second copy — closes
    # that gap identically to the JS-side fix (lib/secret-contract.mjs resolveSecret's cloud
    # branch). Every other cloud-mode row still collapses to its plain env-alias chain.
    if [[ "$_delivery" == "platform-env" ]]; then
      _csc_resolve_cloud_token_name "$_id"
    else
      _csc_resolve_env_alias_only "$_id"
    fi
    return 0
  fi

  case "$_delivery" in
    bare-file) _csc_resolve_bare_file "$_id" ;;
    bare-file-family) _csc_resolve_bare_file_family "$_id" ;;
    env-file) _csc_resolve_env_file_presence "$_id" ;;
    env-alias) _csc_resolve_env_alias_only "$_id" ;;
    config-json) _csc_resolve_config_json "$_id" ;;
    platform-env) _csc_resolve_cloud_token_name "$_id" ;;
    local-only) _csc_resolve_local_only_presence "$_id" ;;
    *) _csc_set_result "" "" "$_delivery" ;;
  esac
}

# ─── armSecret mirror ────────────────────────────────────────────────────────────────────
#
# Bash has no first-class function values the way registerRearmHook(id, fn) does in
# lib/secret-contract.mjs, so catalyst_arm_secret ALWAYS runs the HOOKLESS-DEGRADE path —
# which in THIS PR is the identical behavior lib/secret-contract.mjs's armSecret produces for
# every row too, since nothing has called registerRearmHook yet anywhere (zero consumers).
# The two implementations are therefore expected to agree exactly today; see
# __tests__/catalyst-secret-contract.test.sh's "arm state" section (this file's own
# standalone suite) and lib/secret-contract.test.mjs's "registry validation (§6)" describe
# block on the JS side. (A1 fix: this pointer previously named
# __tests__/secret-contract-parity.test.sh, which has NO arm-state fixtures at all — the
# cross-stack parity suite only exercises resolveSecret/catalyst_resolve_secret.) A future
# PR that wires a real JS rearm hook does NOT need a bash equivalent of the hook path
# itself — only of this degrade path, which stays correct on its own.
#
# State: per-id last-observed-value, kept in parallel arrays (no declare -A). Persists only
# for the lifetime of the current shell process — a fresh shell has no baseline, matching a
# freshly-started daemon.
_CSC_ARM_IDS=()
_CSC_ARM_VALUES=()

_csc_arm_index_of() {
  local _id="$1" _i
  for _i in "${!_CSC_ARM_IDS[@]}"; do
    [[ "${_CSC_ARM_IDS[$_i]}" == "$_id" ]] && { printf '%s' "$_i"; return 0; }
  done
  return 1
}

# catalyst_secret_reset_arm_state [ID] — test/reset seam, mirrors resetArmState(id).
catalyst_secret_reset_arm_state() {
  if [[ -z "${1:-}" ]]; then
    _CSC_ARM_IDS=()
    _CSC_ARM_VALUES=()
    return 0
  fi
  local _i
  if _i="$(_csc_arm_index_of "$1")"; then
    unset "_CSC_ARM_IDS[$_i]" "_CSC_ARM_VALUES[$_i]"
    _CSC_ARM_IDS=("${_CSC_ARM_IDS[@]}")
    _CSC_ARM_VALUES=("${_CSC_ARM_VALUES[@]}")
  fi
}

# catalyst_arm_secret ID [DEPLOYMENT_MODE] [INFERRED(true|false)] [RECOGNIZED(true|false)] —
# echoes "armed|rotated|restartRequired" (each true|false) AND exports the same three fields
# as CATALYST_SECRET_ARM_ARMED / _ROTATED / _RESTART_REQUIRED, mirroring armSecret's { armed,
# rotated, restartRequired } shape. DEPLOYMENT_MODE/INFERRED/RECOGNIZED are the SAME optional
# positional args catalyst_resolve_secret takes, threaded straight through (Codex finding
# fix, design §8; RECOGNIZED added in CTL-1616 PR6 alongside the cloud-guard extension) — see
# the DEPLOYMENT-MODE THREADING FIX comment below for the concrete bug this closes; a caller
# that never passes them gets EXACTLY today's non-cloud behavior.
#
# MUST BE CALLED DIRECTLY, NEVER WRAPPED IN $(...), by any caller that needs the persistent
# baseline to survive across repeated calls in the same shell — this is the SAME
# SUBSHELL-EXPORT trap documented on _csc_resolve_config_json and
# lib/catalyst-deployment-mode.sh's catalyst_resolve_deployment_mode: `$(catalyst_arm_secret
# id)` forks a subshell, and this function's mutation of the _CSC_ARM_IDS/_CSC_ARM_VALUES
# globals would happen in THAT subshell's copy and vanish the instant $() returns — every
# call made that way would wrongly look like a first observation, forever. Call it plainly
# (optionally redirecting stdout with `>/dev/null` if only the exported vars are wanted) and
# read the exported vars, or capture stdout via `out="$(catalyst_arm_secret id)"` ONLY when
# the caller genuinely wants a one-shot, state-discarding check.
catalyst_arm_secret() {
  local _id="$1" _dep_mode="${2:-}" _dep_inferred="${3:-true}" _dep_recognized="${4:-true}" _rotation_class=""
  # B4 FIX (errexit safety): the assignment runs in an `if` condition — mirrors the
  # ERREXIT SAFETY pattern on _csc_read_json_string above. catalyst_secret_rotation_class
  # returns rc=1 (printing nothing) for an unknown id; a bare
  # `_rotation_class=$(catalyst_secret_rotation_class "$_id")`, run as a plain simple
  # command with no enclosing if/while/`||`, has ITS OWN nonzero exit status — under `set
  # -e`/errexit that kills the CALLER's entire process, rather than returning the quiet
  # {armed:false} triple lib/secret-contract.mjs's armSecret returns for the same unknown
  # id. See __tests__/catalyst-secret-contract.test.sh's errexit regression cell.
  if ! _rotation_class="$(catalyst_secret_rotation_class "$_id")"; then
    _csc_set_arm_result "false" "false" "false"
    return 0
  fi
  if [[ -z "$_rotation_class" || "$_rotation_class" == "n/a" ]]; then
    _csc_set_arm_result "false" "false" "false"
    return 0
  fi
  # DELIMITED-STDOUT HAZARD (same class as the cloud-bootstrap fix above): a
  # secret VALUE may legitimately contain "|", and parsing the pipe-joined
  # resolve output with ${x%%|*} truncates it at the first pipe — the rotation
  # diff below would then silently miss a real rotation AND its
  # restart-required signal (the literal 2026-08-02 outage mechanism this
  # contract exists to report). Call resolve directly (no $() — resolve never
  # touches the arm arrays, so there is no subshell-state hazard) and read the
  # CATALYST_SECRET_LAST_VALUE breadcrumb it exports in-shell.
  #
  # DEPLOYMENT-MODE THREADING FIX (Codex finding fix, design §8): _dep_mode/_dep_inferred
  # MUST be forwarded here — omitting them used to make the arm baseline resolve through the
  # non-cloud file/config chain even when the CALLER is genuinely in cloud mode, while a
  # sibling direct `catalyst_resolve_secret id cloud false` call correctly resolved via the
  # cloud-only env-alias chain. In a cloud process with an injected token AND a stale local
  # file, that mismatch made a stale-file edit falsely report restartRequired while a REAL
  # token rotation went unnoticed — mirrors lib/secret-contract.mjs's armSecret fix exactly.
  local _current _idx
  catalyst_resolve_secret "$_id" "$_dep_mode" "$_dep_inferred" "$_dep_recognized" >/dev/null
  _current="${CATALYST_SECRET_LAST_VALUE-}"
  if _idx="$(_csc_arm_index_of "$_id")"; then
    local _previous="${_CSC_ARM_VALUES[$_idx]}"
    _CSC_ARM_VALUES[_idx]="$_current"
    if [[ "$_current" == "$_previous" ]]; then
      _csc_set_arm_result "false" "false" "false"
    else
      _csc_set_arm_result "false" "true" "true"
    fi
  else
    _CSC_ARM_IDS+=("$_id")
    _CSC_ARM_VALUES+=("$_current")
    # First observation establishes the baseline — nothing has rotated relative to a
    # baseline that did not exist yet.
    _csc_set_arm_result "false" "false" "false"
  fi
}

_csc_set_arm_result() {
  # shellcheck disable=SC2034
  CATALYST_SECRET_ARM_ARMED="$1"
  # shellcheck disable=SC2034
  CATALYST_SECRET_ARM_ROTATED="$2"
  # shellcheck disable=SC2034
  CATALYST_SECRET_ARM_RESTART_REQUIRED="$3"
  export CATALYST_SECRET_ARM_ARMED CATALYST_SECRET_ARM_ROTATED CATALYST_SECRET_ARM_RESTART_REQUIRED
  printf '%s|%s|%s' "$1" "$2" "$3"
}
