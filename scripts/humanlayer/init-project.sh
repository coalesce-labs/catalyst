#!/bin/bash
# init-project.sh - Initialize a project with thoughts using HumanLayer CLI
# Usage: ./init-project.sh [project_path] [directory_name] [profile]
#
# Arguments:
#   project_path   - Path to project (default: current directory)
#   directory_name - Name for thoughts directory (optional, will prompt if not provided)
#   profile        - HumanLayer profile name (e.g., "coalesce-labs", "ryanrozich")
#                    If not provided, will try to detect from current directory

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_DIR="${1:-.}"
DIRECTORY_NAME="${2-}"
PROFILE="${3-}"

# Resolve to absolute path
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

echo -e "${YELLOW}Initializing project with thoughts${NC}"
echo "Project: $PROJECT_DIR"

# Check if humanlayer CLI is installed
if ! command -v humanlayer &>/dev/null; then
    echo -e "${RED}Error: humanlayer CLI not found${NC}"
    exit 1
fi

# Check if we're in a git repository
cd "$PROJECT_DIR"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo -e "${RED}Error: Not a git repository${NC}"
    exit 1
fi

# If no profile provided, try to detect from current environment
if [ -z "$PROFILE" ]; then
    DETECTED_PROFILE=$(humanlayer thoughts status 2>/dev/null | grep -i "Profile:" | head -1 | awk '{print $2}')
    if [ -n "$DETECTED_PROFILE" ]; then
        PROFILE="$DETECTED_PROFILE"
        echo "Profile: $PROFILE (auto-detected)"
    fi
else
    echo "Profile: $PROFILE"
fi
echo ""

# Build humanlayer command
HL_CMD="humanlayer thoughts init"
if [ -n "$PROFILE" ]; then
    HL_CMD="$HL_CMD --profile $PROFILE"
fi
if [ -n "$DIRECTORY_NAME" ]; then
    HL_CMD="$HL_CMD --directory $DIRECTORY_NAME"
fi

# Run humanlayer thoughts init
echo -e "${YELLOW}Running: $HL_CMD${NC}"
eval $HL_CMD

# Verify initialization
if [ -d "$PROJECT_DIR/thoughts" ]; then
    echo ""
    echo -e "${GREEN}Project initialized with thoughts!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. humanlayer thoughts sync"
    echo "2. Start using /research-codebase, /create-plan, etc."
fi
