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
_CATALYST_DEPLOYMENT_MODES="single-host cluster cloud"
CATALYST_DEPLOYMENT_MODE_DEFAULT="single-host"

# _catalyst_deployment_mode_is_member VALUE — true iff VALUE (already
# trimmed + lowercased) names one of the enum members.
_catalyst_deployment_mode_is_member() {
  local _v="$1" _m
  for _m in $_CATALYST_DEPLOYMENT_MODES; do
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
#   @ABSENT   — key not present (or file unreadable/malformed/jq missing)
#   @NULL     — value is JSON null
#   @STR:xxx  — value is the string "xxx" (may itself be empty)
#   @NONSTR   — value is present and NOT a string (bool/number/array/object)
# @ABSENT and @NULL both mean "fall through" to classify, exactly like
# classifyCandidate's `raw === undefined || raw === null` rung. @NONSTR means
# "settle here, degraded" — never falls through. Never fails the caller.
_catalyst_deployment_mode_from_file() {
  local _f="$1"
  if [[ ! -r "$_f" ]]; then
    printf '@ABSENT'
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    # File exists but we have no way to parse it — see the JQ-ABSENT
    # DIVERGENCE note atop this file. Loud breadcrumb, not a stderr print.
    export CATALYST_DEPLOYMENT_MODE_JQ_MISSING=1
    printf '@ABSENT'
    return 0
  fi
  jq -r '
    (.catalyst.deployment // {})
    | if has("mode") then
        (.mode
         | if . == null then "@NULL"
           elif type == "string" then "@STR:" + .
           else "@NONSTR"
           end)
      else "@ABSENT"
      end
  ' "$_f" 2>/dev/null || printf '@ABSENT'
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
#   Trim is pure parameter expansion (bash 3.2-safe, no external process, no
#   quote/backslash reinterpretation of the value — quote characters in the
#   raw value are DATA, never re-parsed as shell syntax). Lowercase via
#   `tr '[:upper:]' '[:lower:]'` (also bash-3.2-safe; ${var,,} is bash 4+).
#   [:space:] covers space/tab/\n/\v/\f/\r, so a CRLF-suffixed value trims
#   cleanly — the previous xargs-based trimmer mis-happened, erroring on
#   unmatched quotes (masked by `|| true`) and re-interpreting quote/
#   backslash characters as shell syntax instead of leaving them as data.
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

  _norm="$_raw"
  _norm="${_norm#"${_norm%%[![:space:]]*}"}"
  _norm="${_norm%"${_norm##*[![:space:]]}"}"
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
catalyst_resolve_deployment_mode() {
  local _cdm_mode="" _cdm_source="" _cdm_recognized="" _cdm_inferred="false"

  if ! _catalyst_deployment_mode_classify "$(_catalyst_deployment_mode_env_tag)" "env"; then
    local _l2="${CATALYST_LAYER2_CONFIG_FILE:-${HOME:-}/.config/catalyst/config.json}"
    if ! _catalyst_deployment_mode_classify "$(_catalyst_deployment_mode_from_file "$_l2")" "layer2"; then
      local _l1="${CATALYST_CONFIG_FILE:-$(pwd)/.catalyst/config.json}"
      if ! _catalyst_deployment_mode_classify "$(_catalyst_deployment_mode_from_file "$_l1")" "layer1"; then
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
