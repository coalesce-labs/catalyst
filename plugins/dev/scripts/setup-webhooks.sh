#!/usr/bin/env bash
# setup-webhooks.sh — idempotent one-shot setup for orch-monitor webhook delivery.
#
# What this script does:
#   1. Creates a fresh smee.io channel (or reuses one supplied via $CATALYST_SMEE_CHANNEL)
#   2. Generates a 32-byte HMAC secret
#   3. Writes catalyst.monitor.github.{smeeChannel,webhookSecretEnv} into
#      .catalyst/config.json (creates the file if absent; merges with jq if present)
#   4. Persists the secret to ~/.config/catalyst/webhook-secret with mode 600
#   5. Prints the export instruction the user needs to source
#
# Re-running is safe: the script never overwrites an existing channel
# unless --force is passed.

set -euo pipefail

CONFIG_PATH=".catalyst/config.json"
SECRET_PATH="${HOME}/.config/catalyst/webhook-secret"
DEFAULT_SECRET_ENV="CATALYST_WEBHOOK_SECRET"
FORCE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--force]

Sets up webhook delivery for orch-monitor:
  • Creates a smee.io channel
  • Generates an HMAC secret
  • Writes config to ${CONFIG_PATH}
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

# ─── 1. Determine smee channel ─────────────────────────────────────────────
existing_channel=""
if [[ -f "$CONFIG_PATH" ]]; then
  existing_channel=$(jq -r '.catalyst.monitor.github.smeeChannel // ""' "$CONFIG_PATH" 2>/dev/null || true)
fi

if [[ -n "${CATALYST_SMEE_CHANNEL:-}" ]]; then
  channel="$CATALYST_SMEE_CHANNEL"
  echo "Using channel from CATALYST_SMEE_CHANNEL: $channel"
elif [[ -n "$existing_channel" && $FORCE -eq 0 ]]; then
  channel="$existing_channel"
  echo "Reusing existing channel: $channel (use --force to regenerate)"
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
mkdir -p "$(dirname "$SECRET_PATH")"
if [[ -f "$SECRET_PATH" && $FORCE -eq 0 ]]; then
  echo "Reusing existing secret at $SECRET_PATH (use --force to regenerate)"
else
  secret=$(openssl rand -hex 32)
  ( umask 077; echo "$secret" > "$SECRET_PATH" )
  chmod 600 "$SECRET_PATH"
  echo "Wrote new HMAC secret to $SECRET_PATH (mode 600)"
fi

# ─── 3. Merge config into .catalyst/config.json ────────────────────────────
mkdir -p "$(dirname "$CONFIG_PATH")"
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "{}" > "$CONFIG_PATH"
fi

tmp=$(mktemp)
jq \
  --arg channel "$channel" \
  --arg secret_env "$DEFAULT_SECRET_ENV" \
  '
    .catalyst //= {}
    | .catalyst.monitor //= {}
    | .catalyst.monitor.github //= {}
    | .catalyst.monitor.github.smeeChannel = $channel
    | .catalyst.monitor.github.webhookSecretEnv = $secret_env
  ' "$CONFIG_PATH" > "$tmp"
mv "$tmp" "$CONFIG_PATH"
echo "Updated $CONFIG_PATH"

# ─── 4. Print next steps ───────────────────────────────────────────────────
cat <<EOF

Setup complete.

Export the secret in your shell (and add to your ~/.zshrc / ~/.bashrc):

  export ${DEFAULT_SECRET_ENV}="\$(cat $SECRET_PATH)"

Then restart orch-monitor — it will tunnel deliveries from $channel to
http://localhost:7400/api/webhook and auto-subscribe each repo it observes.

EOF
