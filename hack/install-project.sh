#!/bin/bash
# install-project.sh - Install agents and commands to specific project
# Usage: ./install-project.sh [project_path]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="${1:-.}"

# Source frontmatter utilities
source "$SCRIPT_DIR/frontmatter-utils.sh"

# Resolve to absolute path
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

# Check if we're installing into the workspace itself
is_workspace_install() {
    [[ "$PROJECT_DIR" -ef "$WORKSPACE_DIR" ]]
}

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
SKIPPED_COUNT=0
for command in "$WORKSPACE_DIR/commands"/*.md; do
    if [ -f "$command" ]; then
        filename=$(basename "$command")

        # Skip workspace-only commands unless installing to workspace itself
        if ! is_workspace_install && should_skip_on_install "$command"; then
            echo "  ○ Skipped: $filename (workspace-only)"
            SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
            continue
        fi

        cp "$command" "$PROJECT_DIR/.claude/commands/"
        COMMAND_COUNT=$((COMMAND_COUNT + 1))
        echo "  ✓ $(basename "$command")"
    fi
done

if [[ $SKIPPED_COUNT -gt 0 ]]; then
    echo "  (Skipped $SKIPPED_COUNT workspace-only commands)"
fi

# Install config.json if it exists
echo ""
if [ -f "$WORKSPACE_DIR/.claude/config.json" ]; then
    echo "📋 Installing config.json..."
    cp "$WORKSPACE_DIR/.claude/config.json" "$PROJECT_DIR/.claude/"
    echo "  ✓ config.json (customize for your project)"
fi

# Create initial metadata file
echo ""
echo "📋 Creating workspace metadata..."
WORKSPACE_VERSION=$(cd "$WORKSPACE_DIR" && git rev-parse HEAD 2>/dev/null || echo "unknown")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$PROJECT_DIR/.claude/.workspace-metadata.json" <<EOF
{
  "workspaceVersion": "$WORKSPACE_VERSION",
  "lastUpdated": "$TIMESTAMP",
  "installedFiles": {}
}
EOF
echo "  ✓ .workspace-metadata.json"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Installed to: $PROJECT_DIR/.claude/"
echo "  - $AGENT_COUNT agents"
echo "  - $COMMAND_COUNT commands"
echo "  - config.json (template)"
echo "  - .workspace-metadata.json (tracking)"
echo ""
echo "These will ONLY be available in this project."
echo ""
echo "📝 Next steps:"
echo "1. Customize .claude/config.json with your project settings"
echo "2. Run /linear in Claude Code to configure Linear integration (if needed)"
echo "3. Restart Claude Code if working in this project"
echo ""
echo "📦 To update from workspace later:"
echo "   From workspace: ./hack/update-project.sh $PROJECT_DIR"
echo "   Or in Claude: /update-project $PROJECT_DIR"
echo ""
echo "Note: Project .claude/ takes precedence over user ~/.claude/"
echo "Workspace version: $(echo $WORKSPACE_VERSION | cut -c1-8)"
echo ""
