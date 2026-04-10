#!/usr/bin/env bash
# Catalyst PM Plugin Prerequisites Check
# Validates required and optional CLI tools for PM workflows

set -euo pipefail

echo "Checking PM plugin prerequisites..."

# Check for humanlayer CLI (used by multiple PM commands)
if ! command -v humanlayer &> /dev/null; then
    echo "❌ HumanLayer CLI not found (required for thoughts system)"
    echo "Install with:"
    echo "  pip install humanlayer"
    echo "  # or: pipx install humanlayer"
    exit 1
fi

echo "✅ HumanLayer CLI found"

# Check for linearis CLI
if ! command -v linearis &> /dev/null; then
    echo "❌ Linearis CLI not found"
    echo "Install with:"
    echo "  npm install -g linearis"
    exit 1
fi

echo "✅ Linearis CLI found: $(linearis --version)"

# Check for jq (JSON parsing)
if ! command -v jq &> /dev/null; then
    echo "❌ jq not found (required for JSON parsing)"
    echo "Install with:"
    echo "  brew install jq  # macOS"
    echo "  apt install jq   # Ubuntu/Debian"
    exit 1
fi

echo "✅ jq found: $(jq --version)"

# Check for gh CLI (GitHub operations)
if ! command -v gh &> /dev/null; then
    echo "⚠️  GitHub CLI not found (optional for PR sync)"
    echo "Install with:"
    echo "  brew install gh  # macOS"
    echo "  See: https://cli.github.com"
else
    echo "✅ GitHub CLI found: $(gh --version | head -n1)"
fi

# Check for gcalcli (optional - only used by calendar-analyzer agent)
if ! command -v gcalcli &> /dev/null; then
    echo "⚠️  gcalcli not found (optional, for calendar-analyzer agent)"
    echo "Install with: pip install gcalcli"
else
    echo "✅ gcalcli found"
fi

# Verify configuration
CONFIG_FILE=".catalyst/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "❌ Configuration file not found: $CONFIG_FILE"
    exit 1
fi

# Check Linear configuration
TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // empty' "$CONFIG_FILE")
if [[ -z "$TEAM_KEY" ]]; then
    echo "⚠️  Linear team key not configured in $CONFIG_FILE"
    echo "Add: \"catalyst\": { \"linear\": { \"teamKey\": \"TEAM\" } }"
else
    echo "✅ Linear team key configured: $TEAM_KEY"
fi

echo ""
echo "✅ All prerequisites met!"
exit 0
