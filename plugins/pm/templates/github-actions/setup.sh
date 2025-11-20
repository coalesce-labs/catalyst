#!/usr/bin/env bash
#
# Catalyst PM Plugin - GitHub Actions Setup Script
#
# This script installs GitHub Actions workflows into your thoughts repository
# for automated daily reporting.
#
# Usage:
#   ./setup.sh <thoughts-repo-path> <project-key> <code-repos>
#
# Example:
#   ./setup.sh ~/thoughts/repos/myproject myproject "org/repo-1,org/repo-2"
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Helper functions
error() {
  echo -e "${RED}❌ ERROR: $1${NC}" >&2
  exit 1
}

success() {
  echo -e "${GREEN}✅ $1${NC}"
}

info() {
  echo -e "${BLUE}ℹ️  $1${NC}"
}

warning() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

# Check arguments
if [ $# -lt 3 ]; then
  echo "Usage: $0 <thoughts-repo-path> <project-key> <code-repos>"
  echo ""
  echo "Arguments:"
  echo "  thoughts-repo-path  Path to your thoughts repository (e.g., ~/thoughts/repos/myproject)"
  echo "  project-key         Project key identifier (e.g., myproject)"
  echo "  code-repos          Comma-separated list of code repos (e.g., org/repo-1,org/repo-2)"
  echo ""
  echo "Example:"
  echo "  $0 ~/thoughts/repos/myproject myproject \"org/api,org/web\""
  exit 1
fi

THOUGHTS_REPO="$1"
PROJECT_KEY="$2"
CODE_REPOS="$3"

# Expand tilde if present
THOUGHTS_REPO="${THOUGHTS_REPO/#\~/$HOME}"

info "Catalyst PM Plugin - GitHub Actions Setup"
echo ""
echo "Configuration:"
echo "  Thoughts repo: $THOUGHTS_REPO"
echo "  Project key:   $PROJECT_KEY"
echo "  Code repos:    $CODE_REPOS"
echo ""

# Validate thoughts repository
if [ ! -d "$THOUGHTS_REPO" ]; then
  error "Thoughts repository not found: $THOUGHTS_REPO"
fi

if [ ! -d "$THOUGHTS_REPO/.git" ]; then
  error "Not a git repository: $THOUGHTS_REPO"
fi

# Check for GitHub remote
cd "$THOUGHTS_REPO"
REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")
if [ -z "$REMOTE_URL" ]; then
  warning "No git remote configured. You'll need to add a GitHub remote to use GitHub Actions."
fi

if [[ "$REMOTE_URL" != *"github.com"* ]]; then
  warning "Remote is not GitHub: $REMOTE_URL"
  warning "GitHub Actions require a GitHub repository."
fi

# Create .github/workflows directory
WORKFLOWS_DIR="$THOUGHTS_REPO/.github/workflows"
mkdir -p "$WORKFLOWS_DIR"
success "Created workflows directory: $WORKFLOWS_DIR"

# Generate context-daily.yml workflow
info "Generating context-daily.yml workflow..."

if [ ! -f "$SCRIPT_DIR/context-daily.yml.template" ]; then
  error "Template not found: $SCRIPT_DIR/context-daily.yml.template"
fi

# Read template and substitute variables
sed -e "s/{{PROJECT_KEY}}/$PROJECT_KEY/g" \
    -e "s/{{CODE_REPOS}}/$CODE_REPOS/g" \
    "$SCRIPT_DIR/context-daily.yml.template" \
    > "$WORKFLOWS_DIR/context-daily.yml"

success "Generated: $WORKFLOWS_DIR/context-daily.yml"

# Verify the file was created
if [ ! -f "$WORKFLOWS_DIR/context-daily.yml" ]; then
  error "Failed to create workflow file"
fi

# Show file size
FILE_SIZE=$(wc -c < "$WORKFLOWS_DIR/context-daily.yml" | xargs)
info "Workflow file size: $FILE_SIZE bytes"

# Check if already committed
cd "$THOUGHTS_REPO"
if git ls-files --error-unmatch .github/workflows/context-daily.yml >/dev/null 2>&1; then
  info "Workflow already tracked by git (updating existing)"
else
  info "New workflow file (not yet committed)"
fi

echo ""
success "✨ GitHub Actions setup complete!"
echo ""
echo "Next steps:"
echo ""
echo "1. Review the generated workflow:"
echo "   ${WORKFLOWS_DIR}/context-daily.yml"
echo ""
echo "2. Commit and push to GitHub:"
echo "   cd $THOUGHTS_REPO"
echo "   git add .github/workflows/context-daily.yml"
echo "   git commit -m 'ci: add context engineering daily dashboard workflow'"
echo "   git push"
echo ""
echo "3. Enable GitHub Actions in your repository:"
echo "   - Go to: https://github.com/YOUR-ORG/YOUR-REPO/actions"
echo "   - Click 'I understand my workflows, go ahead and enable them'"
echo ""
echo "4. Configure secrets (if needed):"
echo "   - The workflow uses GITHUB_TOKEN (automatically provided)"
echo "   - If analyzing private repos, add a PAT with 'repo' scope"
echo ""
echo "5. Test the workflow:"
echo "   - Go to Actions tab → 'Context Engineering Daily Dashboard'"
echo "   - Click 'Run workflow' → 'Run workflow'"
echo ""
echo "6. Schedule:"
echo "   - Runs daily at 9:15 AM Central Time"
echo "   - Edit cron schedule in workflow file if needed"
echo ""
echo "Report location:"
echo "  📊 context-engineering-daily.md (root of thoughts repo)"
echo ""

# Check if thoughts repo is on GitHub
if [[ "$REMOTE_URL" == *"github.com"* ]]; then
  # Extract org/repo from URL
  REPO_PATH=$(echo "$REMOTE_URL" | sed -E 's#.*github\.com[:/]([^/]+/[^/]+)(\.git)?#\1#')
  echo "Your thoughts repository: https://github.com/$REPO_PATH"
  echo "Actions: https://github.com/$REPO_PATH/actions"
  echo ""
fi

info "For more information, see: plugins/pm/templates/README.md"
