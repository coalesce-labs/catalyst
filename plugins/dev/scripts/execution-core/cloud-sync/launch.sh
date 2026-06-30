#!/usr/bin/env bash
# execution-core/cloud-sync/launch.sh — CTL-1394. Resolve this node's cloud token
# and exec the supervised cloud-sync daemon (cloud-sync.mjs) in the FOREGROUND under
# bun, mirroring updater/launch.sh's `exec` template so launchd KeepAlive supervises the
# REAL daemon (death → restart).
#
# WHY A LAUNCHER
#   launchd does NOT source ~/.zshenv and does NOT run direnv, so the per-node cloud token
#   (which lives in the operator's shell secret store) is invisible to the plist. This
#   launcher sources the 0600 token file(s) on disk so the writer sees its CATALYST_*_TOKEN
#   by name, then `exec`s bun on cloud-sync.mjs. The token VALUE is only ever inherited
#   via the sourced file's env — NEVER written into the (world-readable) plist, NEVER echoed.
set -uo pipefail

# ─── SCRIPT_DIR (symlink-walking) ────────────────────────────────────────────
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

log()  { printf '[catalyst-cloud-sync] %s\n' "$*"; }
fail() { printf '[catalyst-cloud-sync] ERROR: %s\n' "$*" >&2; exit 1; }

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
export CATALYST_DIR

# ─── Preflight ───────────────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH — install it (https://bun.sh) or run install-cli.sh"
# CANONICALIZE the writer path (collapse the `..`) so the launched argv is a clean
# `.../execution-core/cloud-sync.mjs` — otherwise pgrep-by-path liveness checks
# (catalyst doctor, catalyst-stack) see `cloud-sync/../cloud-sync.mjs` and miss it.
WRITER_MJS="$(cd "${SCRIPT_DIR}/.." 2>/dev/null && pwd)/cloud-sync.mjs"
[[ -f "$WRITER_MJS" ]] || fail "cloud-sync.mjs not found at $WRITER_MJS"

# ─── Secret-hygiene: refuse to leak a group/world-readable token file ─────────
# The whole point of sourcing the token from a 0600 file (not the world-readable plist)
# is that no other local user can read the cloud token. If the operator forgot `chmod 600`,
# warn LOUDLY (but still source it, so a perms slip doesn't strand the writer).
_warn_if_readable() {
  local f="$1"
  [[ -r "$f" ]] || return 0
  # stat perms portably (BSD/macOS -f%Lp, GNU -c%a). Last two octal digits = group + other;
  # if either has the read bit (4) set, the secret is exposed to other local users.
  local mode
  mode="$(stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f" 2>/dev/null || echo '')"
  [[ "$mode" =~ ^[0-7]+$ ]] || return 0
  local grp=$(( ${mode: -2:1} )) oth=$(( ${mode: -1:1} ))
  if (( (grp & 4) != 0 || (oth & 4) != 0 )); then
    printf '[catalyst-cloud-sync] WARN: %s is group/other-readable (mode %s) — chmod 600 it so the cloud token cannot be read by other local users\n' "$f" "$mode" >&2
  fi
}

# ─── Source the per-node token from a 0600 file (launchd can't see ~/.zshenv/direnv) ──
# Order: cluster.env (the existing shared-token projection, CTL-1307) then the dedicated
# operator-provisioned cloud-sync.env (the per-node token VALUE). `set +u` so a
# `set -u` tripwire inside a sourced file can't abort us; we never print what we source.
# A node with neither file (or a token only in an interactive-shell secret store) reaches
# the writer with the var UNSET → the writer fail-open no-ops and doctor surfaces the gap.
set +u
_warn_if_readable "$HOME/.config/catalyst/cluster.env"
[[ -r "$HOME/.config/catalyst/cluster.env" ]] && . "$HOME/.config/catalyst/cluster.env"
_warn_if_readable "$HOME/.config/catalyst/cloud-sync.env"
[[ -r "$HOME/.config/catalyst/cloud-sync.env" ]] && . "$HOME/.config/catalyst/cloud-sync.env"
set -u

# ─── Cloud feed coordinates (overridable; sane prod defaults) ────────────────
export CATALYST_CLOUD_BASE_URL="${CATALYST_CLOUD_BASE_URL:-https://api.catalyst-cloud.coalescelabs.ai/api/v1}"
export CATALYST_CLOUD_ACCOUNT="${CATALYST_CLOUD_ACCOUNT:-tenant-0}"

# CATALYST_HOST_NAME may arrive pinned from the plist EnvironmentVariables; otherwise the
# writer's resolveNodeCloudTokenEnv() resolves the node name from Layer-2 in JS.
log "launching cloud-sync (node=${CATALYST_HOST_NAME:-<layer2/os>}, account=${CATALYST_CLOUD_ACCOUNT})"
exec bun "$WRITER_MJS"
