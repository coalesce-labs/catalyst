#!/bin/bash
# init-project.sh - Initialize a project with thoughts using HumanLayer CLI
# Usage: ./init-project.sh [project_path] [directory_name]

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_DIR="${1:-.}"
DIRECTORY_NAME="${2:-}"

# Resolve to absolute path
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

echo -e "${YELLOW}🚀 Initializing project with thoughts${NC}"
echo "Project: $PROJECT_DIR"
echo ""

# Check if humanlayer CLI is installed
if ! command -v humanlayer &> /dev/null; then
    echo -e "${RED}❌ Error: humanlayer CLI not found${NC}"
    echo ""
    echo "Please install the HumanLayer CLI first:"
    echo "  cd /path/to/humanlayer/hlyr"
    echo "  npm install -g ."
    echo ""
    echo "Or run: ./scripts/setup-thoughts.sh"
    exit 1
fi

# Check if thoughts config exists
CONFIG_FILE="$HOME/.config/humanlayer/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}❌ Error: Thoughts not configured${NC}"
    echo ""
    echo "Please run the setup script first:"
    echo "  ./scripts/setup-thoughts.sh"
    exit 1
fi

# Check if we're in a git repository
cd "$PROJECT_DIR"
if ! git rev-parse --git-dir > /dev/null 2>&1; then
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

# Run humanlayer thoughts init
echo ""
echo -e "${YELLOW}Initializing thoughts for this project...${NC}"
echo ""

if [ -n "$DIRECTORY_NAME" ]; then
    # Non-interactive mode with directory name
    echo "Using directory name: $DIRECTORY_NAME"
    humanlayer thoughts init --directory "$DIRECTORY_NAME"
else
    # Interactive mode
    humanlayer thoughts init
fi

# Check if initialization was successful
if [ -d "$PROJECT_DIR/thoughts" ]; then
    echo ""
    echo -e "${GREEN}✅ Project initialized with thoughts!${NC}"
    echo ""
    echo "Created structure:"
    ls -la "$PROJECT_DIR/thoughts" | tail -n +4
    echo ""
    echo -e "${YELLOW}Next steps:${NC}"
    echo "1. Create the searchable index:"
    echo "   humanlayer thoughts sync"
    echo ""
    echo "2. Start documenting in thoughts/{your_name}/"
    echo ""
    echo "3. Use the workflow commands:"
    echo "   /create_plan - Interactive planning with research"
    echo "   /implement_plan - Execute a plan"
    echo "   /validate_plan - Verify implementation"
    echo ""
else
    echo -e "${YELLOW}⚠️  Thoughts initialization may have been cancelled${NC}"
fi
