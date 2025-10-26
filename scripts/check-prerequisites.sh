#!/usr/bin/env bash
# Catalyst Prerequisites Check
# Validates all required CLI tools are installed

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
  "linearis:Linear CLI:npm install -g --install-links ryanrozich/linearis#feat/cycles-cli"
  "railway:Railway CLI:npm install -g @railway/cli"
  "sentry-cli:Sentry CLI:curl -sL https://sentry.io/get-cli/ | sh"
)

# Optional MCP servers (name:purpose:install-command)
OPTIONAL_MCPS=(
  "exa:Web search:/plugin marketplace add exa-labs/exa-mcp-server"
  "posthog:Analytics:/plugin marketplace add posthog-mcp"
)

echo "🔍 Checking Catalyst prerequisites..."
echo ""

missing=()

# Check required tools
for tool_spec in "${REQUIRED_TOOLS[@]}"; do
  IFS=: read -r cmd name install <<< "$tool_spec"
  if ! command -v "$cmd" &> /dev/null; then
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

# Optional: Check MCP servers
echo "ℹ️  Optional MCP servers:"
for mcp_spec in "${OPTIONAL_MCPS[@]}"; do
  IFS=: read -r name purpose install <<< "$mcp_spec"
  echo -e "   • ${YELLOW}$name${NC} ($purpose): $install"
done

echo ""
echo -e "${GREEN}✅ Prerequisites check complete${NC}"
