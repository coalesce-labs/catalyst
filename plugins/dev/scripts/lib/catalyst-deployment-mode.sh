#!/usr/bin/env bash
# lib/catalyst-deployment-mode.sh — CTL-1617: bash mirror of
# lib/deployment-mode.mjs's resolveDeploymentMode. Bash cannot import the JS
# leaf, so this is a SECOND, independently-maintained implementation of the
# same resolution chain — kept honest by the fixture-matrix cross-stack
# parity test at __tests__/deployment-mode-parity.test.sh (built on the
# `node --input-type=module` mechanism __tests__/host-identity.test.sh
# already proves out in CI). Any enum or precedence change here MUST land
# together with the matching change in lib/deployment-mode.mjs, or the parity
# test fails loudly.
#
# Deployment mode gets its OWN lib file — rather than another hand-rolled jq
# one-liner at each call site — precisely because CTL-1612 proved that
# letting a multi-site jq one-liner drift across launchers is how outages
# happen (lib/catalyst-secret-env.sh's header tells that story in full).
#
# NAMING RULE: always write "deployment mode" fully qualified in every log
# line and comment in this file — never bare "mode" (see
# lib/deployment-mode.mjs's header for the three unrelated "mode" concepts
# this codebase already has).
#
# ENV-VS-FILE ASYMMETRY: see the identical caveat atop lib/deployment-mode.mjs
# — CATALYST_DEPLOYMENT_MODE is captured into a long-lived daemon's
# environment once, at launch; Layer-1/Layer-2 FILE edits are picked up live
# on every call to catalyst_resolve_deployment_mode.
#
# JQ-ABSENT DIVERGENCE (loud, by design): when jq is unavailable, a Layer-1/
# Layer-2 config FILE that exists and could theoretically decide the mode is
# instead treated as ABSENT (falls through to the next layer) — this is a
# real, best-effort divergence from lib/deployment-mode.mjs, which always
# parses JSON natively and never depends on an external binary. This file
# does not fail the caller for it (the contract is "never fails"); instead it
# leaves a breadcrumb, CATALYST_DEPLOYMENT_MODE_JQ_MISSING=1, exported (never
# printed to stderr) so `catalyst doctor` (PR2 of the CTL-1617 migration
# plan) can grade a host that is silently degrading on this axis.
#
# Depends only on jq + bash. bash >= 3.2 compatible (no ${var,,}).
#
# Idempotent-source guard — safe to source multiple times.
[[ -n "${_CATALYST_DEPLOYMENT_MODE_SH_LOADED:-}" ]] && return 0
_CATALYST_DEPLOYMENT_MODE_SH_LOADED=1

# The closed enum. Mirrors DEPLOYMENT_MODES in lib/deployment-mode.mjs — a
# value added to one side without the other fails the parity test.
#
# PARITY DECISION — IFS-INDEPENDENT ENUM (array, not a space-joined string):
# a bare `for _m in $_CATALYST_DEPLOYMENT_MODES` word-splits on the CALLER's
# IFS, not a fixed space. A sourcing script that sets the common strict-shell
# IFS=$'\n\t' (no space in it) would stop splitting this string into three
# words at all — every candidate, including valid ones, would then compare
# against ONE giant "single-host cluster cloud" token and always report
# unrecognized. An array's elements are already delimited at assignment time
# and iterating "${arr[@]}" never re-splits them, so membership no longer
# depends on unrelated caller shell state. `${_CATALYST_DEPLOYMENT_MODES[*]}`
# (join on the FIRST character of IFS) is still available wherever the old
# space-joined string is needed (e.g. WARN text), but that too is only used
# from this file's own functions, which never run with a non-default IFS.
_CATALYST_DEPLOYMENT_MODES=(single-host cluster cloud)
CATALYST_DEPLOYMENT_MODE_DEFAULT="single-host"

# _catalyst_deployment_mode_is_member VALUE — true iff VALUE (already
# trimmed + lowercased) names one of the enum members.
_catalyst_deployment_mode_is_member() {
  local _v="$1" _m
  for _m in "${_CATALYST_DEPLOYMENT_MODES[@]}"; do
    [[ "$_v" == "$_m" ]] && return 0
  done
  return 1
}

