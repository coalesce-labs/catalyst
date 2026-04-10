#!/usr/bin/env bash
# Catalyst Project Setup Check
# Validates that the current project is properly configured for Catalyst workflows.
# Run by workflow commands as a prerequisite check.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

errors=()
warnings=()

# 1. Check thoughts system is initialized
if [[ -d "thoughts/shared" ]]; then
  # Check subdirectories exist
  for dir in research plans handoffs prs reports; do
    if [[ ! -d "thoughts/shared/$dir" ]]; then
      warnings+=("thoughts/shared/$dir/ directory missing — run: mkdir -p thoughts/shared/$dir")
    fi
  done
else
  errors+=("Thoughts system not configured — run: humanlayer thoughts init")
fi

# 2. Check thoughts is synced (has .git or is managed)
if [[ -d "thoughts" ]] && [[ ! -d "thoughts/.git" ]] && [[ ! -L "thoughts" ]]; then
  # thoughts exists but isn't git-backed or a symlink
  warnings+=("thoughts/ exists but doesn't appear to be git-backed — run: humanlayer thoughts sync")
fi

# 3. Check CLAUDE.md has Catalyst snippet
if [[ -f "CLAUDE.md" ]]; then
  if ! grep -q "Catalyst Development Workflow" CLAUDE.md 2>/dev/null; then
    warnings+=("CLAUDE.md is missing the Catalyst workflow snippet")
    warnings+=("  Add the snippet from: plugins/dev/templates/CLAUDE_SNIPPET.md")
    warnings+=("  Or run: cat plugins/dev/templates/CLAUDE_SNIPPET.md >> CLAUDE.md")
  fi
else
  warnings+=("No CLAUDE.md found — agents will lack project-level workflow context")
  warnings+=("  Create one and add the Catalyst snippet from: plugins/dev/templates/CLAUDE_SNIPPET.md")
fi

# 4. Check .catalyst/config.json exists and has required fields
#    Backward compat: fall back to .claude/config.json if .catalyst/ doesn't exist yet
CONFIG_FILE=""
if [[ -f ".catalyst/config.json" ]]; then
  CONFIG_FILE=".catalyst/config.json"
elif [[ -f ".claude/config.json" ]]; then
  CONFIG_FILE=".claude/config.json"
  warnings+=("Config found at .claude/config.json — migrate to .catalyst/config.json")
fi

if [[ -n "$CONFIG_FILE" ]]; then
  # Check for projectKey (needed to locate secrets config file)
  PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_FILE" 2>/dev/null)
  if [[ -z "$PROJECT_KEY" ]]; then
    warnings+=("Missing catalyst.projectKey in $CONFIG_FILE — secrets config file can't be located")
    warnings+=("  Add: \"projectKey\": \"your-project-name\"")
  fi

  # Check for project.ticketPrefix (needed for document naming)
  TICKET_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // empty' "$CONFIG_FILE" 2>/dev/null)
  if [[ -z "$TICKET_PREFIX" ]]; then
    warnings+=("Missing catalyst.project.ticketPrefix in $CONFIG_FILE — document naming will default to PROJ")
  fi

  # Check for linear.teamKey (needed for ticket extraction from branch names)
  TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // empty' "$CONFIG_FILE" 2>/dev/null)
  if [[ -z "$TEAM_KEY" ]]; then
    warnings+=("Missing catalyst.linear.teamKey in $CONFIG_FILE — ticket extraction from branch names won't work")
  fi

  # Check for linear.stateMap (needed for lifecycle transitions)
  STATE_MAP=$(jq -r '.catalyst.linear.stateMap // empty' "$CONFIG_FILE" 2>/dev/null)
  if [[ -z "$STATE_MAP" ]]; then
    warnings+=("Missing catalyst.linear.stateMap in $CONFIG_FILE — Linear ticket states won't update during workflows")
    warnings+=("  See: https://catalyst.coalescelabs.ai/reference/configuration/#state-map-keys")
  fi

  # If linear fields are missing, show a single setup hint
  if [[ -z "$TEAM_KEY" || -z "$STATE_MAP" ]]; then
    warnings+=("  Run setup-catalyst.sh or add linear config manually — see docs/reference/configuration")
  fi
else
  warnings+=(".catalyst/config.json not found — run setup-catalyst.sh to create it")
fi

# 5. Ensure workflow context file exists
#    This is the auto-discovery backing store; skills and hooks depend on it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/workflow-context.sh" ]]; then
  "${SCRIPT_DIR}/workflow-context.sh" init 2>/dev/null || true
elif [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" init 2>/dev/null || true
fi

# Report errors (fatal)
if [[ ${#errors[@]} -gt 0 ]]; then
  echo -e "${RED}ERROR: Project setup incomplete${NC}"
  for err in "${errors[@]}"; do
    echo -e "  ${RED}•${NC} $err"
  done
  echo ""
  exit 1
fi

# Report warnings (non-fatal but important)
if [[ ${#warnings[@]} -gt 0 ]]; then
  echo -e "${YELLOW}WARN: Project setup has issues${NC}"
  for warn in "${warnings[@]}"; do
    echo -e "  ${YELLOW}•${NC} $warn"
  done
  echo ""
fi

# Success
if [[ ${#warnings[@]} -eq 0 ]]; then
  echo -e "${GREEN}Project setup OK${NC}"
fi
