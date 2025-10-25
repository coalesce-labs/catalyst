#!/bin/bash
# create-worktree.sh - Create a git worktree for isolated development
# Usage: ./create-worktree.sh [worktree_name] [base_branch]

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Get worktree name from parameter or generate one
if [ -z "$1" ]; then
    echo -e "${RED}Error: Worktree name is required${NC}"
    echo "Usage: ./create-worktree.sh <worktree_name> [base_branch]"
    echo ""
    echo "Examples:"
    echo "  ./create-worktree.sh ENG-123"
    echo "  ./create-worktree.sh feature-auth main"
    exit 1
fi

WORKTREE_NAME="$1"
BASE_BRANCH="${2:-$(git branch --show-current)}"

# Get base directory name
REPO_BASE_NAME=$(basename "$(git rev-parse --show-toplevel)")

# Use custom worktree location or default
WORKTREES_BASE="${RYAN_WORKTREE_BASE:-$HOME/wt}/${REPO_BASE_NAME}"
WORKTREE_PATH="${WORKTREES_BASE}/${WORKTREE_NAME}"

echo -e "${YELLOW}🌳 Creating worktree: ${WORKTREE_NAME}${NC}"
echo "📁 Location: ${WORKTREE_PATH}"
echo "🔀 Base branch: ${BASE_BRANCH}"
echo ""

# Check if worktrees base directory exists
if [ ! -d "$WORKTREES_BASE" ]; then
    echo "Creating worktree base directory: $WORKTREES_BASE"
    mkdir -p "$WORKTREES_BASE"
fi

# Check if worktree already exists
if [ -d "$WORKTREE_PATH" ]; then
    echo -e "${RED}❌ Error: Worktree directory already exists: $WORKTREE_PATH${NC}"
    exit 1
fi

# Create worktree
if git show-ref --verify --quiet "refs/heads/${WORKTREE_NAME}"; then
    echo "📋 Using existing branch: ${WORKTREE_NAME}"
    git worktree add "$WORKTREE_PATH" "$WORKTREE_NAME"
else
    echo "🆕 Creating new branch: ${WORKTREE_NAME}"
    git worktree add -b "$WORKTREE_NAME" "$WORKTREE_PATH" "$BASE_BRANCH"
fi

# Copy .claude directory if it exists
if [ -d ".claude" ]; then
    echo "📋 Copying .claude directory..."
    cp -r .claude "$WORKTREE_PATH/"
fi

# Change to worktree directory
cd "$WORKTREE_PATH"

# Run setup if Makefile exists
if [ -f "Makefile" ] && grep -q "^setup:" Makefile; then
    echo "🔧 Running setup..."
    if ! make setup; then
        echo -e "${RED}❌ Setup failed. Cleaning up worktree...${NC}"
        cd - > /dev/null
        git worktree remove --force "$WORKTREE_PATH"
        git branch -D "$WORKTREE_NAME" 2>/dev/null || true
        exit 1
    fi
elif [ -f "package.json" ]; then
    echo "🔧 Installing dependencies..."
    if command -v bun >/dev/null 2>&1; then
        bun install
    else
        npm install
    fi
fi

# Initialize thoughts (REQUIRED for Catalyst workflows)
if command -v humanlayer >/dev/null 2>&1; then
    echo "🧠 Initializing HumanLayer thoughts system..."
    if humanlayer thoughts init --directory "$REPO_BASE_NAME" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Thoughts initialized for ${REPO_BASE_NAME}${NC}"
        echo "🔄 Syncing with shared thoughts repository..."
        if humanlayer thoughts sync > /dev/null 2>&1; then
            echo -e "${GREEN}✅ Thoughts synced! Worktree has access to:${NC}"
            echo "   - Shared research documents"
            echo "   - Implementation plans"
            echo "   - Handoff documents"
        else
            echo -e "${YELLOW}⚠️  Sync warning: Run 'humanlayer thoughts sync' manually in worktree${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  Could not initialize thoughts. Run 'humanlayer thoughts init --directory ${REPO_BASE_NAME}' manually.${NC}"
    fi
else
    echo -e "${RED}❌ HumanLayer CLI not found! Catalyst workflows require HumanLayer.${NC}"
    echo "   Install: pip install humanlayer"
    echo "   Then run: humanlayer thoughts init --directory ${REPO_BASE_NAME}"
    echo "             humanlayer thoughts sync"
fi

# Return to original directory
cd - > /dev/null

echo ""
echo -e "${GREEN}✅ Worktree created successfully!${NC}"
echo "📁 Path: ${WORKTREE_PATH}"
echo "🔀 Branch: ${WORKTREE_NAME}"
echo ""
echo "To work in this worktree:"
echo "  cd ${WORKTREE_PATH}"
echo ""
echo "To remove this worktree later:"
echo "  git worktree remove ${WORKTREE_PATH}"
echo "  git branch -D ${WORKTREE_NAME}"
echo ""
