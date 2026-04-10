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

# Get repository information
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")

# Try to detect GitHub org from remote URL
GIT_REMOTE=$(git config --get remote.origin.url 2>/dev/null || echo "")
if [[ $GIT_REMOTE =~ github.com[:/]([^/]+)/([^/.]+) ]]; then
	GITHUB_ORG="${BASH_REMATCH[1]}"
	GITHUB_REPO="${BASH_REMATCH[2]}"
else
	GITHUB_ORG=""
	GITHUB_REPO="$REPO_NAME"
fi

# Determine worktree base path using convention
# Convention: <GITHUB_SOURCE_ROOT>/<org>/<repo>-worktrees/<worktree-name>
# Main checkout: <GITHUB_SOURCE_ROOT>/<org>/<repo>
# Worktrees: <GITHUB_SOURCE_ROOT>/<org>/<repo>-worktrees/<feature>
if [ -n "$GITHUB_SOURCE_ROOT" ]; then
	# Use GITHUB_SOURCE_ROOT convention
	if [ -n "$GITHUB_ORG" ]; then
		WORKTREES_BASE="${GITHUB_SOURCE_ROOT}/${GITHUB_ORG}/${GITHUB_REPO}-worktrees"
	else
		WORKTREES_BASE="${GITHUB_SOURCE_ROOT}/${GITHUB_REPO}-worktrees"
	fi
else
	# Default fallback: ~/wt/<repo>
	WORKTREES_BASE="$HOME/wt/${REPO_NAME}"
fi

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

# Copy .claude directory if it exists (Claude Code native config)
if [ -d ".claude" ]; then
	echo "📋 Copying .claude directory..."
	cp -r .claude "$WORKTREE_PATH/"
fi

# Copy .catalyst directory if it exists (Catalyst workflow config)
if [ -d ".catalyst" ]; then
	echo "📋 Copying .catalyst directory..."
	cp -r .catalyst "$WORKTREE_PATH/"
fi

# Change to worktree directory
cd "$WORKTREE_PATH"

# Run setup if Makefile exists
if [ -f "Makefile" ] && grep -q "^setup:" Makefile; then
	echo "🔧 Running setup..."
	if ! make setup; then
		echo -e "${RED}❌ Setup failed. Cleaning up worktree...${NC}"
		cd - >/dev/null
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

	# Detect current profile from parent directory
	CURRENT_PROFILE=$(humanlayer thoughts status 2>/dev/null | grep -i "Profile:" | head -1 | awk '{print $2}')

	# Build init command with profile if detected
	INIT_CMD="humanlayer thoughts init --directory $REPO_NAME"
	if [ -n "$CURRENT_PROFILE" ]; then
		INIT_CMD="$INIT_CMD --profile $CURRENT_PROFILE"
		echo "📋 Using profile from parent: $CURRENT_PROFILE"
	fi

	if eval "$INIT_CMD" >/dev/null 2>&1; then
		echo -e "${GREEN}✅ Thoughts initialized for ${REPO_NAME}${NC}"
		echo "🔄 Syncing with shared thoughts repository..."
		if humanlayer thoughts sync >/dev/null 2>&1; then
			echo -e "${GREEN}✅ Thoughts synced! Worktree has access to:${NC}"
			echo "   - Shared research documents"
			echo "   - Implementation plans"
			echo "   - Handoff documents"
		else
			echo -e "${YELLOW}⚠️  Sync warning: Run 'humanlayer thoughts sync' manually in worktree${NC}"
		fi
	else
		echo -e "${YELLOW}⚠️  Could not initialize thoughts. Run 'humanlayer thoughts init --directory ${REPO_NAME}' manually.${NC}"
	fi
else
	echo -e "${RED}❌ HumanLayer CLI not found! Catalyst workflows require HumanLayer.${NC}"
	echo "   Install: pip install humanlayer"
	echo "   Then run: humanlayer thoughts init --directory ${REPO_NAME}"
	echo "             humanlayer thoughts sync"
fi

# Return to original directory
cd - >/dev/null

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
