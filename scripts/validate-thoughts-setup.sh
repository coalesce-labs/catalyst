#!/bin/bash
# Validate that thoughts system is properly configured

set -e

THOUGHTS_DIR="thoughts/shared"

echo "🔍 Validating thoughts system setup..."

# Check if thoughts directory exists
if [[ ! -d "$THOUGHTS_DIR" ]]; then
  echo ""
  echo "❌ ERROR: Thoughts system not configured!"
  echo ""
  echo "The thoughts system is REQUIRED for Catalyst workflows."
  echo "It provides:"
  echo "  - Persistent context across sessions"
  echo "  - Shared memory across worktrees"
  echo "  - Team collaboration via git-backed storage"
  echo ""
  echo "📚 Setup instructions:"
  echo "  1. Run: ./scripts/humanlayer/init-project.sh . {project-name}"
  echo "  2. Configure HumanLayer: humanlayer thoughts sync"
  echo ""
  echo "See: docs/CONFIGURATION.md for details"
  echo ""
  exit 1
fi

# Check required subdirectories
REQUIRED_DIRS=("research" "plans" "handoffs" "prs")
MISSING_DIRS=()

for dir in "${REQUIRED_DIRS[@]}"; do
  if [[ ! -d "$THOUGHTS_DIR/$dir" ]]; then
    MISSING_DIRS+=("$dir")
  fi
done

if [[ ${#MISSING_DIRS[@]} -gt 0 ]]; then
  echo ""
  echo "⚠️  WARNING: Missing thoughts subdirectories:"
  for dir in "${MISSING_DIRS[@]}"; do
    echo "  - thoughts/shared/$dir/"
  done
  echo ""
  echo "Creating missing directories..."
  for dir in "${MISSING_DIRS[@]}"; do
    mkdir -p "$THOUGHTS_DIR/$dir"
    echo "  ✅ Created: thoughts/shared/$dir/"
  done
fi

# Check if thoughts is a git repo (HumanLayer setup)
if [[ ! -d "$THOUGHTS_DIR/.git" ]] && [[ ! -L "thoughts" ]]; then
  echo ""
  echo "⚠️  WARNING: Thoughts directory exists but is not a git repo"
  echo ""
  echo "For best results, initialize HumanLayer thoughts:"
  echo "  ./scripts/humanlayer/init-project.sh . {project-name}"
  echo ""
  echo "This enables:"
  echo "  - Git-backed persistence"
  echo "  - Sync across machines/worktrees"
  echo "  - Team collaboration"
  echo ""
fi

echo "✅ Thoughts system validated"
echo "   Location: $THOUGHTS_DIR/"
echo ""
