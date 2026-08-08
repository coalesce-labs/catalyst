#!/usr/bin/env bash
# Launchd-faithful cloud-sync token presence probe. Never prints token values.

_CSTP_SELF="${BASH_SOURCE[0]}"
_CSTP_DIR="$(cd "$(dirname "$_CSTP_SELF")" && pwd)"

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
    unset CATALYST_CLOUD_TOKEN CATALYST_CLOUD_TOKEN_ENV CATALYST_LAYER2_CONFIG_FILE 2>/dev/null || true
    export CATALYST_HOST_NAME="$host_name"
    local cluster_file="$HOME/.config/catalyst/cluster.env"
    local cloud_file="$HOME/.config/catalyst/cloud-sync.env"
    local source_name="default" perms_warning="no"
    if [[ -r "$cluster_file" ]]; then
      . "$cluster_file"
      source_name="cluster.env"
      [[ "$(stat -f '%Lp' "$cluster_file" 2>/dev/null || stat -c '%a' "$cluster_file" 2>/dev/null || echo 600)" == "600" ]] || perms_warning="yes"
    fi
    if [[ -r "$cloud_file" ]]; then
      . "$cloud_file"
      source_name="cloud-sync.env"
      [[ "$(stat -f '%Lp' "$cloud_file" 2>/dev/null || stat -c '%a' "$cloud_file" 2>/dev/null || echo 600)" == "600" ]] || perms_warning="yes"
    fi
    local config_dir="${CLOUD_SYNC_CONFIG_DIR:-$(cd "${_CSTP_DIR}/../execution-core" && pwd)}" name
    name="$(CFG_DIR="$config_dir" bun -e 'const m = await import(process.env.CFG_DIR + "/config.mjs"); process.stdout.write(m.resolveNodeCloudTokenEnv().envVar);' 2>/dev/null || printf 'CATALYST_CLOUD_TOKEN')"
    local present="no"
    [[ -n "${!name:-}" ]] && present="yes"
    printf 'name=%s\npresent=%s\nsource=%s\nperms_warning=%s\n' "$name" "$present" "$source_name" "$perms_warning"
  )
}
