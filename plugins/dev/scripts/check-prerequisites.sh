#!/usr/bin/env bash
# Catalyst Dev Plugin Prerequisites Check
# Validates required and optional CLI tools

set -euo pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Required tools (command:name:install-instruction)
REQUIRED_TOOLS=(
	"humanlayer:HumanLayer CLI:pip install humanlayer"
	"jq:JSON processor:brew install jq"
	"gh:GitHub CLI:brew install gh"
	"linearis:Linear CLI:npm install -g linearis"
	"agent-browser:Browser automation:npm install -g agent-browser && agent-browser install"
)

# Optional tools - used by specific agents only (command:name:install-instruction)
OPTIONAL_TOOLS=(
	"railway:Railway CLI (for railway-research agent):npm install -g @railway/cli"
	"sentry-cli:Sentry CLI (for sentry-research agent):curl -sL https://sentry.io/get-cli/ | sh"
)

# Optional MCP servers (name:purpose:install-command)
OPTIONAL_MCPS=(
	"exa:Web search:/plugin marketplace add exa-labs/exa-mcp-server"
	"posthog:Analytics:/plugin marketplace add posthog-mcp"
)

echo "🔍 Checking Catalyst dev plugin prerequisites..."
echo ""

missing=()

# Check required tools
for tool_spec in "${REQUIRED_TOOLS[@]}"; do
	IFS=: read -r cmd name install <<<"$tool_spec"
	if ! command -v "$cmd" &>/dev/null; then
		missing+=("$name ($install)")
	fi
done

if [ ${#missing[@]} -gt 0 ]; then
	echo -e "${RED}❌ Missing required tools:${NC}"
	for tool in "${missing[@]}"; do
		echo -e "   ${RED}•${NC} $tool"
	done
	echo ""
	echo "Install missing tools and run again."
	exit 1
fi

echo -e "${GREEN}✅ All required CLI tools installed${NC}"
echo ""

# Check optional tools (warn but don't block)
missing_optional=false
for tool_spec in "${OPTIONAL_TOOLS[@]}"; do
	IFS=: read -r cmd name install <<<"$tool_spec"
	if ! command -v "$cmd" &>/dev/null; then
		echo -e "   ${YELLOW}⚠️${NC}  $name not found (optional)"
		echo -e "      Install: $install"
		missing_optional=true
	fi
done

if [ "$missing_optional" = true ]; then
	echo ""
fi

# Optional: Check MCP servers
echo "ℹ️  Optional MCP servers:"
for mcp_spec in "${OPTIONAL_MCPS[@]}"; do
	IFS=: read -r name purpose install <<<"$mcp_spec"
	echo -e "   • ${YELLOW}$name${NC} ($purpose): $install"
done

echo ""
echo -e "${GREEN}✅ Prerequisites check complete${NC}"