# _catalyst_deployment_mode_from_file FILE — jq-read catalyst.deployment.mode
# and return a TAGGED string so the caller (classify) can distinguish "key
# absent", "value is JSON null", "value is a string", and "value is present
# but NOT a string" — the same four rungs classifyCandidate discriminates in
# lib/deployment-mode.mjs. A bare `// empty` (the pre-fix approach) collapses
# ALL FOUR to the same empty output, which silently swallows a JSON `false`
# (jq: `false // empty` is empty, because `//` treats `false` as falsy) —
# {"mode": false} would fall through here while JS correctly SETTLES at this
# layer with recognized:false. Tags:
#   @ABSENT          — key not present (or file unreadable/malformed)
#   @ABSENT_JQMISSING — key can't be determined because jq itself is missing
#                       (a distinct reason so the CALLER — not this function,
#                       see the SUBSHELL-EXPORT DIVERGENCE note on
#                       catalyst_resolve_deployment_mode below — can export
#                       the CATALYST_DEPLOYMENT_MODE_JQ_MISSING breadcrumb)
#   @NULL     — value is JSON null
#   @STR:xxx  — value is the string "xxx" (may itself be empty)
#   @NONSTR   — value is present and NOT a string (bool/number/array/object),
#               OR is a string that embeds a NUL byte (see NUL-BYTE
#               CANDIDATE below) — both settle here, degraded, same as a
#               non-member string would.
# @ABSENT and @ABSENT_JQMISSING and @NULL all mean "fall through" to
# classify, exactly like classifyCandidate's `raw === undefined || raw ===
# null` rung. @NONSTR means "settle here, degraded" — never falls through.
# Never fails the caller.
#
# LONE-SURROGATE PARITY (both sides fall through): a JSON string containing
# an unpaired UTF-16 surrogate escape (e.g. "clu\ud800ster") is rejected by
# jq at PARSE time for the WHOLE document (verified: jq-1.7.1 exits 5 —
# there is no jq invocation that can read ANY field out of such a file), so
# this function reports @ABSENT and the layer falls through. JSON.parse
# WOULD accept the string, so the JS resolver deliberately narrows to match:
# readDeploymentModeField (deployment-mode.mjs) treats a mode string
# carrying an unpaired surrogate as layer-malformed and returns undefined —
# both languages fall through to the deeper layer. Valid surrogate PAIRS
# (astral characters) parse fine in both and are simply non-members.
_catalyst_deployment_mode_from_file() {
  local _f="$1" _jq_out _jq_rc
  if [[ ! -r "$_f" ]]; then
    printf '@ABSENT'
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    # File exists but we have no way to parse it — see the JQ-ABSENT
    # DIVERGENCE note atop this file. The breadcrumb itself is exported by
    # the CALLER, not here (see the SUBSHELL-EXPORT DIVERGENCE note on
    # catalyst_resolve_deployment_mode) — this function always runs inside a
    # $(...) command-substitution subshell, so an `export` performed HERE
    # would silently vanish the instant $() returns and never reach the
    # caller's environment. Signal it through the tagged return value
    # instead, which $() DOES propagate.
    printf '@ABSENT_JQMISSING'
    return 0
  fi
  # MALFORMED-TRAILING-CONTENT fix: jq streams top-level JSON values and can
  # print a fully-formed tag for the FIRST one, THEN hit trailing garbage
  # and exit non-zero (verified: a leading `{"catalyst":{"deployment":
  # {"mode":"cloud"}}}` followed by stray text prints "@STR:cloud" to stdout
  # before erroring). Command substitution captures stdout regardless of
  # exit status, so the pre-fix `jq ... || printf '@ABSENT'` APPENDED
  # "@ABSENT" onto the already-printed tag ("@STR:cloud\n@ABSENT") instead
  # of replacing it -- _catalyst_deployment_mode_classify's `"@STR:"*` glob
  # then matched that whole multi-line blob, so a malformed file with a
  # syntactically valid PREFIX settled as an unrecognized string instead of
  # falling through like JSON.parse (which rejects the entire malformed
  # document and yields undefined). Fix: capture stdout and exit status
  # SEPARATELY, and only trust the captured output when jq exited 0 -- any
  # non-zero exit discards whatever partial text was printed and settles on
  # a clean, single-tag @ABSENT.
  # BOM SNIFF (parity): this jq build tolerates a UTF-8 BOM at the start of
  # input, but JSON.parse rejects one — a BOM-prefixed config must read as
  # layer-malformed (@ABSENT, fall through) on BOTH sides.
  local _first3
  _first3="$(head -c 3 "$_f" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  if [[ "$_first3" == "efbbbf" ]]; then
    printf '@ABSENT'
    return 0
  fi
  # --slurp (parity): jq without -s processes each top-level JSON value in the
  # file independently — a file holding TWO valid documents exits 0 and emits
  # two tags, bypassing the exit-status check below, while JSON.parse rejects
  # the whole file. Slurping collapses that to one array whose length exposes
  # the multi-document case inside the filter (length != 1 → @ABSENT). A
  # single document whose mode STRING merely contains an embedded newline is
  # unaffected: it still emits one (multi-line) @STR: tag, which classify
  # edge-trims and degrades as a non-member — same as JSON.parse's view.
  #
  # ERREXIT SAFETY: the assignment runs in an `if` condition so a nonzero jq
  # exit cannot abort a caller running under `set -e` (POSIX mode /
  # inherit_errexit propagate errexit INTO command substitutions — the
  # documented never-fails contract must survive that).
  if _jq_out="$(jq -rs '
    if length != 1 then "@ABSENT" else .[0] |
    ((.catalyst.deployment // {})
    | if has("mode") then
        (.mode
         | if . == null then "@NULL"
           elif type == "string" then
             # NUL-BYTE CANDIDATE fix: a bash command substitution silently
             # TRUNCATES an embedded NUL byte -- bash variables cannot
             # represent one -- so a raw value with an embedded NUL between
             # "c" and "loud" would otherwise arrive at the caller already
             # collapsed to the recognized member "cloud" (a false
             # positive: JS classifies that as a genuine, non-matching
             # string and degrades it). jq itself still holds the full
             # Unicode string (including the embedded NUL codepoint) at
             # this point, so detect and settle it HERE, inside jq, exactly
             # like any other non-member value -- never let a
             # NUL-containing candidate reach the $()-boundary as a bare
             # @STR: tag. The NUL character itself is built via
             # `[0] | implode` (a one-character string whose sole codepoint
             # is 0) rather than a literal escape, since jq string
             # literals inside this single-quoted bash program text cannot
             # spell a literal escape sequence without breaking bash quoting.
             (if contains([0] | implode) then "@NONSTR" else "@STR:" + . end)
           else "@NONSTR"
           end)
      else "@ABSENT"
      end)
    end
  ' "$_f" 2>/dev/null)"; then
    _jq_rc=0
  else
    _jq_rc=$?
  fi
  if [[ $_jq_rc -ne 0 ]]; then
    printf '@ABSENT'
    return 0
  fi
  printf '%s' "$_jq_out"
}

# _catalyst_deployment_mode_env_tag — tag CATALYST_DEPLOYMENT_MODE the same
# way _catalyst_deployment_mode_from_file tags a file value, so both layers
# feed the same classify function. A real OS env var is always either unset
# (@ABSENT) or a string (@STR:xxx, which may be empty) — env vars can never
# be JSON null or a non-string type, so those two tags never occur here.
_catalyst_deployment_mode_env_tag() {
  if [[ -z "${CATALYST_DEPLOYMENT_MODE+set}" ]]; then
    printf '@ABSENT'
  else
    printf '@STR:%s' "${CATALYST_DEPLOYMENT_MODE}"
  fi
}

# _catalyst_deployment_mode_trim VALUE — strip ASCII whitespace
# (space/tab/LF/VT/FF/CR) from both ends. Pure parameter expansion: quote
# and backslash characters in the value stay DATA, never re-parsed.
#
# PARITY DECISION — ASCII-ONLY BY DESIGN: the JS resolver
# (deployment-mode.mjs classifyCandidate) deliberately narrows its trim to
# the six ASCII whitespace characters rather than String.prototype.trim() —
# cross-language parity beats Unicode hospitality. The character set here is
# spelled out explicitly instead of [[:space:]] because that class is LOCALE
# DATA: under a UTF-8 locale some platforms (macOS) classify NBSP as space
# while a C-locale Linux runner does not — the exact same input would then
# trim differently per host. An NBSP-padded "cluster" keeps its padding on
# BOTH sides in EVERY locale, fails enum membership on both sides, and
# degrades identically to single-host/recognized:false at its source layer.
_catalyst_deployment_mode_trim() {
  local _t="$1" _ws=$' \t\n\v\f\r'
  _t="${_t#"${_t%%[!"$_ws"]*}"}"
  _t="${_t%"${_t##*[!"$_ws"]}"}"
  printf '%s' "$_t"
}

# _catalyst_deployment_mode_classify TAGGED SOURCE
#   Sets the shared _cdm_mode/_cdm_source/_cdm_recognized output vars and
#   returns 0 when TAGGED settles the question at this layer (a non-member
#   string, or a non-string value, degrades to single-host but STILL settles
#   here — it does not fall through). Returns 1 (leaving the output vars
#   untouched) when this layer should fall through to the next: @ABSENT,
#   @NULL, or a @STR: value that is empty after trimming (mirrors an empty
#   env var / a whitespace-only file value — the same "cleared" rule
#   lib/deployment-mode.mjs's classifyCandidate applies to a trimmed-empty
#   string).
#
#   Trim delegates to _catalyst_deployment_mode_trim (ASCII-only, see
#   above) rather than pure parameter expansion, so quote/backslash
#   characters in the raw value still stay DATA — never re-parsed as shell
#   syntax — since jq consumes the value only as `-R` raw text input, not as
#   a shell string. Lowercase via `tr '[:upper:]' '[:lower:]'` (bash
#   3.2-safe; ${var,,} is bash 4+; the enum members are all plain ASCII, so
#   an ASCII-only lowercase pass matches the ASCII-only trim above).
_catalyst_deployment_mode_classify() {
  local _tagged="$1" _source="$2" _raw _norm
  case "$_tagged" in
    "@ABSENT" | "@NULL")
      return 1
      ;;
    "@NONSTR")
      _cdm_source="$_source"
      _cdm_mode="$CATALYST_DEPLOYMENT_MODE_DEFAULT"
      _cdm_recognized="false"
      return 0
      ;;
    "@STR:"*)
      _raw="${_tagged#@STR:}"
      ;;
    *)
      # Defensive: an unrecognized tag (should never happen) falls through
      # rather than crashing the caller.
      return 1
      ;;
  esac

  _norm="$(_catalyst_deployment_mode_trim "$_raw")"
  _norm="$(printf '%s' "$_norm" | tr '[:upper:]' '[:lower:]')"

  [[ -n "$_norm" ]] || return 1
  _cdm_source="$_source"
  if _catalyst_deployment_mode_is_member "$_norm"; then
    _cdm_mode="$_norm"
    _cdm_recognized="true"
  else
    _cdm_mode="$CATALYST_DEPLOYMENT_MODE_DEFAULT"
    _cdm_recognized="false"
  fi
  return 0
}

