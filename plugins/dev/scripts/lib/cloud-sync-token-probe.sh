#!/usr/bin/env bash
# Launchd-faithful cloud-sync token presence probe. Never prints token values.

_CSTP_SELF="${BASH_SOURCE[0]}"
_CSTP_DIR="$(cd "$(dirname "$_CSTP_SELF")" && pwd)"
source "${_CSTP_DIR}/portable-stat.sh"

cloud_sync_probe_token() {
  local host_name="" arg
  while [[ $# -gt 0 ]]; do
    arg="$1"; shift
    case "$arg" in
      --host) host_name="${1-}"; shift ;;
      *) echo "cloud_sync_probe_token: unknown argument: $arg" >&2; return 2 ;;
    esac
  done
  (
    set +u
    # Present launchd's environment, not the caller's (CAT-21 Codex P1).
    #
    # render_cloud_sync_plist's EnvironmentVariables block sets exactly PATH, HOME,
    # CATALYST_DIR and (optionally) CATALYST_HOST_NAME. Anything else the invoking
    # shell exports is invisible to the daemon, so a probe that inherits it is not
    # answering the question it claims to. Enumerating a few names to unset is what
    # this did before, and it missed CATALYST_MACHINE_CONFIG and XDG_CONFIG_HOME —
    # both of which redirect Layer-2 config resolution and therefore change which
    # token variable the probe reports. A WHITELIST cannot rot the same way: a new
    # CATALYST_* override added tomorrow is cleared here for free.
    while IFS='=' read -r _cstp_var _; do
      case "$_cstp_var" in
        CATALYST_DIR | CATALYST_HOST_NAME) continue ;;
        CATALYST_*) unset "$_cstp_var" 2>/dev/null || true ;;
      esac
    done < <(env)
    # Not CATALYST_-prefixed, but it relocates ~/.config and so selects a different
    # Layer-2 config and cluster.env/cloud-sync.env pair. The plist does not set it.
    unset XDG_CONFIG_HOME 2>/dev/null || true
    export CATALYST_HOST_NAME="$host_name"
    local cluster_file="$HOME/.config/catalyst/cluster.env"
    local cloud_file="$HOME/.config/catalyst/cloud-sync.env"
    local source_name="default" perms_warning="no"
    # Discover an override name from the launchd-visible files, clear any value
    # inherited from the interactive shell under that name, then source the
    # files again. Only the second pass is allowed to supply the token value.
    [[ -r "$cluster_file" ]] && . "$cluster_file"
    [[ -r "$cloud_file" ]] && . "$cloud_file"
    local config_dir="${CLOUD_SYNC_CONFIG_DIR:-$(cd "${_CSTP_DIR}/../execution-core" && pwd)}" name
    name="$(CFG_DIR="$config_dir" bun -e 'const m = await import(process.env.CFG_DIR + "/config.mjs"); process.stdout.write(m.resolveNodeCloudTokenEnv().envVar);' 2>/dev/null || printf 'CATALYST_CLOUD_TOKEN')"
    unset "$name" CATALYST_CLOUD_TOKEN 2>/dev/null || true
    if [[ -r "$cluster_file" ]]; then
      . "$cluster_file"
      source_name="cluster.env"
      [[ "$(portable_stat_mode "$cluster_file" || echo 0600)" == "0600" ]] || perms_warning="yes"
    fi
    if [[ -r "$cloud_file" ]]; then
      . "$cloud_file"
      source_name="cloud-sync.env"
      [[ "$(portable_stat_mode "$cloud_file" || echo 0600)" == "0600" ]] || perms_warning="yes"
    fi
    name="$(CFG_DIR="$config_dir" bun -e 'const m = await import(process.env.CFG_DIR + "/config.mjs"); process.stdout.write(m.resolveNodeCloudTokenEnv().envVar);' 2>/dev/null || printf 'CATALYST_CLOUD_TOKEN')"
    local present="no"
    [[ -n "${!name:-}" ]] && present="yes"
    printf 'name=%s\npresent=%s\nsource=%s\nperms_warning=%s\n' "$name" "$present" "$source_name" "$perms_warning"
  )
}
