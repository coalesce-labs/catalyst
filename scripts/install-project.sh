#!/bin/bash
# install-project.sh - Install agents and commands to specific project
# Usage: ./install-project.sh [project_path]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="${1:-.}"

# Resolve to absolute path
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

echo "🚀 Installing Ryan's Claude Workspace to project"
echo ""
echo "Source: $WORKSPACE_DIR"
echo "Target: $PROJECT_DIR/.claude"
echo ""

# Create project .claude directories
mkdir -p "$PROJECT_DIR/.claude/agents"
mkdir -p "$PROJECT_DIR/.claude/commands"

# Install agents
echo "📋 Installing agents..."
AGENT_COUNT=0
for agent in "$WORKSPACE_DIR/agents"/*.md; do
    if [ -f "$agent" ]; then
        cp "$agent" "$PROJECT_DIR/.claude/agents/"
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
        cp "$command" "$PROJECT_DIR/.claude/commands/"
        COMMAND_COUNT=$((COMMAND_COUNT + 1))
        echo "  ✓ $(basename "$command")"
    fi
done

echo ""
echo "✅ Installation complete!"
echo ""
echo "Installed to: $PROJECT_DIR/.claude/"
echo "  - $AGENT_COUNT agents"
echo "  - $COMMAND_COUNT commands"
echo ""
echo "These will ONLY be available in this project."
echo ""
echo "Note: Project .claude/ takes precedence over user ~/.claude/"
echo "You can customize these for project-specific needs."
echo ""
echo "Next step: Restart Claude Code if working in this project"
echo ""