# catalyst_resolve_deployment_mode — echoes the winning deployment mode and
# exports:
#   CATALYST_DEPLOYMENT_MODE_RESOLVED    the mode (single-host|cluster|cloud)
#   CATALYST_DEPLOYMENT_MODE_SOURCE      env|layer2|layer1|default
#   CATALYST_DEPLOYMENT_MODE_RECOGNIZED  true|false (always true for "default")
#   CATALYST_DEPLOYMENT_MODE_INFERRED    true|false (true only for "default" —
#                                         mirrors lib/deployment-mode.mjs's
#                                         `inferred` field; the raw candidate
#                                         itself stays JS-only — an exported
#                                         bash var is a poor home for
#                                         adversarial/hostile-byte raw values)
# mirroring CATALYST_GITHUB_TOKEN_SOURCE's side-channel-var convention
# (lib/catalyst-secret-env.sh). Chain: CATALYST_DEPLOYMENT_MODE env →
# Layer-2 catalyst.deployment.mode (${CATALYST_LAYER2_CONFIG_FILE:-~/.config/catalyst/config.json})
# → Layer-1 catalyst.deployment.mode (${CATALYST_CONFIG_FILE:-./.catalyst/config.json})
# → constant single-host. Never fails (always returns 0).
#
# PARITY DECISION — SUBSHELL-EXPORT FIX: _catalyst_deployment_mode_from_file
# sets its jq-missing breadcrumb by returning the @ABSENT_JQMISSING tag
# (never by exporting internally — see that function's own header) precisely
# because every call to it here is wrapped in a $(...) command substitution,
# which bash always runs in a SUBSHELL: a variable exported from inside that
# subshell is local to it and is discarded the instant $() returns, so the
# breadcrumb would silently vanish before `catalyst doctor` (or any other
# caller) could ever observe it. The fix is to capture each file lookup's
# TAGGED STDOUT into a plain local variable first — $()'s stdout capture DOES
# cross the subshell boundary — and only then, back in THIS function's own
# (non-subshelled) scope, translate the @ABSENT_JQMISSING sentinel into the
# real export plus a plain @ABSENT before handing it to classify. This also
# preserves the original laziness: the breadcrumb is only ever exported for
# a layer this call actually needed to consult (env settling the whole
# question still means neither file, nor jq's absence, is ever examined).
catalyst_resolve_deployment_mode() {
  local _cdm_mode="" _cdm_source="" _cdm_recognized="" _cdm_inferred="false"
  # The jq-missing breadcrumb reflects THIS resolution only — clear any value
  # latched by an earlier call (or inherited from a parent shell) so a later
  # call where jq is back, or where env settles without consulting files,
  # cannot report a stale active degradation to doctor.
  unset CATALYST_DEPLOYMENT_MODE_JQ_MISSING 2>/dev/null || true

  if ! _catalyst_deployment_mode_classify "$(_catalyst_deployment_mode_env_tag)" "env"; then
    # HOME fallback (parity): os.homedir() consults the passwd database when
    # HOME is unset; bash tilde expansion does the same ("If HOME is unset,
    # the home directory of the user executing the shell is substituted").
    # A bare "${HOME:-}" would silently probe /.config/catalyst/config.json
    # and skip a real Layer-2 override on HOME-less service environments.
    local _home="${HOME-}"
    [[ -z "$_home" ]] && _home=~
    local _l2="${CATALYST_LAYER2_CONFIG_FILE:-${_home}/.config/catalyst/config.json}"
    local _l2_tagged
    _l2_tagged="$(_catalyst_deployment_mode_from_file "$_l2")"
    if [[ "$_l2_tagged" == "@ABSENT_JQMISSING" ]]; then
      export CATALYST_DEPLOYMENT_MODE_JQ_MISSING=1
      _l2_tagged="@ABSENT"
    fi
    if ! _catalyst_deployment_mode_classify "$_l2_tagged" "layer2"; then
      local _l1="${CATALYST_CONFIG_FILE:-$(pwd)/.catalyst/config.json}"
      local _l1_tagged
      _l1_tagged="$(_catalyst_deployment_mode_from_file "$_l1")"
      if [[ "$_l1_tagged" == "@ABSENT_JQMISSING" ]]; then
        export CATALYST_DEPLOYMENT_MODE_JQ_MISSING=1
        _l1_tagged="@ABSENT"
      fi
      if ! _catalyst_deployment_mode_classify "$_l1_tagged" "layer1"; then
        _cdm_mode="$CATALYST_DEPLOYMENT_MODE_DEFAULT"
        _cdm_source="default"
        _cdm_recognized="true"
        _cdm_inferred="true"
      fi
    fi
  fi

  CATALYST_DEPLOYMENT_MODE_RESOLVED="$_cdm_mode"
  CATALYST_DEPLOYMENT_MODE_SOURCE="$_cdm_source"
  CATALYST_DEPLOYMENT_MODE_RECOGNIZED="$_cdm_recognized"
  CATALYST_DEPLOYMENT_MODE_INFERRED="$_cdm_inferred"
  export CATALYST_DEPLOYMENT_MODE_RESOLVED CATALYST_DEPLOYMENT_MODE_SOURCE \
    CATALYST_DEPLOYMENT_MODE_RECOGNIZED CATALYST_DEPLOYMENT_MODE_INFERRED
  printf '%s' "$_cdm_mode"
}
