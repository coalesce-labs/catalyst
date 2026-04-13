#!/bin/bash
# create-worktree.sh - Create a git worktree for isolated development
# Usage: ./create-worktree.sh [worktree_name] [base_branch] [--worktree-dir <path>] [--hooks-json <json>]
#
# Options:
#   --worktree-dir <path>   Override worktree base directory (used by orchestrator)
#   --hooks-json <json>     JSON array of setup hook commands to run after creation

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Parse flags (collect positional args separately)
POSITIONAL=()
OVERRIDE_WORKTREE_DIR=""
HOOKS_JSON=""

while [[ $# -gt 0 ]]; do
	case $1 in
		--worktree-dir) OVERRIDE_WORKTREE_DIR="$2"; shift 2 ;;
		--hooks-json) HOOKS_JSON="$2"; shift 2 ;;
		*) POSITIONAL+=("$1"); shift ;;
	esac
done

# Get worktree name from positional args
if [ ${#POSITIONAL[@]} -eq 0 ]; then
	echo -e "${RED}Error: Worktree name is required${NC}"
	echo "Usage: ./create-worktree.sh <worktree_name> [base_branch] [--worktree-dir <path>] [--hooks-json <json>]"
	echo ""
	echo "Examples:"
	echo "  ./create-worktree.sh ENG-123"
	echo "  ./create-worktree.sh feature-auth main"
	echo "  ./create-worktree.sh orch-1-ENG-123 main --worktree-dir ~/catalyst/my-app"
	exit 1
fi

WORKTREE_NAME="${POSITIONAL[0]}"
BASE_BRANCH="${POSITIONAL[1]:-$(git branch --show-current)}"

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

# Resolve Catalyst config file (.catalyst/ first, then .claude/)
CONFIG_FILE=""
for CFG in "${REPO_ROOT}/.catalyst/config.json" "${REPO_ROOT}/.claude/config.json"; do
	if [ -f "$CFG" ]; then
		CONFIG_FILE="$CFG"
		break
	fi
done

PROJECT_KEY=""
WT_DIR_CONFIG=""
if [ -n "$CONFIG_FILE" ]; then
	PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_FILE" 2>/dev/null)
	WT_DIR_CONFIG=$(jq -r '.catalyst.orchestration.worktreeDir // empty' "$CONFIG_FILE" 2>/dev/null)
fi

# Determine worktree base path (priority order):
# 1. --worktree-dir flag (explicit override, used by orchestrator)
# 2. catalyst.orchestration.worktreeDir from config
# 3. ~/catalyst/wt/<projectKey>/ (default — read projectKey from config)
# 4. ~/catalyst/wt/<repo>/ (fallback if no config)
if [ -n "$OVERRIDE_WORKTREE_DIR" ]; then
	WORKTREES_BASE="${OVERRIDE_WORKTREE_DIR/#\~/$HOME}"
elif [ -n "$WT_DIR_CONFIG" ]; then
	WORKTREES_BASE="${WT_DIR_CONFIG/#\~/$HOME}"
elif [ -n "$PROJECT_KEY" ]; then
	WORKTREES_BASE="$HOME/catalyst/wt/${PROJECT_KEY}"
else
	WORKTREES_BASE="$HOME/catalyst/wt/${REPO_NAME}"
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

# Initialize workflow context with ticket from worktree name (before setup runs)
# This ensures .catalyst/.workflow-context.json exists with currentTicket set
# so that direnv's use_otel_context can read it when someone enters the directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/workflow-context.sh" ]; then
	# Remove stale workflow-context.json if copied from main repo
	rm -f "${WORKTREE_PATH}/.catalyst/.workflow-context.json"
	mkdir -p "${WORKTREE_PATH}/.catalyst"

	# Extract ticket from worktree name (e.g., ENG-123, orch-1-ADV-42)
	WT_TICKET=""
	if [[ "$WORKTREE_NAME" =~ ([A-Za-z]+-[0-9]+) ]]; then
		WT_TICKET=$(echo "${BASH_REMATCH[1]}" | tr '[:lower:]' '[:upper:]')
	fi

	(cd "$WORKTREE_PATH" && bash "${SCRIPT_DIR}/workflow-context.sh" init)
	if [ -n "$WT_TICKET" ]; then
		(cd "$WORKTREE_PATH" && bash "${SCRIPT_DIR}/workflow-context.sh" set-ticket "$WT_TICKET")
		echo "📋 Workflow context initialized with ticket: ${WT_TICKET}"
	else
		echo "📋 Workflow context initialized (no ticket in worktree name)"
	fi
fi

# Generate .envrc for OTEL context (source_up inherits parent profiles)
OTEL_PROJECT="${PROJECT_KEY:-$REPO_NAME}"
if command -v direnv >/dev/null 2>&1 && [ ! -f "${WORKTREE_PATH}/.envrc" ]; then
	cat > "${WORKTREE_PATH}/.envrc" <<EOF
source_up
use_otel_context "${OTEL_PROJECT}"
EOF
	direnv allow "${WORKTREE_PATH}" 2>/dev/null || true
	echo "📡 OTEL context configured (.envrc created + allowed)"
fi

# Change to worktree directory
cd "$WORKTREE_PATH"

# ============================================================
# WORKTREE SETUP
#
# Setup commands are read from catalyst.worktree.setup in config.
# If configured, ONLY those commands run (full control to the project).
# If not configured, falls back to auto-detected setup for backwards compat.
#
# Available variables in setup commands:
#   ${WORKTREE_PATH}  — absolute path to the new worktree
#   ${BRANCH_NAME}    — git branch name
#   ${TICKET_ID}      — same as branch name (useful for orchestrator-prefixed names)
#   ${REPO_NAME}      — repository name
#   ${DIRECTORY}       — thoughts directory name (defaults to repo name)
#   ${PROFILE}         — thoughts profile (auto-detected or from config)
# ============================================================

# Read thoughts config for variable substitution
THOUGHTS_PROFILE=""
THOUGHTS_DIRECTORY="$REPO_NAME"
if [ -n "$CONFIG_FILE" ]; then
	THOUGHTS_PROFILE=$(jq -r '.catalyst.thoughts.profile // empty' "$CONFIG_FILE" 2>/dev/null)
	THOUGHTS_DIR_CFG=$(jq -r '.catalyst.thoughts.directory // empty' "$CONFIG_FILE" 2>/dev/null)
	if [ -n "$THOUGHTS_DIR_CFG" ]; then
		THOUGHTS_DIRECTORY="$THOUGHTS_DIR_CFG"
	fi
fi

# Auto-detect profile from parent if not in config
if [ -z "$THOUGHTS_PROFILE" ] && command -v humanlayer >/dev/null 2>&1; then
	THOUGHTS_PROFILE=$(humanlayer thoughts status 2>/dev/null | grep -i "Profile:" | head -1 | awk '{print $2}')
fi

# Helper: substitute variables in a command string
substitute_vars() {
	local CMD="$1"
	CMD="${CMD//\$\{WORKTREE_PATH\}/$WORKTREE_PATH}"
	CMD="${CMD//\$\{BRANCH_NAME\}/$WORKTREE_NAME}"
	CMD="${CMD//\$\{TICKET_ID\}/$WORKTREE_NAME}"
	CMD="${CMD//\$\{REPO_NAME\}/$REPO_NAME}"
	CMD="${CMD//\$\{DIRECTORY\}/$THOUGHTS_DIRECTORY}"
	CMD="${CMD//\$\{PROFILE\}/$THOUGHTS_PROFILE}"
	echo "$CMD"
}

# Helper: run an array of commands from JSON with variable substitution
run_hook_array() {
	local JSON_ARRAY="$1"
	local LABEL="$2"
	local HOOK_COUNT
	HOOK_COUNT=$(echo "$JSON_ARRAY" | jq -r 'length' 2>/dev/null || echo 0)

	for i in $(seq 0 $((HOOK_COUNT - 1))); do
		local HOOK_CMD
		HOOK_CMD=$(echo "$JSON_ARRAY" | jq -r ".[$i]" 2>/dev/null)
		if [ -n "$HOOK_CMD" ] && [ "$HOOK_CMD" != "null" ]; then
			HOOK_CMD=$(substitute_vars "$HOOK_CMD")
			echo "  [$LABEL] Running: $HOOK_CMD"
			if ! eval "$HOOK_CMD"; then
				echo -e "${YELLOW}⚠️  $LABEL hook failed: $HOOK_CMD${NC}"
			fi
		fi
	done
}

# Read setup commands from config
SETUP_COMMANDS=""
if [ -n "$CONFIG_FILE" ]; then
	SETUP_COMMANDS=$(jq -c '.catalyst.worktree.setup // empty' "$CONFIG_FILE" 2>/dev/null)
fi

if [ -n "$SETUP_COMMANDS" ] && [ "$SETUP_COMMANDS" != "null" ] && [ "$SETUP_COMMANDS" != "[]" ]; then
	# ── Config-driven setup ──
	echo -e "${YELLOW}🔧 Running project setup from config...${NC}"
	run_hook_array "$SETUP_COMMANDS" "setup"
else
	# ── Auto-detected setup (backwards compatibility) ──
	echo -e "${YELLOW}🔧 Running auto-detected setup (no catalyst.worktree.setup in config)${NC}"

	# 1. Install dependencies
	if [ -f "Makefile" ] && grep -q "^setup:" Makefile; then
		echo "  Running: make setup"
		if ! make setup; then
			echo -e "${RED}❌ Setup failed. Cleaning up worktree...${NC}"
			cd - >/dev/null
			git worktree remove --force "$WORKTREE_PATH"
			git branch -D "$WORKTREE_NAME" 2>/dev/null || true
			exit 1
		fi
	elif [ -f "package.json" ]; then
		if command -v bun >/dev/null 2>&1; then
			echo "  Running: bun install"
			bun install
		else
			echo "  Running: npm install"
			npm install
		fi
	fi

	# 2. Initialize thoughts
	if command -v humanlayer >/dev/null 2>&1; then
		INIT_CMD="humanlayer thoughts init --directory $THOUGHTS_DIRECTORY"
		if [ -n "$THOUGHTS_PROFILE" ]; then
			INIT_CMD="$INIT_CMD --profile $THOUGHTS_PROFILE"
		fi
		echo "  Running: $INIT_CMD"
		if eval "$INIT_CMD" >/dev/null 2>&1; then
			echo -e "${GREEN}  ✅ Thoughts initialized${NC}"
			echo "  Running: humanlayer thoughts sync"
			humanlayer thoughts sync >/dev/null 2>&1 || echo -e "${YELLOW}  ⚠️  Sync warning: run 'humanlayer thoughts sync' manually${NC}"
		else
			echo -e "${YELLOW}  ⚠️  Could not initialize thoughts${NC}"
		fi
	else
		echo -e "${YELLOW}  ⚠️  HumanLayer CLI not found — skipping thoughts init${NC}"
	fi
fi

# Run additional orchestration hooks if provided via --hooks-json
# These run AFTER the base setup (config-driven or auto-detected)
if [ -n "$HOOKS_JSON" ] && [ "$HOOKS_JSON" != "[]" ]; then
	echo -e "${YELLOW}🔧 Running orchestration hooks...${NC}"
	run_hook_array "$HOOKS_JSON" "orchestration"
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
