#!/bin/bash
# init-project.sh - Initialize a project with thoughts using HumanLayer CLI
# Usage: ./init-project.sh [project_path] [directory_name] [config_name]
#
# Arguments:
#   project_path   - Path to project (default: current directory)
#   directory_name - Name for thoughts directory (optional, will prompt if not provided)
#   config_name    - HumanLayer config name (e.g., "brkthru", "coalesce-labs")
#                    Will use ~/.config/humanlayer/config-{name}.json
#                    Also stores in .claude/config.json for per-project config

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_DIR="${1:-.}"
DIRECTORY_NAME="${2-}"
CONFIG_NAME="${3-}"

# Resolve to absolute path
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

echo -e "${YELLOW}🚀 Initializing project with thoughts${NC}"
echo "Project: $PROJECT_DIR"
if [ -n "$CONFIG_NAME" ]; then
	echo "Config: $CONFIG_NAME (will use ~/.config/humanlayer/config-${CONFIG_NAME}.json)"
fi
echo ""

# Check if humanlayer CLI is installed
if ! command -v humanlayer &>/dev/null; then
	echo -e "${RED}❌ Error: humanlayer CLI not found${NC}"
	echo ""
	echo "Please install the HumanLayer CLI first:"
	echo "  pip install humanlayer"
	echo "  # or"
	echo "  pipx install humanlayer"
	echo ""
	echo "Or run: ./scripts/humanlayer/setup-thoughts.sh"
	exit 1
fi

# Determine which config file to use
if [ -n "$CONFIG_NAME" ]; then
	CONFIG_FILE="$HOME/.config/humanlayer/config-${CONFIG_NAME}.json"
	if [ ! -f "$CONFIG_FILE" ]; then
		echo -e "${RED}❌ Error: Config not found: $CONFIG_FILE${NC}"
		echo ""
		echo "Available configs:"
		ls -1 ~/.config/humanlayer/config-*.json 2>/dev/null | sed 's/.*config-\(.*\)\.json/  - \1/' || echo "  (none found)"
		echo ""
		echo "Create a new config with:"
		echo "  ./scripts/humanlayer/add-client-config $CONFIG_NAME /path/to/thoughts"
		exit 1
	fi
	CONFIG_FLAG="--config-file $CONFIG_FILE"
else
	# Use default config
	CONFIG_FILE="$HOME/.config/humanlayer/config.json"
	if [ ! -f "$CONFIG_FILE" ]; then
		echo -e "${RED}❌ Error: Thoughts not configured${NC}"
		echo ""
		echo "Please run the setup script first:"
		echo "  ./scripts/humanlayer/setup-thoughts.sh"
		exit 1
	fi
	CONFIG_FLAG=""
fi

# Check if we're in a git repository
cd "$PROJECT_DIR"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
	echo -e "${RED}❌ Error: Not a git repository${NC}"
	echo "The project must be a git repository to use thoughts."
	echo ""
	read -p "Initialize git repository now? (Y/n) " -n 1 -r
	echo
	if [[ ! $REPLY =~ ^[Nn]$ ]]; then
		git init
		echo -e "${GREEN}✓ Git repository initialized${NC}"
	else
		exit 1
	fi
fi

# Run humanlayer thoughts init with appropriate config
echo ""
echo -e "${YELLOW}Initializing thoughts for this project...${NC}"
echo ""

if [ -n "$DIRECTORY_NAME" ]; then
	# Non-interactive mode with directory name
	echo "Using directory name: $DIRECTORY_NAME"
	humanlayer thoughts init $CONFIG_FLAG --directory "$DIRECTORY_NAME"
else
	# Interactive mode
	humanlayer thoughts init $CONFIG_FLAG
fi

# Store configName in .claude/config.json if provided
if [ -n "$CONFIG_NAME" ]; then
	CLAUDE_CONFIG="$PROJECT_DIR/.claude/config.json"

	# Create .claude directory if it doesn't exist
	mkdir -p "$PROJECT_DIR/.claude"

	# Create or update config.json
	if [ -f "$CLAUDE_CONFIG" ]; then
		# Update existing config using jq
		if command -v jq &>/dev/null; then
			TMP=$(mktemp)
			jq ".thoughts.configName = \"$CONFIG_NAME\"" "$CLAUDE_CONFIG" > "$TMP"
			mv "$TMP" "$CLAUDE_CONFIG"
			echo -e "${GREEN}✓ Updated .claude/config.json with configName: $CONFIG_NAME${NC}"
		else
			echo -e "${YELLOW}⚠️  jq not found - please manually add to .claude/config.json:${NC}"
			echo "  \"thoughts\": {"
			echo "    \"configName\": \"$CONFIG_NAME\""
			echo "  }"
		fi
	else
		# Create new config
		cat > "$CLAUDE_CONFIG" <<EOF
{
  "thoughts": {
    "configName": "$CONFIG_NAME"
  }
}
EOF
		echo -e "${GREEN}✓ Created .claude/config.json with configName: $CONFIG_NAME${NC}"
	fi
fi

# Check if initialization was successful
if [ -d "$PROJECT_DIR/thoughts" ]; then
	echo ""
	echo -e "${GREEN}✅ Project initialized with thoughts!${NC}"
	echo ""
	echo "Created structure:"
	ls -la "$PROJECT_DIR/thoughts" | tail -n +4
	echo ""
	if [ -n "$CONFIG_NAME" ]; then
		echo -e "${GREEN}✓ Per-project config set to: $CONFIG_NAME${NC}"
		echo "  All humanlayer commands will automatically use config-${CONFIG_NAME}.json"
		echo ""
	fi
	echo -e "${YELLOW}Next steps:${NC}"
	echo "1. Create the searchable index:"
	echo "   humanlayer thoughts sync"
	echo ""
	echo "2. Start documenting in thoughts/{your_name}/"
	echo ""
	echo "3. Use the workflow commands:"
	echo "   /create-plan - Interactive planning with research"
	echo "   /implement-plan - Execute a plan"
	echo "   /validate-plan - Verify implementation"
	echo ""
else
	echo -e "${YELLOW}⚠️  Thoughts initialization may have been cancelled${NC}"
fi
