#!/bin/bash
# install-user.sh - Install agents and commands to user directory
# Usage: ./install-user.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(dirname "$SCRIPT_DIR")"
USER_CLAUDE_DIR="$HOME/.claude"

echo "🚀 Installing Ryan's Claude Workspace to user directory"
echo ""
echo "Source: $WORKSPACE_DIR"
echo "Target: $USER_CLAUDE_DIR"
echo ""

# Create user .claude directories if they don't exist
mkdir -p "$USER_CLAUDE_DIR/agents"
mkdir -p "$USER_CLAUDE_DIR/commands"

# Install agents
echo "📋 Installing agents..."
AGENT_COUNT=0
for agent in "$WORKSPACE_DIR/agents"/*.md; do
    if [ -f "$agent" ]; then
        cp "$agent" "$USER_CLAUDE_DIR/agents/"
        AGENT_COUNT=$((AGENT_COUNT + 1))
        echo "  ✓ $(basename "$agent")"
    fi
done

# Install commands
echo ""
echo "📋 Installing commands..."
COMMAND_COUNT=0
for command in "$WORKSPACE_DIR/commands"/*.md; do
    if [ -f "$command" ]; then
        cp "$command" "$USER_CLAUDE_DIR/commands/"
        COMMAND_COUNT=$((COMMAND_COUNT + 1))
        echo "  ✓ $(basename "$command")"
    fi
done

echo ""
echo "✅ Installation complete!"
echo ""
echo "Installed:"
echo "  - $AGENT_COUNT agents to $USER_CLAUDE_DIR/agents/"
echo "  - $COMMAND_COUNT commands to $USER_CLAUDE_DIR/commands/"
echo ""
echo "These will be available in ALL Claude Code projects."
echo ""
echo "Next step: Restart Claude Code to load the new agents and commands"
echo ""
