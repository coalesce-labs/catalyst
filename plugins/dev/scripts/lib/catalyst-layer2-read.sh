#!/usr/bin/env bash
# catalyst-layer2-read.sh — the ONE merged-Layer-2 reader for the bash stack
# (CTL-1214 Phase 1).
#
# Composes the three Layer-2 files, lowest precedence first:
#   config.json  <  node.json  <  cluster-secrets.json
# and echoes the value at a caller-supplied jq path. This is the bash twin of
# execution-core/config.mjs's readLayer2Merged(); the two are held in agreement
# by __tests__/layer2-read-parity.test.sh over a fixture matrix, with each side
# additionally checked against a computed expected value.
#
# ⚠️ "config.json" above names the DEFAULT legacy file, not a fixed one: when
# CATALYST_LAYER2_CONFIG_FILE pins a path, THAT file is the legacy layer and only
# node.json / cluster-secrets.json are resolved from its directory — matching
# readLayer2MergedFrom. The parity suite now pins a non-config.json name in its
# own case, so this agreement claim is backed by a fixture that can fail.
#
# WHY this exists: CTL-1214 Phase 6 slims the committed .catalyst/config.json.
# Four relocated categories (dispatchMode, worktreeRefresh, feedback, sweep) are
# read from Layer-1 ONLY and every one of those readers is fail-open to a code
# default — so deleting them does not error, it SILENTLY reverts each knob. This
# leaf is the fallback that makes the slimming safe.
#
# ⚠️ PATH CHAIN — deliberately the LEGACY chain, not catalyst-secret-contract.sh's.
# There are two Layer-2 chains in this repo and they differ:
#   legacy    (config.mjs getLayer2ConfigPath): CATALYST_LAYER2_CONFIG_FILE > ~/.config/catalyst
#   canonical (secret-contract):  CATALYST_LAYER2_CONFIG_FILE > CATALYST_MACHINE_CONFIG
#                                 > $XDG_CONFIG_HOME/catalyst > ~/.config/catalyst
# This reader serves the SAME knobs the JS readers serve, and those readers all
# resolve through getLayer2ConfigPath(), which returns the LEGACY path on purpose
# (see its docstring: it feeds write destinations whose readers are split across
# both chains, and the canonical cutover must land as one sweep). Using the
# canonical chain here would make bash and JS resolve DIFFERENT FILES on a
# MACHINE_CONFIG/XDG-only host — a new split of exactly the kind CTL-1616 PR6
# refused to create, and it would make the parity contract unsatisfiable. So this
# tracks the legacy chain, and reports the divergence (rather than silently
# picking a side) via the CATALYST_LAYER2_READ_PATH_DIVERGENCE breadcrumb, the
# same posture as the JS warn.
#
# Failure posture is fail-open at EVERY step: an absent file, a malformed file, a
# path that indexes through a non-object, or a null value all yield empty + rc 0.
# A caller's existing default therefore still applies, which is what keeps this
# additive. jq-less hosts are a DECLARED asymmetry (matching
# lib/catalyst-deployment-mode.sh): empty + a breadcrumb + one stderr line, so the
# degradation is observable rather than silent.

[[ -n "${_CATALYST_LAYER2_READ_SH_LOADED:-}" ]] && return 0
_CATALYST_LAYER2_READ_SH_LOADED=1

# _catalyst_layer2_dir — the directory holding the three Layer-2 files.
# Mirrors config.mjs getLayer2ConfigPath()'s legacy chain, then takes its dirname
# exactly as resolveNodeConfigPath()/resolveClusterSecretsPath() do.
_catalyst_layer2_dir() {
  if [[ -n "${CATALYST_LAYER2_CONFIG_FILE:-}" ]]; then
    printf '%s' "$(dirname "$CATALYST_LAYER2_CONFIG_FILE")"
    return 0
  fi
  # HOME fallback (the catalyst-secret-contract.sh:222 lesson): a bare "${HOME:-}"
  # silently probes /.config/catalyst on a HOME-less service environment instead
  # of the real per-user default. `~` expands via the passwd entry when HOME is unset.
  local _home="${HOME-}"
  [[ -z "$_home" ]] && _home=~
  printf '%s' "${_home}/.config/catalyst"
}

