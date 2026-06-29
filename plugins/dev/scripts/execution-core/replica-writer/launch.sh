#!/usr/bin/env bash
# execution-core/replica-writer/launch.sh — CTL-1394. Resolve this node's cloud token
# and exec the supervised replica writer (replica-writer.mjs) in the FOREGROUND under
# bun, mirroring updater/launch.sh's `exec` template so launchd KeepAlive supervises the
# REAL daemon (death → restart).
#
# WHY A LAUNCHER
#   launchd does NOT source ~/.zshenv and does NOT run direnv, so the per-node cloud token
#   (which lives in the operator's shell secret store) is invisible to the plist. This
#   launcher sources the 0600 token file(s) on disk so the writer sees its CATALYST_*_TOKEN
#   by name, then `exec`s bun on replica-writer.mjs. The token VALUE is only ever inherited
#   via the sourced file's env — NEVER written into the (world-readable) plist, NEVER echoed.
set -uo pipefail

# ─── SCRIPT_DIR (symlink-walking) ────────────────────────────────────────────
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"
unset _SRC

log()  { printf '[catalyst-replica] %s\n' "$*"; }
fail() { printf '[catalyst-replica] ERROR: %s\n' "$*" >&2; exit 1; }

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
export CATALYST_DIR

# ─── Preflight ───────────────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH — install it (https://bun.sh) or run install-cli.sh"
WRITER_MJS="${SCRIPT_DIR}/../replica-writer.mjs"
[[ -f "$WRITER_MJS" ]] || fail "replica-writer.mjs not found at $WRITER_MJS"

# ─── Source the per-node token from a 0600 file (launchd can't see ~/.zshenv/direnv) ──
# Order: cluster.env (the existing shared-token projection, CTL-1307) then the dedicated
# operator-provisioned replica-writer.env (the per-node token VALUE). `set +u` so a
# `set -u` tripwire inside a sourced file can't abort us; we never print what we source.
# A node with neither file (or a token only in an interactive-shell secret store) reaches
# the writer with the var UNSET → the writer fail-open no-ops and doctor surfaces the gap.
set +u
[[ -r "$HOME/.config/catalyst/cluster.env" ]] && . "$HOME/.config/catalyst/cluster.env"
[[ -r "$HOME/.config/catalyst/replica-writer.env" ]] && . "$HOME/.config/catalyst/replica-writer.env"
set -u

# ─── Cloud feed coordinates (overridable; sane prod defaults) ────────────────
export CATALYST_CLOUD_BASE_URL="${CATALYST_CLOUD_BASE_URL:-https://api.catalyst-cloud.coalescelabs.ai/api/v1}"
export CATALYST_CLOUD_ACCOUNT="${CATALYST_CLOUD_ACCOUNT:-tenant-0}"

# CATALYST_HOST_NAME may arrive pinned from the plist EnvironmentVariables; otherwise the
# writer's resolveNodeCloudTokenEnv() resolves the node name from Layer-2 in JS.
log "launching replica writer (node=${CATALYST_HOST_NAME:-<layer2/os>}, account=${CATALYST_CLOUD_ACCOUNT})"
exec bun "$WRITER_MJS"
