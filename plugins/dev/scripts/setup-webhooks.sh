#!/usr/bin/env bash
# setup-webhooks.sh — idempotent one-shot setup for orch-monitor webhook delivery.
#
# What this script does:
#   1. Creates a fresh smee.io channel (or reuses one supplied via $CATALYST_SMEE_CHANNEL)
#   2. Generates a 32-byte HMAC secret
#   3. Writes catalyst.monitor.github.smeeChannel to ~/.config/catalyst/config.json
#      (cross-project, per-machine — one smee tunnel serves every project on this laptop)
#   4. Writes catalyst.monitor.github.webhookSecretEnv to .catalyst/config.json
#      (team-wide repo config — env-var NAME only, never the value)
#   5. Persists the secret to ~/.config/catalyst/webhook-secret with mode 600
#   6. Migrates a deprecated smeeChannel out of .catalyst/config.json if present
#
# Re-running is safe: the script never overwrites an existing channel
# unless --force is passed.

set -euo pipefail

PROJECT_CONFIG_PATH=".catalyst/config.json"
HOME_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"
HOME_CONFIG_PATH="${HOME_CONFIG_DIR}/config.json"
SECRET_PATH="${HOME_CONFIG_DIR}/webhook-secret"
DEFAULT_SECRET_ENV="CATALYST_WEBHOOK_SECRET"
FORCE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--force]

Sets up webhook delivery for orch-monitor:
  • Creates a smee.io channel
  • Generates an HMAC secret
  • Writes channel URL to ${HOME_CONFIG_PATH} (cross-project, per-machine)
  • Writes env-var name to ${PROJECT_CONFIG_PATH} (team-wide repo config)
  • Persists the secret to ${SECRET_PATH} (mode 600)

Options:
  --force    Overwrite existing channel/secret if already configured
  -h|--help  Show this message

Environment:
  CATALYST_SMEE_CHANNEL  Reuse this smee URL instead of generating one
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' is required but not installed" >&2
    exit 1
  fi
}

require_cmd jq
require_cmd curl
require_cmd openssl

read_smee_channel_from() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  jq -r '.catalyst.monitor.github.smeeChannel // ""' "$path" 2>/dev/null || true
}

# ─── 1. Determine smee channel ─────────────────────────────────────────────
existing_home_channel=$(read_smee_channel_from "$HOME_CONFIG_PATH")
existing_project_channel=$(read_smee_channel_from "$PROJECT_CONFIG_PATH")

if [[ -n "${CATALYST_SMEE_CHANNEL:-}" ]]; then
  channel="$CATALYST_SMEE_CHANNEL"
  echo "Using channel from CATALYST_SMEE_CHANNEL: $channel"
elif [[ -n "$existing_home_channel" && $FORCE -eq 0 ]]; then
  channel="$existing_home_channel"
  echo "Reusing existing channel from $HOME_CONFIG_PATH: $channel (use --force to regenerate)"
elif [[ -n "$existing_project_channel" && $FORCE -eq 0 ]]; then
  # Migrate deprecated location.
  channel="$existing_project_channel"
  echo "Found deprecated smeeChannel in $PROJECT_CONFIG_PATH — migrating to $HOME_CONFIG_PATH"
else
  echo "Creating new smee.io channel..."
  # smee.io/new responds with HTTP 307 to GET (not POST). Follow the redirect
  # with -L and capture the final URL via %{url_effective}.
  channel=$(curl -s -L -o /dev/null -w "%{url_effective}" https://smee.io/new)
  if [[ -z "$channel" || "$channel" != https://smee.io/* || "$channel" == "https://smee.io/new" ]]; then
    echo "ERROR: failed to create smee channel (got: $channel)" >&2
    exit 1
  fi
  echo "  → $channel"
fi

# ─── 2. Generate or reuse secret ───────────────────────────────────────────
mkdir -p "$HOME_CONFIG_DIR"
if [[ -f "$SECRET_PATH" && $FORCE -eq 0 ]]; then
  echo "Reusing existing secret at $SECRET_PATH (use --force to regenerate)"
else
  secret=$(openssl rand -hex 32)
  ( umask 077; echo "$secret" > "$SECRET_PATH" )
  chmod 600 "$SECRET_PATH"
  echo "Wrote new HMAC secret to $SECRET_PATH (mode 600)"
fi

# ─── 3. Write smeeChannel to cross-project home-dir config ────────────────
if [[ ! -f "$HOME_CONFIG_PATH" ]]; then
  echo "{}" > "$HOME_CONFIG_PATH"
fi
tmp=$(mktemp)
jq --arg channel "$channel" \
  '
    .catalyst //= {}
    | .catalyst.monitor //= {}
    | .catalyst.monitor.github //= {}
    | .catalyst.monitor.github.smeeChannel = $channel
  ' "$HOME_CONFIG_PATH" > "$tmp"
mv "$tmp" "$HOME_CONFIG_PATH"
echo "Updated $HOME_CONFIG_PATH"

# ─── 4. Write webhookSecretEnv to per-repo project config ─────────────────
mkdir -p "$(dirname "$PROJECT_CONFIG_PATH")"
if [[ ! -f "$PROJECT_CONFIG_PATH" ]]; then
  echo "{}" > "$PROJECT_CONFIG_PATH"
fi
tmp=$(mktemp)
jq --arg secret_env "$DEFAULT_SECRET_ENV" \
  '
    .catalyst //= {}
    | .catalyst.monitor //= {}
    | .catalyst.monitor.github //= {}
    | .catalyst.monitor.github.webhookSecretEnv = $secret_env
  ' "$PROJECT_CONFIG_PATH" > "$tmp"
mv "$tmp" "$PROJECT_CONFIG_PATH"
echo "Updated $PROJECT_CONFIG_PATH"

# ─── 5. Migrate: drop deprecated smeeChannel from project config ───────────
if [[ -n "$existing_project_channel" ]]; then
  tmp=$(mktemp)
  jq '
    del(.catalyst.monitor.github.smeeChannel)
    | if (.catalyst.monitor.github // {}) == {} then del(.catalyst.monitor.github) else . end
    | if (.catalyst.monitor // {}) == {} then del(.catalyst.monitor) else . end
    | if (.catalyst // {}) == {} then del(.catalyst) else . end
  ' "$PROJECT_CONFIG_PATH" > "$tmp"
  mv "$tmp" "$PROJECT_CONFIG_PATH"
  echo "→ Removed deprecated smeeChannel from $PROJECT_CONFIG_PATH (commit this change)"
fi

# ─── 6. Print next steps ───────────────────────────────────────────────────
cat <<EOF

Setup complete.

Export the secret in your shell (and add to your ~/.zshrc / ~/.bashrc):

  export ${DEFAULT_SECRET_ENV}="\$(cat $SECRET_PATH)"

Then restart orch-monitor — it will tunnel deliveries from $channel to
http://localhost:7400/api/webhook and auto-subscribe each repo it observes.

EOF