# _catalyst_layer2_legacy_file — the LEGACY (lowest-precedence) Layer-2 file.
#
# ⚠️ CTL-1214 remediation. This used to be `$(_catalyst_layer2_dir)/config.json`
# unconditionally, which is NOT what the JS twin does: readLayer2MergedFrom reads
# the pinned PATH ITSELF as the legacy layer and resolves node.json /
# cluster-secrets.json as its SIBLINGS (config.mjs:558-562). So with
# CATALYST_LAYER2_CONFIG_FILE=<dir>/config-adva.json the two stacks read
# DIFFERENT FILES — measured with distinct probe values, bash returned the
# config.json value and JS the config-adva.json one — while this file's header
# claimed the two "are held in agreement over a fixture matrix". They were not:
# the parity suite pinned `${D}/config.json` at both of its call sites, so the
# one axis the implementations actually differ on could never be observed.
#
# Latent rather than live (no production setter pins a non-config.json name), but
# per-project Layer-2 files ARE named config-{projectKey}.json and several exist
# on this host, so the shape is one call away. Taking the pinned filename makes
# the two stacks agree BY CONSTRUCTION; when the pin is absent or already named
# config.json — every real case today — the resolved path is byte-identical to
# before, so this is a no-op in production.
_catalyst_layer2_legacy_file() {
  if [[ -n "${CATALYST_LAYER2_CONFIG_FILE:-}" ]]; then
    printf '%s' "$CATALYST_LAYER2_CONFIG_FILE"
    return 0
  fi
  printf '%s' "$(_catalyst_layer2_dir)/config.json"
}

# _catalyst_layer2_note_divergence — one stderr line + a breadcrumb when the
# canonical chain would have resolved a different file than the legacy chain we
# follow. Never changes the answer; makes the split observable.
_catalyst_layer2_note_divergence() {
  [[ -n "${CATALYST_LAYER2_CONFIG_FILE:-}" ]] && return 0
  [[ -z "${CATALYST_MACHINE_CONFIG:-}${XDG_CONFIG_HOME:-}" ]] && return 0
  [[ -n "${_CATALYST_LAYER2_READ_DIVERGENCE_WARNED:-}" ]] && return 0
  _CATALYST_LAYER2_READ_DIVERGENCE_WARNED=1
  export CATALYST_LAYER2_READ_PATH_DIVERGENCE=1
  echo "catalyst-layer2-read: CATALYST_MACHINE_CONFIG/XDG_CONFIG_HOME is set but this reader follows the LEGACY Layer-2 chain (parity with config.mjs getLayer2ConfigPath); pin CATALYST_LAYER2_CONFIG_FILE to make the two chains agree" >&2
}

# catalyst_layer2_json <jq-path> — echo the merged Layer-2 value at <jq-path>.
# Scalars print bare (a string without quotes); objects/arrays print as compact
# JSON. Absent / null / unindexable / malformed => empty string, rc 0.
catalyst_layer2_json() {
  local _path="${1:-}"
  [[ -z "$_path" ]] && { printf ''; return 0; }

  if ! command -v jq >/dev/null 2>&1; then
    if [[ -z "${_CATALYST_LAYER2_READ_JQ_WARNED:-}" ]]; then
      _CATALYST_LAYER2_READ_JQ_WARNED=1
      echo "catalyst-layer2-read: jq not found — Layer-2 fallback unavailable, callers keep their Layer-1 value or default (declared asymmetry)" >&2
    fi
    export CATALYST_LAYER2_READ_JQ_MISSING=1
    printf ''
    return 0
  fi

  _catalyst_layer2_note_divergence

  local _dir; _dir="$(_catalyst_layer2_dir)"
  [[ -z "$_dir" ]] && { printf ''; return 0; }
  local _legacy; _legacy="$(_catalyst_layer2_legacy_file)"

  # Build the argument list from the files that exist AND parse. A malformed file
  # must be layer-ABSENT rather than poisoning the whole merge, so each is
  # validated on its own before it joins the composition.
  local -a _files=()
  local _f
  # Lowest precedence first: the legacy file (the PINNED path when one is set —
  # see _catalyst_layer2_legacy_file), then its two siblings from _dir.
  for _f in "$_legacy" "${_dir}/node.json" "${_dir}/cluster-secrets.json"; do
    [[ -f "$_f" ]] || continue
    jq -e 'type == "object"' "$_f" >/dev/null 2>&1 || continue
    _files+=("$_f")
  done
  [[ ${#_files[@]} -eq 0 ]] && { printf ''; return 0; }

  # `reduce inputs as $x (.; . * $x)` is jq's recursive-merge fold — the same
  # deep-merge-not-replace semantics as config.mjs's _deepMergeLayer2, applied in
  # argument order so later files win. `try ... catch empty` is what survives the
  # live `catalyst.feedback` being a STRING: indexing a string throws in jq, and
  # an uncaught throw would print "Cannot index string with ..." to stderr and
  # exit non-zero. -r prints scalars bare; -c keeps objects/arrays on one line.
  local _out
  _out="$(jq -rc -n --arg p "$_path" '
      reduce inputs as $x ({}; . * $x)
      | try (getpath($p | ltrimstr(".") | split(".")))
        catch empty
      | if . == null then empty else . end
    ' "${_files[@]}" 2>/dev/null)" || _out=""
  printf '%s' "$_out"
  return 0
}
