#!/bin/bash
# setup-thoughts.sh - Initialize the central thoughts repository using HumanLayer CLI
# Usage: ./setup-thoughts.sh

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🧠 Setting up thoughts repository${NC}"
echo ""

# Check if humanlayer CLI is installed
if ! command -v humanlayer &> /dev/null; then
    echo -e "${RED}❌ Error: humanlayer CLI not found${NC}"
    echo ""
    echo "The thoughts system uses the HumanLayer CLI to manage the central repository."
    echo ""
    echo "Installation options:"
    echo ""
    echo "1. If you have the humanlayer repo cloned:"
    echo "   cd /path/to/humanlayer/hlyr"
    echo "   npm install -g ."
    echo ""
    echo "2. Or install from npm (when published):"
    echo "   npm install -g @humanlayer/cli"
    echo ""
    exit 1
fi

echo -e "${GREEN}✓ HumanLayer CLI found${NC}"
echo ""

# Check if thoughts config already exists
CONFIG_FILE="$HOME/.config/humanlayer/config.json"

if [ -f "$CONFIG_FILE" ]; then
    echo -e "${YELLOW}⚠️  Thoughts configuration already exists${NC}"
    echo "Config file: $CONFIG_FILE"
    echo ""

    # Show current configuration
    echo "Current configuration:"
    if command -v jq &> /dev/null; then
        jq -r '.thoughts | "  Repository: \(.thoughtsRepo)\n  User: \(.user)"' "$CONFIG_FILE" 2>/dev/null || cat "$CONFIG_FILE"
    else
        cat "$CONFIG_FILE"
    fi
    echo ""

    read -p "Continue anyway? This will re-initialize if you run humanlayer thoughts init. (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborting."
        echo ""
        echo "Your thoughts system is already configured."
        echo "To initialize a new project, just run:"
        echo "  cd /path/to/your-project"
        echo "  humanlayer thoughts init"
        exit 0
    fi
fi

echo "The HumanLayer CLI will now guide you through setting up your thoughts repository."
echo ""
echo "This will:"
echo "  1. Prompt for your thoughts repository location (default: ~/thoughts)"
echo "  2. Ask for your username"
echo "  3. Create the directory structure"
echo "  4. Initialize it as a git repository"
echo "  5. Save the configuration to $CONFIG_FILE"
echo ""
echo "After this setup, you can initialize any project with:"
echo "  cd /path/to/project"
echo "  humanlayer thoughts init"
echo ""

read -p "Ready to proceed? (Y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo "Setup cancelled."
    exit 0
fi

echo ""
echo -e "${YELLOW}Starting HumanLayer thoughts initialization...${NC}"
echo ""

# Create a temporary project directory to run the initial setup
TEMP_SETUP_DIR=$(mktemp -d)
cd "$TEMP_SETUP_DIR"

# Initialize a temporary git repo (required by humanlayer thoughts init)
git init > /dev/null 2>&1

# Run humanlayer thoughts init (this will create the global config)
humanlayer thoughts init

# Clean up temp directory
cd - > /dev/null
rm -rf "$TEMP_SETUP_DIR"

echo ""
echo -e "${GREEN}✅ Thoughts repository setup complete!${NC}"
echo ""

# Show configuration
if [ -f "$CONFIG_FILE" ]; then
    echo "Configuration saved to: $CONFIG_FILE"
    echo ""
    if command -v jq &> /dev/null; then
        THOUGHTS_REPO=$(jq -r '.thoughts.thoughtsRepo' "$CONFIG_FILE")
        USER_NAME=$(jq -r '.thoughts.user' "$CONFIG_FILE")
        echo "  Repository: $THOUGHTS_REPO"
        echo "  Username: $USER_NAME"
    fi
    echo ""
fi

echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo "1. Initialize a project with thoughts:"
echo "   cd /path/to/your-project"
echo "   humanlayer thoughts init"
echo ""
echo "2. Or use the helper script:"
echo "   ./scripts/init-project.sh /path/to/project project-name"
echo ""
echo "3. Optional: Set up remote backup for your thoughts:"
if [ -f "$CONFIG_FILE" ] && command -v jq &> /dev/null; then
    THOUGHTS_REPO=$(jq -r '.thoughts.thoughtsRepo' "$CONFIG_FILE")
    echo "   cd $THOUGHTS_REPO"
    echo "   gh repo create my-thoughts --private --source=. --push"
fi
echo ""
