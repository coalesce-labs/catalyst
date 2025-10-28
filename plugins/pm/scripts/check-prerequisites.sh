#!/usr/bin/env bash
set -euo pipefail

echo "Checking PM plugin prerequisites..."

# Check for linearis CLI
if ! command -v linearis &> /dev/null; then
    echo "❌ Linearis CLI not found"
    echo "Install with:"
    echo "  npm install -g --install-links czottmann/linearis"
    echo ""
    echo "Note: Requires PR #4 features (cycle management)"
    echo "  https://github.com/czottmann/linearis/pull/4"
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

# Verify configuration
CONFIG_FILE=".claude/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "❌ Configuration file not found: $CONFIG_FILE"
    exit 1
fi

# Check Linear configuration
TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // empty' "$CONFIG_FILE")
if [[ -z "$TEAM_KEY" ]]; then
    echo "⚠️  Linear team key not configured in $CONFIG_FILE"
    echo "Add: \"linear\": { \"teamKey\": \"TEAM\" }"
else
    echo "✅ Linear team key configured: $TEAM_KEY"
fi

# Check for LINEAR_API_TOKEN
if [[ -z "${LINEAR_API_TOKEN:-}" ]]; then
    echo "⚠️  LINEAR_API_TOKEN environment variable not set"
    echo "Set with: export LINEAR_API_TOKEN=your_token"
else
    echo "✅ LINEAR_API_TOKEN set"
fi

echo ""
echo "✅ All prerequisites met!"
exit 0
