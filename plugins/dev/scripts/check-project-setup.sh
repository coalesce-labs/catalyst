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
  for dir in research plans handoffs prs; do
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

# 4. Check .claude/config.json exists
if [[ ! -f ".claude/config.json" ]]; then
  warnings+=(".claude/config.json not found — ticket prefix will default to PROJ")
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
