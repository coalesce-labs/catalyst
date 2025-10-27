#!/bin/bash
# Migrate existing config to new secure format

set -e

CONFIG_DIR="$HOME/.config/catalyst"
mkdir -p "$CONFIG_DIR"

echo "🔧 Catalyst Config Setup"
echo ""
echo "This will move secrets from .claude/config.json to ~/.config/catalyst/"
echo ""

# Get project key from user
read -p "Enter project key (e.g., 'acme', 'work', 'personal'): " PROJECT_KEY

# Read current .claude/config.json
if [[ -f ".claude/config.json" ]]; then
  echo "✅ Found existing .claude/config.json"

  # Extract secrets to ~/.config/catalyst/config-$PROJECT_KEY.json
  jq '{
    linear: .linear,
    sentry: .sentry,
    railway: .railway,
    posthog: .posthog,
    exa: .exa
  }' .claude/config.json > "$CONFIG_DIR/config-$PROJECT_KEY.json"

  echo "✅ Created $CONFIG_DIR/config-$PROJECT_KEY.json"

  # Update .claude/config.json to reference external config
  jq '{
    projectKey: $projectKey,
    project: .project,
    thoughts: .thoughts
  } | .projectKey = $projectKey' \
    --arg projectKey "$PROJECT_KEY" \
    .claude/config.json > .claude/config.json.tmp

  mv .claude/config.json.tmp .claude/config.json
  echo "✅ Updated .claude/config.json"
else
  echo "⚠️ No existing .claude/config.json found"
  echo "Creating new config..."

  # Create new external config
  cat > "$CONFIG_DIR/config-$PROJECT_KEY.json" <<EOF
{
  "linear": {
    "apiToken": "[NEEDS_SETUP]",
    "teamKey": "[NEEDS_SETUP]",
    "defaultTeam": "[NEEDS_SETUP]"
  },
  "sentry": {
    "org": "[NEEDS_SETUP]",
    "project": "[NEEDS_SETUP]",
    "authToken": "[NEEDS_SETUP]"
  },
  "railway": {
    "token": "[NEEDS_SETUP]",
    "projectId": "[NEEDS_SETUP]"
  },
  "posthog": {
    "apiKey": "[NEEDS_SETUP]",
    "projectId": "[NEEDS_SETUP]"
  },
  "exa": {
    "apiKey": "[NEEDS_SETUP]"
  }
}
EOF

  # Create .claude/config.json
  mkdir -p .claude
  cat > .claude/config.json <<EOF
{
  "projectKey": "$PROJECT_KEY",
  "project": {
    "ticketPrefix": "PROJ",
    "name": "My Project"
  },
  "thoughts": {
    "user": null
  }
}
EOF
fi

echo ""
echo "✅ Config setup complete!"
echo ""
echo "📝 Next steps:"
echo "  1. Edit ~/.config/catalyst/config-$PROJECT_KEY.json to add your API tokens"
echo "  2. Verify .claude/config.json is safe to commit (no secrets)"
echo "  3. Add .claude/config.json to git"
echo ""
