#!/bin/bash
# setup-catalyst.sh - Complete Catalyst setup in one command
# Usage: curl -fsSL https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh | bash
#        OR ./setup-catalyst.sh

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Global variables
PROJECT_DIR=""
PROJECT_KEY=""
ORG_NAME=""
REPO_NAME=""
ORG_ROOT=""
THOUGHTS_REPO=""
WORKTREE_BASE=""
USER_NAME=""

#
# Utility functions
#

print_header() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-y}"

  if [[ "$default" == "y" ]]; then
    read -p "$prompt [Y/n] " -n 1 -r
  else
    read -p "$prompt [y/N] " -n 1 -r
  fi
  echo

  if [[ -z "$REPLY" ]]; then
    [[ "$default" == "y" ]]
  else
    [[ $REPLY =~ ^[Yy]$ ]]
  fi
}

#
# Token discovery and validation functions
#

# Discover existing Linear API token from standard locations
discover_linear_token() {
  local token=""

  # Check environment variable
  if [[ -n "${LINEAR_API_TOKEN:-}" ]]; then
    echo "env" >&2
    echo "$LINEAR_API_TOKEN"
    return 0
  fi

  # Check ~/.linear_api_token file
  if [[ -f ~/.linear_api_token ]]; then
    token=$(cat ~/.linear_api_token | tr -d '[:space:]')
    if [[ -n "$token" ]]; then
      echo "file" >&2
      echo "$token"
      return 0
    fi
  fi

  return 1
}

# Validate Linear API token and extract org/teams info
validate_linear_token() {
  local token="$1"

  # GraphQL query to get viewer and teams
  local query='
  {
    viewer {
      id
      name
      email
      organization {
        id
        name
        urlKey
      }
    }
    teams {
      nodes {
        id
        name
        key
      }
    }
  }'

  local response
  response=$(curl -s -X POST \
    -H "Authorization: $token" \
    -H "Content-Type: application/json" \
    -d "{\"query\":$(echo "$query" | jq -Rs .)}" \
    https://api.linear.app/graphql 2>&1)

  # Check for errors
  if echo "$response" | jq -e '.errors' >/dev/null 2>&1; then
    echo '{"valid": false, "error": "Invalid token or API error"}' >&2
    return 1
  fi

  # Extract data
  local viewer=$(echo "$response" | jq -r '.data.viewer')
  local teams=$(echo "$response" | jq -r '.data.teams.nodes')

  if [[ "$viewer" == "null" ]]; then
    echo '{"valid": false, "error": "No user data returned"}' >&2
    return 1
  fi

  # Return validation result
  echo "$response" | jq '{
    valid: true,
    viewer: .data.viewer,
    teams: .data.teams.nodes
  }'
}

# Fetch workflow states for a Linear team
# Args: $1 = API token, $2 = team key
# Returns JSON array of workflow states with name, type, position
fetch_linear_workflow_states() {
  local token="$1"
  local team_key="$2"

  local query='
  {
    teams(filter: { key: { eq: "'"$team_key"'" } }) {
      nodes {
        workflowStates {
          nodes {
            name
            type
            position
          }
        }
      }
    }
  }'

  local response
  response=$(curl -s -X POST \
    -H "Authorization: $token" \
    -H "Content-Type: application/json" \
    -d "{\"query\":$(echo "$query" | jq -Rs .)}" \
    https://api.linear.app/graphql 2>&1)

  # Check for errors
  if echo "$response" | jq -e '.errors' >/dev/null 2>&1; then
    return 1
  fi

  # Extract workflow states
  local states
  states=$(echo "$response" | jq -r '.data.teams.nodes[0].workflowStates.nodes // empty')

  if [[ -z "$states" || "$states" == "null" ]]; then
    return 1
  fi

  echo "$states"
}

# Map Linear workflow states to Catalyst stateMap
# Args: $1 = JSON array of workflow states from fetch_linear_workflow_states
# Returns JSON object matching our stateMap schema
build_state_map_from_linear() {
  local states="$1"

  # Extract state names by type, sorted by position
  # Linear types: triage, backlog, unstarted, started, completed, canceled
  local backlog_state unstarted_state started_states review_state completed_state canceled_state

  backlog_state=$(echo "$states" | jq -r '[.[] | select(.type == "backlog")] | sort_by(.position) | .[0].name // empty')
  unstarted_state=$(echo "$states" | jq -r '[.[] | select(.type == "unstarted")] | sort_by(.position) | .[0].name // empty')
  completed_state=$(echo "$states" | jq -r '[.[] | select(.type == "completed")] | sort_by(.position) | .[0].name // empty')
  canceled_state=$(echo "$states" | jq -r '[.[] | select(.type == "cancelled" or .type == "canceled")] | sort_by(.position) | .[0].name // empty')

  # For "started" type, there may be multiple states (e.g., "In Progress", "In Review")
  # Try to find one with "review" in the name for our inReview key
  local default_started
  default_started=$(echo "$states" | jq -r '[.[] | select(.type == "started")] | sort_by(.position) | .[0].name // empty')
  review_state=$(echo "$states" | jq -r '[.[] | select(.type == "started") | select(.name | test("review"; "i"))] | .[0].name // empty')

  # If no explicit review state found, use the last started state (highest position)
  if [[ -z "$review_state" ]]; then
    local last_started
    last_started=$(echo "$states" | jq -r '[.[] | select(.type == "started")] | sort_by(.position) | last.name // empty')
    # Only use last_started as review if there are multiple started states
    local started_count
    started_count=$(echo "$states" | jq '[.[] | select(.type == "started")] | length')
    if [[ "$started_count" -gt 1 ]]; then
      review_state="$last_started"
    else
      review_state="$default_started"
    fi
  fi

  # If no triage state but we need a backlog fallback
  if [[ -z "$backlog_state" ]]; then
    # Check for triage state as fallback
    backlog_state=$(echo "$states" | jq -r '[.[] | select(.type == "triage")] | sort_by(.position) | .[0].name // empty')
  fi

  # Build the stateMap JSON
  jq -n \
    --arg backlog "${backlog_state:-Backlog}" \
    --arg todo "${unstarted_state:-Todo}" \
    --arg research "${default_started:-In Progress}" \
    --arg planning "${default_started:-In Progress}" \
    --arg inProgress "${default_started:-In Progress}" \
    --arg inReview "${review_state:-In Review}" \
    --arg done "${completed_state:-Done}" \
    --arg canceled "${canceled_state:-Canceled}" \
    '{
      backlog: $backlog,
      todo: $todo,
      research: $research,
      planning: $planning,
      inProgress: $inProgress,
      inReview: $inReview,
      done: $done,
      canceled: $canceled
    }'
}

# Update .catalyst/config.json with real Linear workflow states
# Called after Linear integration is configured in secrets
update_config_with_linear_states() {
  local config_file="${PROJECT_DIR}/.catalyst/config.json"
  local secrets_file="$HOME/.config/catalyst/config-${PROJECT_KEY}.json"

  # Need both files to exist
  if [[ ! -f "$config_file" ]] || [[ ! -f "$secrets_file" ]]; then
    return 0
  fi

  # Get token and team key from secrets
  local token team_key
  token=$(jq -r '.catalyst.linear.apiToken // empty' "$secrets_file" 2>/dev/null)
  team_key=$(jq -r '.catalyst.linear.teamKey // empty' "$secrets_file" 2>/dev/null)

  # Fall back to project config for team key
  if [[ -z "$team_key" ]]; then
    team_key=$(jq -r '.catalyst.linear.teamKey // empty' "$config_file" 2>/dev/null)
  fi

  if [[ -z "$token" ]] || [[ -z "$team_key" ]]; then
    return 0
  fi

  echo ""
  echo "🔍 Fetching workflow states from Linear for team ${team_key}..."

  local states
  if states=$(fetch_linear_workflow_states "$token" "$team_key"); then
    local state_map
    state_map=$(build_state_map_from_linear "$states")

    if [[ -n "$state_map" ]]; then
      # Update the project config with real states
      local updated_config
      updated_config=$(jq --argjson stateMap "$state_map" '.catalyst.linear.stateMap = $stateMap' "$config_file")
      echo "$updated_config" | jq . > "$config_file"

      echo ""
      echo "✓ Updated .catalyst/config.json with actual Linear workflow states:"
      echo "$state_map" | jq -r 'to_entries[] | "  \(.key): \(.value)"'
      echo ""
    else
      print_warning "Could not build state map from Linear API response. Using defaults."
    fi
  else
    print_warning "Could not fetch workflow states from Linear API. Using defaults."
    echo "  You can customize later in .catalyst/config.json → catalyst.linear.stateMap"
  fi
}

# Discover existing Sentry auth token
discover_sentry_token() {
  local token=""

  # Check environment variable
  if [[ -n "${SENTRY_AUTH_TOKEN:-}" ]]; then
    echo "env" >&2
    echo "$SENTRY_AUTH_TOKEN"
    return 0
  fi

  # Check ~/.sentryclirc file
  if [[ -f ~/.sentryclirc ]]; then
    token=$(grep -E '^token\s*=' ~/.sentryclirc 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]' || echo "")
    if [[ -n "$token" ]]; then
      echo "file" >&2
      echo "$token"
      return 0
    fi
  fi

  return 1
}

# Validate Sentry auth token and get org/projects
validate_sentry_token() {
  local token="$1"

  # Get organizations
  local orgs_response
  orgs_response=$(curl -s -X GET \
    -H "Authorization: Bearer $token" \
    https://sentry.io/api/0/organizations/ 2>&1)

  # Check if valid JSON and has data
  if ! echo "$orgs_response" | jq -e '.' >/dev/null 2>&1; then
    echo '{"valid": false, "error": "Invalid response from API"}' >&2
    return 1
  fi

  if echo "$orgs_response" | jq -e '.detail' >/dev/null 2>&1; then
    local error=$(echo "$orgs_response" | jq -r '.detail')
    echo "{\"valid\": false, \"error\": \"$error\"}" >&2
    return 1
  fi

  # Get first org slug
  local org_slug=$(echo "$orgs_response" | jq -r '.[0].slug // empty')

  if [[ -z "$org_slug" ]]; then
    echo '{"valid": false, "error": "No organizations found"}' >&2
    return 1
  fi

  # Get projects for first org
  local projects_response
  projects_response=$(curl -s -X GET \
    -H "Authorization: Bearer $token" \
    "https://sentry.io/api/0/organizations/$org_slug/projects/" 2>&1)

  # Return validation result
  jq -n \
    --argjson orgs "$orgs_response" \
    --argjson projects "$projects_response" \
    '{
      valid: true,
      organizations: $orgs,
      projects: $projects
    }'
}


#
# Prerequisite functions
#

check_command_exists() {
  command -v "$1" &>/dev/null
}

check_prerequisites() {
  print_header "Checking Prerequisites"

  local missing_critical=false
  local missing_optional=false

  # Critical: git (used throughout for repo detection, worktrees, thoughts)
  if ! check_command_exists "git"; then
    print_error "git not found (required)"
    echo "  Install git: https://git-scm.com/downloads"
    missing_critical=true
  else
    print_success "git installed"
  fi

  # Critical: jq (for config manipulation)
  if ! check_command_exists "jq"; then
    print_warning "jq not found (required for config management)"
    offer_install_jq || missing_critical=true
  else
    print_success "jq installed"
  fi

  # Critical: humanlayer (for thoughts system)
  if ! check_command_exists "humanlayer"; then
    print_warning "HumanLayer CLI not found (required for thoughts system)"
    offer_install_humanlayer || missing_critical=true
  else
    print_success "HumanLayer CLI installed"
  fi

  # Optional: gh (for Linear, GitHub backup)
  if ! check_command_exists "gh"; then
    print_warning "GitHub CLI not found (optional, for Linear integration)"
    offer_install_gh_cli || missing_optional=true
  else
    print_success "GitHub CLI installed"
  fi

  # Optional: linearis (for Linear integration)
  if ! check_command_exists "linearis"; then
    print_warning "Linearis CLI not found (optional, for Linear integration)"
    echo "  Install: npm install -g linearis"
    missing_optional=true
  else
    # Check version is at least 1.1.0
    local linearis_version
    linearis_version=$(linearis --version 2>/dev/null | tail -1 | tr -d '[:space:]')

    if [[ "$linearis_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      local major minor patch
      IFS='.' read -r major minor patch <<< "$linearis_version"

      if [ "$major" -lt 1 ] || ([ "$major" -eq 1 ] && [ "$minor" -lt 1 ]); then
        print_warning "Linearis CLI version $linearis_version is too old (need >= 1.1.0)"
        echo "  Update: npm install -g linearis"
        missing_optional=true
      else
        print_success "Linearis CLI installed (v${linearis_version})"
      fi
    else
      print_success "Linearis CLI installed"
    fi
  fi

  # Check agent-browser (optional - browser automation)
  if command -v agent-browser &>/dev/null; then
    print_success "agent-browser installed"
  else
    print_warning "agent-browser not found (optional - browser automation)"
    echo "  Install: npm install -g agent-browser && agent-browser install"
    missing_optional=true
  fi

  if [ "$missing_critical" = true ]; then
    print_error "Critical prerequisites missing. Cannot continue."
    exit 1
  fi

  if [ "$missing_optional" = true ]; then
    echo ""
    print_warning "Some optional tools are missing. You can:"
    echo "  - Continue setup (you can add integrations later)"
    echo "  - Exit and install tools manually"
    echo ""
    if ! ask_yes_no "Continue without optional tools?"; then
      echo "Setup cancelled. Install missing tools and re-run this script."
      exit 0
    fi
  fi

  echo ""
}

offer_install_humanlayer() {
  echo ""
  echo "HumanLayer CLI is required for the thoughts system."
  echo ""
  echo "Installation options:"
  echo "  1. pip install humanlayer"
  echo "  2. pipx install humanlayer"
  echo ""

  if ask_yes_no "Attempt to install via pip now?"; then
    if command -v pip &>/dev/null; then
      pip install humanlayer
      return 0
    elif command -v pip3 &>/dev/null; then
      pip3 install humanlayer
      return 0
    else
      print_error "pip not found. Please install Python and pip first."
      return 1
    fi
  else
    print_warning "Skipping HumanLayer installation. Setup cannot continue."
    return 1
  fi
}

offer_install_gh_cli() {
  echo ""
  echo "GitHub CLI is useful for:"
  echo "  - Linear integration (via gh api)"
  echo "  - Backing up thoughts repo to GitHub"
  echo ""
  echo "Installation: https://cli.github.com/"
  echo ""

  if ask_yes_no "Open installation page in browser?"; then
    if command -v open &>/dev/null; then
      open "https://cli.github.com/"
    elif command -v xdg-open &>/dev/null; then
      xdg-open "https://cli.github.com/"
    fi
  fi

  return 1  # User will install manually
}

offer_install_jq() {
  echo ""
  echo "jq is required for config file manipulation."
  echo ""

  if ask_yes_no "Attempt to install jq now?"; then
    if command -v brew &>/dev/null; then
      brew install jq
      return 0
    elif command -v apt-get &>/dev/null; then
      sudo apt-get install -y jq
      return 0
    else
      print_error "Could not auto-install. Install manually: https://jqlang.github.io/jq/"
      return 1
    fi
  fi

  return 1
}

#
# Detection functions
#

detect_git_repo() {
  print_header "Detecting Git Repository"

  if git rev-parse --git-dir >/dev/null 2>&1; then
    PROJECT_DIR=$(git rev-parse --show-toplevel)
    print_success "Found git repository: $PROJECT_DIR"

    # Extract org and repo from remote
    detect_org_and_repo

    echo ""
    echo "Detected repository: ${ORG_NAME}/${REPO_NAME}"
    echo ""

    if ask_yes_no "Set up Catalyst in this repository?"; then
      return 0
    else
      determine_project_location
    fi
  else
    print_warning "Not currently in a git repository"
    determine_project_location
  fi
}

detect_org_and_repo() {
  local git_remote
  git_remote=$(git config --get remote.origin.url 2>/dev/null || echo "")

  if [[ $git_remote =~ github\.com[:/]([^/]+)/([^/.]+) ]]; then
    ORG_NAME="${BASH_REMATCH[1]}"
    REPO_NAME="${BASH_REMATCH[2]}"
  else
    # No GitHub remote, try to parse directory structure
    # Assume structure: */github/<org>/<repo>
    local abs_path
    abs_path=$(cd "$PROJECT_DIR" && pwd)

    if [[ $abs_path =~ /github/([^/]+)/([^/]+)/?$ ]]; then
      ORG_NAME="${BASH_REMATCH[1]}"
      REPO_NAME="${BASH_REMATCH[2]}"
    else
      # Fallback: ask user
      echo ""
      print_warning "Could not detect GitHub org/repo from remote or path"
      read -p "Enter GitHub organization name: " ORG_NAME
      read -p "Enter repository name: " REPO_NAME
    fi
  fi

  # Determine org root (parent of repo directory)
  ORG_ROOT="$(dirname "$PROJECT_DIR")"

  # Set projectKey to org name
  PROJECT_KEY="$ORG_NAME"
}

determine_project_location() {
  echo ""
  echo "Where is your project located?"
  echo ""
  echo "Options:"
  echo "  1. I already have the repo checked out"
  echo "  2. Clone a fresh copy to a new location"
  echo ""

  read -p "Select option (1 or 2): " location_option

  case $location_option in
    1)
      read -p "Enter path to existing repository: " PROJECT_DIR
      PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd)  # Resolve to absolute path

      if [ ! -d "$PROJECT_DIR/.git" ]; then
        print_error "Not a git repository: $PROJECT_DIR"
        exit 1
      fi

      cd "$PROJECT_DIR"
      detect_org_and_repo
      ;;
    2)
      read -p "Enter GitHub repo (org/repo): " github_repo

      if [[ ! $github_repo =~ ^([^/]+)/([^/]+)$ ]]; then
        print_error "Invalid format. Expected: org/repo"
        exit 1
      fi

      ORG_NAME="${BASH_REMATCH[1]}"
      REPO_NAME="${BASH_REMATCH[2]}"
      PROJECT_KEY="$ORG_NAME"

      # Determine clone location
      if [ -n "$GITHUB_SOURCE_ROOT" ]; then
        ORG_ROOT="${GITHUB_SOURCE_ROOT}/${ORG_NAME}"
        PROJECT_DIR="${ORG_ROOT}/${REPO_NAME}"
      else
        read -p "Enter directory to clone into [~/code-repos/github/${ORG_NAME}]: " clone_base
        clone_base="${clone_base:-$HOME/code-repos/github/${ORG_NAME}}"
        ORG_ROOT="$clone_base"
        PROJECT_DIR="${ORG_ROOT}/${REPO_NAME}"
      fi

      mkdir -p "$ORG_ROOT"

      echo ""
      print_header "Cloning Repository"
      git clone "git@github.com:${github_repo}.git" "$PROJECT_DIR"
      cd "$PROJECT_DIR"
      ;;
    *)
      print_error "Invalid option"
      exit 1
      ;;
  esac
}

#
# Setup functions
#

discover_existing_thoughts_repo() {
  # Priority 1: Check if thoughts/shared is already a symlink in PROJECT_DIR
  # This handles the case where humanlayer thoughts init was already run
  if [ -L "${PROJECT_DIR}/thoughts/shared" ]; then
    local shared_target
    shared_target=$(readlink "${PROJECT_DIR}/thoughts/shared" 2>/dev/null || echo "")
    if [ -n "$shared_target" ]; then
      # Derive the thoughts repo root from the symlink target
      # e.g., /path/to/thoughts/repos/evergreen/shared → /path/to/thoughts
      local thoughts_root
      thoughts_root=$(echo "$shared_target" | sed 's|/repos/[^/]*/shared$||')
      if [ -d "$thoughts_root" ] && [ -d "$thoughts_root/repos" ]; then
        THOUGHTS_REPO="$thoughts_root"
        return 0
      fi
    fi
  fi

  # Priority 2: Check HumanLayer profile config in humanlayer.json
  local hl_config="$HOME/.config/humanlayer/humanlayer.json"
  if [ -f "$hl_config" ] && command -v jq &>/dev/null; then
    # Try by ORG_NAME (most common - profile name matches org)
    local thoughts_path
    thoughts_path=$(jq -r ".thoughts.profiles.\"${ORG_NAME}\".thoughtsRepo // empty" "$hl_config" 2>/dev/null)
    if [ -n "$thoughts_path" ] && [ -d "$thoughts_path" ] && [ -d "$thoughts_path/repos" ]; then
      THOUGHTS_REPO="$thoughts_path"
      return 0
    fi

    # Try by PROJECT_KEY if different from ORG_NAME
    if [ "$PROJECT_KEY" != "$ORG_NAME" ]; then
      thoughts_path=$(jq -r ".thoughts.profiles.\"${PROJECT_KEY}\".thoughtsRepo // empty" "$hl_config" 2>/dev/null)
      if [ -n "$thoughts_path" ] && [ -d "$thoughts_path" ] && [ -d "$thoughts_path/repos" ]; then
        THOUGHTS_REPO="$thoughts_path"
        return 0
      fi
    fi
  fi

  # Priority 3: Check standard location based on ORG_ROOT
  if [ -d "${ORG_ROOT}/thoughts" ] && [ -d "${ORG_ROOT}/thoughts/repos" ]; then
    THOUGHTS_REPO="${ORG_ROOT}/thoughts"
    return 0
  fi

  # Not found
  return 1
}

setup_thoughts_repo() {
  print_header "Setting Up Thoughts Repository"

  # Try to discover an existing thoughts repo before creating one
  if discover_existing_thoughts_repo; then
    print_success "Found existing thoughts repository: $THOUGHTS_REPO"

    # Validate structure
    if [ ! -d "$THOUGHTS_REPO/repos" ] || [ ! -d "$THOUGHTS_REPO/global" ]; then
      print_warning "Thoughts repo exists but missing expected structure"
      echo "Expected: repos/ and global/ directories"

      if ask_yes_no "Initialize proper structure?"; then
        mkdir -p "$THOUGHTS_REPO/repos"
        mkdir -p "$THOUGHTS_REPO/global"
      fi
    fi

    # Check if it's a git repo
    if [ ! -d "$THOUGHTS_REPO/.git" ]; then
      print_warning "Thoughts repo is not a git repository"

      if ask_yes_no "Initialize as git repo?"; then
        cd "$THOUGHTS_REPO"
        git init
        git add .
        git commit -m "Initial commit" || true
        cd "$PROJECT_DIR"
      fi
    fi

    # Offer GitHub backup
    if [ -d "$THOUGHTS_REPO/.git" ]; then
      offer_github_backup
    fi

    echo ""
    return 0
  fi

  # No existing thoughts repo found - create one at the standard location
  THOUGHTS_REPO="${ORG_ROOT}/thoughts"

  echo "Thoughts repository will be created at: $THOUGHTS_REPO"
  echo ""
  echo "This will be shared by all projects in org: $ORG_NAME"
  echo ""

  if ask_yes_no "Create thoughts repository?"; then
    mkdir -p "$THOUGHTS_REPO/repos"
    mkdir -p "$THOUGHTS_REPO/global"

    # Initialize as git repo
    cd "$THOUGHTS_REPO"
    git init

    # Create README
    cat > README.md <<'EOF'
# Thoughts Repository

This is a shared thoughts repository for all projects in this organization.

## Structure

```
thoughts/
├── repos/           # Per-project thoughts
│   ├── project-a/
│   │   ├── {user}/
│   │   └── shared/
│   └── project-b/
│       ├── {user}/
│       └── shared/
└── global/          # Cross-project thoughts
    ├── {user}/
    └── shared/
```

## Usage

Projects symlink into this repo via `humanlayer thoughts init`.

See: https://github.com/humanlayer/humanlayer/blob/main/hlyr/THOUGHTS.md
EOF

    git add README.md
    git commit -m "Initial thoughts repository"

    print_success "Created thoughts repository: $THOUGHTS_REPO"
    cd "$PROJECT_DIR"
  else
    print_error "Thoughts repository required for Catalyst. Exiting."
    exit 1
  fi

  # Offer GitHub backup
  if [ -d "$THOUGHTS_REPO/.git" ]; then
    offer_github_backup
  fi

  echo ""
}

setup_worktree_directory() {
  print_header "Setting Up Worktree Directory"

  # Check if we're already inside a worktree (e.g., Conductor-managed)
  local git_dir
  git_dir=$(git rev-parse --git-dir 2>/dev/null || echo "")

  if [ -f "$git_dir" ] 2>/dev/null || [[ "$git_dir" == *"/worktrees/"* ]]; then
    print_success "Already running inside a git worktree"
    echo "Worktree management is handled by your tooling (e.g., Conductor, /create-worktree)."
    echo ""
    echo "To create additional worktrees, use:"
    echo "  /create-worktree PROJ-123 feature-name"
    echo ""
    WORKTREE_BASE=""
    return 0
  fi

  # Standard layout: worktrees as sibling of the repo under ORG_ROOT
  WORKTREE_BASE="${ORG_ROOT}/${REPO_NAME}-worktrees"

  echo "Worktrees will be created at: $WORKTREE_BASE"
  echo ""

  if [ -d "$WORKTREE_BASE" ]; then
    print_success "Worktree directory already exists"

    # List existing worktrees
    local count
    count=$(find "$WORKTREE_BASE" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)

    if [ "$count" -gt 0 ]; then
      echo "Existing worktrees:"
      ls -1 "$WORKTREE_BASE" | sed 's/^/  - /'
    fi
  else
    if ask_yes_no "Create worktree directory?"; then
      mkdir -p "$WORKTREE_BASE"
      print_success "Created worktree directory: $WORKTREE_BASE"
    else
      print_warning "Skipped worktree setup. You can create it later."
    fi
  fi

  echo ""
  echo "To create worktrees, use:"
  echo "  /create-worktree PROJ-123 feature-name"
  echo ""
}

setup_project_config() {
  print_header "Setting Up Project Configuration"

  local config_file="${PROJECT_DIR}/.catalyst/config.json"

  # Create .claude directory if needed
  mkdir -p "${PROJECT_DIR}/.claude"

  # Check if config already exists
  if [ -f "$config_file" ]; then
    print_warning "Found existing .catalyst/config.json"

    # Check if projectKey matches
    local existing_key
    existing_key=$(jq -r '.catalyst.projectKey // empty' "$config_file")

    if [ -n "$existing_key" ] && [ "$existing_key" != "$PROJECT_KEY" ]; then
      echo ""
      echo "Existing projectKey: $existing_key"
      echo "Detected projectKey: $PROJECT_KEY"
      echo ""

      if ask_yes_no "Update to new projectKey ($PROJECT_KEY)?"; then
        PROJECT_KEY="$PROJECT_KEY"
      else
        PROJECT_KEY="$existing_key"
        print_warning "Keeping existing projectKey: $existing_key"
      fi
    elif [ -n "$existing_key" ]; then
      print_success "Config already has correct projectKey: $existing_key"
      return 0
    fi
  fi

  # Prompt for ticket prefix
  echo ""
  echo "Ticket Prefix Configuration:"
  echo "  This is used for Linear tickets and appears in:"
  echo "  - Branch names (e.g., ${PROJECT_KEY}-123-feature-name)"
  echo "  - PR titles (e.g., [${PROJECT_KEY}-123] Add new feature)"
  echo "  - Commit messages and documentation"
  echo ""
  read -p "Enter ticket prefix (e.g., ENG, PROJ) [PROJ]: " ticket_prefix
  ticket_prefix="${ticket_prefix:-PROJ}"

  # Prompt for project name
  echo ""
  echo "Project Name Configuration:"
  echo "  This is a human-friendly display name (not the repo name)."
  echo "  Used in documentation, reports, and thought documents."
  echo "  Example: 'Acme API' instead of 'acme-api-backend'"
  echo ""
  read -p "Enter project name [${REPO_NAME}]: " project_name
  project_name="${project_name:-${REPO_NAME}}"

  # Create/update config
  cat > "$config_file" <<EOF
{
  "catalyst": {
    "projectKey": "${PROJECT_KEY}",
    "repository": {
      "org": "${ORG_NAME}",
      "name": "${REPO_NAME}"
    },
    "project": {
      "ticketPrefix": "${ticket_prefix}",
      "name": "${project_name}"
    },
    "linear": {
      "teamKey": "${ticket_prefix}",
      "stateMap": {
        "backlog": "Backlog",
        "todo": "Todo",
        "research": "In Progress",
        "planning": "In Progress",
        "inProgress": "In Progress",
        "inReview": "In Review",
        "done": "Done",
        "canceled": "Canceled"
      }
    },
    "thoughts": {
      "user": null
    }
  }
}
EOF

  print_success "Created .catalyst/config.json"
  echo ""
  echo "✓ projectKey: ${PROJECT_KEY}"
  echo "✓ org/repo: ${ORG_NAME}/${REPO_NAME}"
  echo "✓ ticketPrefix: ${ticket_prefix}"
  echo "✓ linear.teamKey: ${ticket_prefix}"
  echo "✓ linear.stateMap: defaults (will be updated with actual Linear states after API setup)"
  echo ""
}

setup_humanlayer_config() {
  print_header "Setting Up HumanLayer Configuration"

  local config_dir="$HOME/.config/humanlayer"
  local config_file="${config_dir}/config-${PROJECT_KEY}.json"

  mkdir -p "$config_dir"

  # Check if config already exists
  if [ -f "$config_file" ]; then
    print_warning "Found existing HumanLayer config: $config_file"

    # Validate it points to correct thoughts repo
    local existing_repo
    existing_repo=$(jq -r '.thoughts.thoughtsRepo // empty' "$config_file")

    if [ -n "$existing_repo" ] && [ "$existing_repo" = "$THOUGHTS_REPO" ]; then
      print_success "Config already points to correct thoughts repo"
      return 0
    elif [ -n "$existing_repo" ]; then
      print_warning "Config points to different thoughts repo: $existing_repo"

      if ! ask_yes_no "Update to use $THOUGHTS_REPO?"; then
        THOUGHTS_REPO="$existing_repo"
        print_warning "Using existing thoughts repo: $existing_repo"
        return 0
      fi
    fi
  fi

  # Prompt for username
  echo ""
  echo "Thoughts Username Configuration:"
  echo "  This creates a personal directory for your notes and research."
  echo "  Structure: thoughts/{your_name}/ (e.g., thoughts/ryan/)"
  echo "  Used to separate your work from shared team documents."
  echo ""
  echo "  Detected system user: ${USER}"
  echo "  You can use your system username or choose something else (like your first name)."
  echo ""
  read -p "Enter your name for thoughts [${USER}]: " thoughts_user
  thoughts_user="${thoughts_user:-${USER}}"
  USER_NAME="$thoughts_user"

  # Create config
  cat > "$config_file" <<EOF
{
  "thoughts": {
    "thoughtsRepo": "${THOUGHTS_REPO}",
    "user": "${thoughts_user}",
    "reposDir": "repos",
    "globalDir": "global"
  }
}
EOF

  print_success "Created HumanLayer config: $config_file"
  echo ""
  echo "✓ Thoughts repo: ${THOUGHTS_REPO}"
  echo "✓ User: ${thoughts_user}"
  echo ""
}

setup_catalyst_secrets() {
  print_header "Setting Up Catalyst Secrets"

  local config_dir="$HOME/.config/catalyst"
  local config_file="${config_dir}/config-${PROJECT_KEY}.json"

  mkdir -p "$config_dir"

  echo "This config file stores API tokens and secrets."
  echo "Location: $config_file"
  echo ""
  echo "You can configure integrations now or skip and add them later."
  echo ""

  # Check if config exists
  if [ -f "$config_file" ]; then
    print_warning "Found existing secrets config"

    if ! ask_yes_no "Update/add integrations?"; then
      print_success "Keeping existing secrets config"
      return 0
    fi

    # Load existing config
    local existing_config
    existing_config=$(cat "$config_file")
  else
    # Create empty config
    existing_config='{"catalyst":{}}'
  fi

  # Prompt for each integration
  prompt_linear_config "$existing_config" > /tmp/catalyst-config-temp.json
  existing_config=$(cat /tmp/catalyst-config-temp.json)

  prompt_sentry_config "$existing_config" > /tmp/catalyst-config-temp.json
  existing_config=$(cat /tmp/catalyst-config-temp.json)

  prompt_posthog_config "$existing_config" > /tmp/catalyst-config-temp.json
  existing_config=$(cat /tmp/catalyst-config-temp.json)

  prompt_exa_config "$existing_config" > /tmp/catalyst-config-temp.json
  existing_config=$(cat /tmp/catalyst-config-temp.json)

  # Save final config
  echo "$existing_config" | jq . > "$config_file"
  rm /tmp/catalyst-config-temp.json

  print_success "Secrets config saved: $config_file"
  echo ""
}

prompt_linear_config() {
  local config="$1"

  echo "" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "Linear Configuration (Project Management)" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "" >&2

  # Check if already configured
  local has_token
  has_token=$(echo "$config" | jq -r '.catalyst.linear.apiToken // empty')

  if [ -n "$has_token" ] && [ "$has_token" != "[NEEDS_SETUP]" ]; then
    echo "✓ Linear already configured" >&2
    if ! ask_yes_no "Update Linear config?"; then
      echo "$config"
      return 0
    fi
  fi

  if ! ask_yes_no "Configure Linear integration?"; then
    echo "Skipping Linear. You can add it later by re-running this script." >&2
    echo "$config"
    return 0
  fi

  echo "" >&2

  local discovered_token=""
  local discovery_source=""
  local linear_token=""
  local linear_org=""
  local linear_teams=""
  local linear_team=""
  local linear_team_name=""

  # Try to discover existing token
  echo "🔍 Checking for existing Linear API token..." >&2

  if discovered_token=$(discover_linear_token 2>&1); then
    discovery_source=$(echo "$discovered_token" | head -1)
    discovered_token=$(echo "$discovered_token" | tail -1)

    echo "" >&2
    echo "✓ Found existing Linear API token in: $discovery_source" >&2

    # Validate the token
    echo "🔍 Validating token and fetching organization info..." >&2

    if validation_result=$(validate_linear_token "$discovered_token" 2>&1); then
      # Extract info
      linear_org=$(echo "$validation_result" | jq -r '.viewer.organization.name')
      local org_key=$(echo "$validation_result" | jq -r '.viewer.organization.urlKey')
      linear_teams=$(echo "$validation_result" | jq -r '.teams')

      echo "" >&2
      echo "✓ Token is valid!" >&2
      echo "  Organization: $linear_org ($org_key)" >&2
      echo "  Found $(echo "$linear_teams" | jq 'length') team(s):" >&2
      echo "$linear_teams" | jq -r '.[] | "    - \(.key): \(.name)"' >&2
      echo "" >&2

      if ask_yes_no "Use this token?"; then
        linear_token="$discovered_token"

        # Let user select team
        local team_count=$(echo "$linear_teams" | jq 'length')

        if [[ $team_count -eq 1 ]]; then
          # Only one team, use it
          linear_team=$(echo "$linear_teams" | jq -r '.[0].key')
          linear_team_name=$(echo "$linear_teams" | jq -r '.[0].name')
          echo "Using team: $linear_team ($linear_team_name)" >&2
        else
          # Multiple teams, let user choose
          echo "Select a team:" >&2
          echo "$linear_teams" | jq -r 'to_entries | .[] | "  \(.key + 1). \(.value.key): \(.value.name)"' >&2
          echo "" >&2

          read -p "Enter team number [1-$team_count]: " team_num
          team_num=$((team_num - 1))

          linear_team=$(echo "$linear_teams" | jq -r ".[$team_num].key")
          linear_team_name=$(echo "$linear_teams" | jq -r ".[$team_num].name")
        fi
      fi
    else
      echo "⚠ Token validation failed. You'll need to enter it manually." >&2
    fi
  fi

  # If no token discovered or user declined, ask for it
  if [[ -z "$linear_token" ]]; then
    echo "" >&2
    echo "Linear API Token Setup:" >&2
    echo "  📚 Documentation: https://linear.app/docs/api-and-webhooks#api-keys" >&2
    echo "" >&2
    echo "  Steps:" >&2
    echo "  1. Go to https://linear.app/settings/api" >&2
    echo "  2. Click 'Create key' under Personal API Keys" >&2
    echo "  3. Give it a name (e.g., 'Catalyst')" >&2
    echo "  4. Copy the token (starts with 'lin_api_')" >&2
    echo "" >&2
    echo "  TIP: Save to ~/.linear_api_token to auto-discover next time:" >&2
    echo "       echo 'YOUR_TOKEN' > ~/.linear_api_token" >&2
    echo "" >&2

    read -p "Linear API token: " linear_token

    # Validate the manually entered token
    if [[ -n "$linear_token" ]]; then
      echo "" >&2
      echo "🔍 Validating token..." >&2

      if validation_result=$(validate_linear_token "$linear_token" 2>&1); then
        linear_org=$(echo "$validation_result" | jq -r '.viewer.organization.name')
        linear_teams=$(echo "$validation_result" | jq -r '.teams')

        echo "✓ Token is valid!" >&2
        echo "  Organization: $linear_org" >&2
        echo "" >&2

        # Offer to save token
        if ask_yes_no "Save token to ~/.linear_api_token for future use?"; then
          echo "$linear_token" > ~/.linear_api_token
          chmod 600 ~/.linear_api_token
          echo "✓ Token saved to ~/.linear_api_token" >&2
        fi
      else
        echo "⚠ Warning: Token validation failed. Saving anyway..." >&2
      fi
    fi
  fi

  # Get team key (auto-detect from project config or use validated data)
  if [[ -z "$linear_team" ]]; then
    if [ -f "${PROJECT_DIR}/.catalyst/config.json" ]; then
      linear_team=$(jq -r '.catalyst.project.ticketPrefix // "PROJ"' "${PROJECT_DIR}/.catalyst/config.json")
      echo "" >&2
      echo "Team Key (Identifier): Using '${linear_team}' from project config" >&2
      echo "  (This matches your ticket prefix for consistency)" >&2
    else
      echo "" >&2
      echo "Team Key (Identifier):" >&2
      echo "  This is the short prefix used in your Linear issue IDs." >&2
      echo "  Example: If your issues are 'ENG-123', the key is 'ENG'" >&2
      echo "  📚 Find it: Linear → Settings → Teams → [Your Team] → Identifier field" >&2
      echo "" >&2
      read -p "Linear team key (identifier): " linear_team
    fi
  fi

  # Get team name if not already set
  if [[ -z "$linear_team_name" ]]; then
    echo "" >&2
    echo "Team Name:" >&2
    echo "  The full name of your Linear team (not the short identifier)" >&2
    echo "  📚 Find it: Linear → Settings → Teams → [Your Team] → Name field" >&2
    echo "" >&2
    read -p "Linear team name: " linear_team_name
  fi

  # Build config
  echo "$config" | jq \
    --arg token "$linear_token" \
    --arg team "$linear_team" \
    --arg teamName "$linear_team_name" \
    '.catalyst.linear = {
      "apiToken": $token,
      "teamKey": $team,
      "defaultTeam": $teamName
    }'
}

prompt_sentry_config() {
  local config="$1"

  echo "" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "Sentry Configuration (Error Monitoring)" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "" >&2

  # Check if already configured
  local has_token
  has_token=$(echo "$config" | jq -r '.catalyst.sentry.authToken // empty')

  if [ -n "$has_token" ] && [ "$has_token" != "[NEEDS_SETUP]" ]; then
    echo "✓ Sentry already configured" >&2
    if ! ask_yes_no "Update Sentry config?"; then
      echo "$config"
      return 0
    fi
  fi

  if ! ask_yes_no "Configure Sentry integration?"; then
    echo "Skipping Sentry. You can add it later by re-running this script." >&2
    echo "$config"
    return 0
  fi

  echo "" >&2

  local discovered_token=""
  local discovery_source=""
  local sentry_token=""
  local sentry_orgs=""
  local sentry_org=""
  local sentry_projects=""
  local sentry_project=""

  # Try to discover existing token
  echo "🔍 Checking for existing Sentry auth token..." >&2

  if discovered_token=$(discover_sentry_token 2>&1); then
    discovery_source=$(echo "$discovered_token" | head -1)
    discovered_token=$(echo "$discovered_token" | tail -1)

    echo "" >&2
    echo "✓ Found existing Sentry auth token in: $discovery_source" >&2

    # Validate the token
    echo "🔍 Validating token and fetching organization info..." >&2

    if validation_result=$(validate_sentry_token "$discovered_token" 2>&1); then
      # Extract info
      sentry_orgs=$(echo "$validation_result" | jq -r '.organizations')

      echo "" >&2
      echo "✓ Token is valid!" >&2
      echo "  Found $(echo "$sentry_orgs" | jq 'length') organization(s):" >&2
      echo "$sentry_orgs" | jq -r '.[] | "    - \(.slug): \(.name)"' >&2
      echo "" >&2

      if ask_yes_no "Use this token?"; then
        sentry_token="$discovered_token"

        # Let user select organization
        local org_count=$(echo "$sentry_orgs" | jq 'length')

        if [[ $org_count -eq 1 ]]; then
          # Only one org, use it
          sentry_org=$(echo "$sentry_orgs" | jq -r '.[0].slug')
          local org_name=$(echo "$sentry_orgs" | jq -r '.[0].name')
          echo "Using organization: $sentry_org ($org_name)" >&2

          # Get projects for this org
          sentry_projects=$(echo "$validation_result" | jq -r '.projects')
          echo "  Found $(echo "$sentry_projects" | jq 'length') project(s)" >&2
        else
          # Multiple orgs, let user choose
          echo "Select an organization:" >&2
          echo "$sentry_orgs" | jq -r 'to_entries | .[] | "  \(.key + 1). \(.value.slug): \(.value.name)"' >&2
          echo "" >&2

          read -p "Enter organization number [1-$org_count]: " org_num
          org_num=$((org_num - 1))

          sentry_org=$(echo "$sentry_orgs" | jq -r ".[$org_num].slug")
        fi

        # Let user select project(s)
        if [[ -n "$sentry_projects" ]]; then
          local project_count=$(echo "$sentry_projects" | jq 'length')

          if [[ $project_count -eq 1 ]]; then
            sentry_project=$(echo "$sentry_projects" | jq -r '.[0].slug')
            local project_name=$(echo "$sentry_projects" | jq -r '.[0].name')
            echo "Using project: $sentry_project ($project_name)" >&2
          elif [[ $project_count -gt 1 ]]; then
            echo "" >&2
            echo "Found $project_count projects:" >&2
            echo "$sentry_projects" | jq -r 'to_entries | .[] | "  \(.key + 1). \(.value.slug): \(.value.name)"' >&2
            echo "" >&2
            echo "Options:" >&2
            echo "  A. Monitor all projects (recommended for multi-project setups)" >&2
            echo "  S. Select specific projects to monitor" >&2
            echo "  1-$project_count. Choose one default project" >&2
            echo "" >&2

            read -p "Enter choice [A/S/1-$project_count]: " project_choice

            case "${project_choice^^}" in
              A)
                echo "✓ Will monitor all projects in organization" >&2
                sentry_project=""  # Empty = all projects
                ;;
              S)
                echo "" >&2
                echo "Enter project numbers to monitor (space-separated, e.g., '1 3 5'):" >&2
                read -p "Projects: " selected_nums

                local selected_projects="[]"
                for num in $selected_nums; do
                  num=$((num - 1))
                  local proj_slug=$(echo "$sentry_projects" | jq -r ".[$num].slug")
                  if [[ "$proj_slug" != "null" ]]; then
                    selected_projects=$(echo "$selected_projects" | jq --arg slug "$proj_slug" '. += [$slug]')
                  fi
                done

                sentry_project="$selected_projects"
                echo "✓ Will monitor $(echo "$selected_projects" | jq 'length') project(s)" >&2
                ;;
              [0-9]*)
                project_num=$((project_choice - 1))
                sentry_project=$(echo "$sentry_projects" | jq -r ".[$project_num].slug")
                local project_name=$(echo "$sentry_projects" | jq -r ".[$project_num].name")
                echo "✓ Using default project: $sentry_project ($project_name)" >&2
                ;;
              *)
                echo "⚠ Invalid choice, will monitor all projects" >&2
                sentry_project=""
                ;;
            esac
          fi
        fi
      fi
    else
      echo "⚠ Token validation failed. You'll need to enter it manually." >&2
    fi
  fi

  # If no token discovered or user declined, ask for it
  if [[ -z "$sentry_token" ]]; then
    echo "" >&2
    echo "Sentry Auth Token Setup:" >&2
    echo "  📚 Documentation: https://docs.sentry.io/api/auth/" >&2
    echo "" >&2
    echo "  Steps:" >&2
    echo "  1. Go to https://sentry.io/settings/account/api/auth-tokens/" >&2
    echo "  2. Click 'Create New Token'" >&2
    echo "  3. Give it a name (e.g., 'Catalyst')" >&2
    echo "  4. Select scopes: project:read, org:read" >&2
    echo "  5. Copy the token" >&2
    echo "" >&2
    echo "  TIP: Save to ~/.sentryclirc to auto-discover next time:" >&2
    echo "       echo '[auth]' > ~/.sentryclirc" >&2
    echo "       echo 'token=YOUR_TOKEN' >> ~/.sentryclirc" >&2
    echo "" >&2

    read -p "Sentry auth token: " sentry_token

    # Validate the manually entered token
    if [[ -n "$sentry_token" ]]; then
      echo "" >&2
      echo "🔍 Validating token..." >&2

      if validation_result=$(validate_sentry_token "$sentry_token" 2>&1); then
        sentry_orgs=$(echo "$validation_result" | jq -r '.organizations')

        echo "✓ Token is valid!" >&2
        echo "  Found $(echo "$sentry_orgs" | jq 'length') organization(s)" >&2
        echo "" >&2

        # Offer to save token
        if ask_yes_no "Save token to ~/.sentryclirc for future use?"; then
          cat > ~/.sentryclirc <<EOF
[auth]
token=$sentry_token
EOF
          chmod 600 ~/.sentryclirc
          echo "✓ Token saved to ~/.sentryclirc" >&2
        fi
      else
        echo "⚠ Warning: Token validation failed. Saving anyway..." >&2
      fi
    fi
  fi

  # Get org slug if not already set
  if [[ -z "$sentry_org" ]]; then
    echo "" >&2
    echo "Organization Slug:" >&2
    echo "  Your Sentry organization URL slug" >&2
    echo "  Example: If your URL is https://my-org.sentry.io, enter 'my-org'" >&2
    echo "" >&2
    read -p "Sentry organization slug: " sentry_org
  fi

  # Get project slug if not already set
  if [[ -z "$sentry_project" ]]; then
    echo "" >&2
    echo "Project Slug:" >&2
    echo "  Your main Sentry project slug" >&2
    echo "  📚 Find it: Sentry → Settings → Projects → [Your Project]" >&2
    echo "" >&2
    read -p "Sentry project slug: " sentry_project
  fi

  # Build config based on project selection
  if [[ -z "$sentry_project" ]]; then
    # All projects - just store org and token
    echo "$config" | jq \
      --arg org "$sentry_org" \
      --arg token "$sentry_token" \
      '.catalyst.sentry = {
        "org": $org,
        "authToken": $token
      }'
  elif [[ "$sentry_project" =~ ^\[.*\]$ ]]; then
    # Multiple projects - store as array
    echo "$config" | jq \
      --arg org "$sentry_org" \
      --argjson projects "$sentry_project" \
      --arg token "$sentry_token" \
      '.catalyst.sentry = {
        "org": $org,
        "projects": $projects,
        "defaultProject": $projects[0],
        "authToken": $token
      }'
  else
    # Single project - store as string for backward compatibility
    echo "$config" | jq \
      --arg org "$sentry_org" \
      --arg project "$sentry_project" \
      --arg token "$sentry_token" \
      '.catalyst.sentry = {
        "org": $org,
        "project": $project,
        "authToken": $token
      }'
  fi
}


prompt_posthog_config() {
  local config="$1"

  echo "" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "PostHog Configuration (Analytics)" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "" >&2

  # Check if already configured
  local has_token
  has_token=$(echo "$config" | jq -r '.catalyst.posthog.apiKey // empty')

  if [ -n "$has_token" ] && [ "$has_token" != "[NEEDS_SETUP]" ]; then
    echo "✓ PostHog already configured" >&2
    if ! ask_yes_no "Update PostHog config?"; then
      echo "$config"
      return 0
    fi
  fi

  if ! ask_yes_no "Configure PostHog integration?"; then
    echo "Skipping PostHog. You can add it later by re-running this script." >&2
    echo "$config"
    return 0
  fi

  echo "" >&2
  echo "" >&2
  echo "PostHog Personal API Key Setup:" >&2
  echo "  📚 Documentation: https://posthog.com/docs/api" >&2
  echo "" >&2
  echo "  Steps:" >&2
  echo "  1. Click your avatar (bottom left) → gear icon → Account settings" >&2
  echo "  2. Go to 'Personal API Keys' tab" >&2
  echo "  3. Click 'Create personal API key'" >&2
  echo "  4. Add a name and select required scopes" >&2
  echo "  5. Copy the key (shown only once!)" >&2
  echo "" >&2

  read -p "PostHog API key: " posthog_key
  read -p "PostHog project ID: " posthog_project

  echo "$config" | jq \
    --arg apiKey "$posthog_key" \
    --arg projectId "$posthog_project" \
    '.catalyst.posthog = {
      "apiKey": $apiKey,
      "projectId": $projectId
    }'
}

prompt_exa_config() {
  local config="$1"

  echo "" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "Exa Configuration (Search API)" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "" >&2

  # Check if already configured
  local has_token
  has_token=$(echo "$config" | jq -r '.catalyst.exa.apiKey // empty')

  if [ -n "$has_token" ] && [ "$has_token" != "[NEEDS_SETUP]" ]; then
    echo "✓ Exa already configured" >&2
    if ! ask_yes_no "Update Exa config?"; then
      echo "$config"
      return 0
    fi
  fi

  if ! ask_yes_no "Configure Exa integration?"; then
    echo "Skipping Exa. You can add it later by re-running this script." >&2
    echo "$config"
    return 0
  fi

  echo "" >&2
  echo "" >&2
  echo "Exa API Key Setup:" >&2
  echo "  📚 Documentation: https://docs.exa.ai/websets/api/get-started" >&2
  echo "" >&2
  echo "  Steps:" >&2
  echo "  1. Create account at https://exa.ai/ (free tier available)" >&2
  echo "  2. Go to https://dashboard.exa.ai/api-keys" >&2
  echo "  3. Click '+ CREATE NEW KEY'" >&2
  echo "  4. Name it (e.g., 'Catalyst') and copy the key" >&2
  echo "  5. Store it securely (shown only once!)" >&2
  echo "" >&2

  read -p "Exa API key: " exa_key

  echo "$config" | jq \
    --arg apiKey "$exa_key" \
    '.catalyst.exa = {
      "apiKey": $apiKey
    }'
}

#
# Initialization functions
#

init_humanlayer_thoughts() {
  print_header "Initializing HumanLayer Thoughts"

  cd "$PROJECT_DIR"

  # Check if already initialized
  if [ -L "thoughts/shared" ] && [ -L "thoughts/global" ]; then
    print_success "Thoughts already initialized in this project"

    # Verify symlinks point to the discovered thoughts repo
    local shared_target
    shared_target=$(readlink "thoughts/shared" 2>/dev/null || echo "")

    if [[ "$shared_target" == *"${THOUGHTS_REPO}"* ]]; then
      print_success "Symlinks point to correct thoughts repo"
      return 0
    else
      print_warning "Symlinks point to different location: $shared_target"

      if ! ask_yes_no "Re-initialize thoughts?"; then
        return 0
      fi

      # Remove old symlinks
      rm -rf thoughts/
    fi
  fi

  echo ""
  echo "Running: humanlayer thoughts init --directory \"${REPO_NAME}\""
  echo ""

  # Try per-project config first, then fall back to --profile flag
  local config_file="$HOME/.config/humanlayer/config-${PROJECT_KEY}.json"
  local init_success=false

  if [ -f "$config_file" ]; then
    if HUMANLAYER_CONFIG="$config_file" humanlayer thoughts init --directory "$REPO_NAME"; then
      init_success=true
    fi
  fi

  # Fall back to --profile if per-project config didn't work
  if ! $init_success; then
    # Check if a matching profile exists in humanlayer.json
    local hl_config="$HOME/.config/humanlayer/humanlayer.json"
    local profile_name=""

    if [ -f "$hl_config" ] && command -v jq &>/dev/null; then
      # Check for profile matching ORG_NAME
      if jq -e ".thoughts.profiles.\"${ORG_NAME}\"" "$hl_config" &>/dev/null; then
        profile_name="$ORG_NAME"
      elif jq -e ".thoughts.profiles.\"${PROJECT_KEY}\"" "$hl_config" &>/dev/null; then
        profile_name="$PROJECT_KEY"
      fi
    fi

    if [ -n "$profile_name" ]; then
      echo "Using HumanLayer profile: $profile_name"
      if humanlayer thoughts init --profile "$profile_name" --directory "$REPO_NAME"; then
        init_success=true
      fi
    fi
  fi

  # Final fallback: try with per-project config even if it doesn't exist yet
  # (humanlayer might use defaults)
  if ! $init_success; then
    if humanlayer thoughts init --directory "$REPO_NAME"; then
      init_success=true
    fi
  fi

  if ! $init_success; then
    print_error "Failed to initialize thoughts"
    echo ""
    echo "You can try manually:"
    echo "  cd $PROJECT_DIR"
    echo "  humanlayer thoughts init --profile ${ORG_NAME} --directory \"${REPO_NAME}\""
    return 1
  fi

  print_success "Thoughts initialized!"

  # Verify structure
  if [ -d "thoughts" ]; then
    echo ""
    echo "Created structure:"
    ls -la thoughts/ | grep -v "^total" | tail -n +2 | sed 's/^/  /'
  fi

  echo ""
}

sync_thoughts() {
  echo "Creating searchable index..."

  cd "$PROJECT_DIR"

  # Try per-project config first, then fall back to default
  local config_file="$HOME/.config/humanlayer/config-${PROJECT_KEY}.json"

  if [ -f "$config_file" ]; then
    if HUMANLAYER_CONFIG="$config_file" humanlayer thoughts sync; then
      print_success "Thoughts synced and indexed"
      echo ""
      return 0
    fi
  fi

  # Fall back to default config (uses profile auto-detection via repoMappings)
  if humanlayer thoughts sync; then
    print_success "Thoughts synced and indexed"
  else
    print_warning "Failed to sync thoughts. You can run manually:"
    echo "  cd $PROJECT_DIR"
    echo "  humanlayer thoughts sync"
  fi

  echo ""
}

#
# Validation functions
#

validate_setup() {
  print_header "Validating Setup"

  local validation_failed=false

  echo "Checking configuration..."
  echo ""

  # Check .catalyst/config.json
  if [ -f "${PROJECT_DIR}/.catalyst/config.json" ]; then
    if jq empty "${PROJECT_DIR}/.catalyst/config.json" 2>/dev/null; then
      print_success "✓ Project config is valid JSON"

      # Verify structure
      local has_key
      has_key=$(jq -r '.catalyst.projectKey // empty' "${PROJECT_DIR}/.catalyst/config.json")

      if [ -n "$has_key" ]; then
        print_success "✓ projectKey configured: $has_key"
      else
        print_error "✗ Missing .catalyst.projectKey"
        validation_failed=true
      fi
    else
      print_error "✗ Project config is invalid JSON"
      validation_failed=true
    fi
  else
    print_error "✗ Project config not found"
    validation_failed=true
  fi

  # Check HumanLayer config (per-project file or profile in humanlayer.json)
  local hl_config="$HOME/.config/humanlayer/config-${PROJECT_KEY}.json"
  local hl_global="$HOME/.config/humanlayer/humanlayer.json"

  if [ -f "$hl_config" ]; then
    if jq empty "$hl_config" 2>/dev/null; then
      print_success "✓ HumanLayer per-project config is valid JSON"

      local repo_path
      repo_path=$(jq -r '.thoughts.thoughtsRepo // empty' "$hl_config")

      if [ -d "$repo_path" ]; then
        print_success "✓ Thoughts repo exists: $repo_path"
      else
        print_error "✗ Thoughts repo not found: $repo_path"
        validation_failed=true
      fi
    else
      print_error "✗ HumanLayer per-project config is invalid JSON"
      validation_failed=true
    fi
  elif [ -f "$hl_global" ]; then
    # Check for profile in global humanlayer.json
    local profile_repo=""
    profile_repo=$(jq -r ".thoughts.profiles.\"${ORG_NAME}\".thoughtsRepo // empty" "$hl_global" 2>/dev/null)

    if [ -n "$profile_repo" ] && [ -d "$profile_repo" ]; then
      print_success "✓ HumanLayer profile '${ORG_NAME}' configured (thoughts: $profile_repo)"
    else
      print_warning "⚠ No HumanLayer per-project config or matching profile found"
      print_warning "  Run: humanlayer thoughts init --profile ${ORG_NAME} --directory ${REPO_NAME}"
    fi
  else
    print_error "✗ HumanLayer config not found"
    validation_failed=true
  fi

  # Check Catalyst secrets
  local secrets_config="$HOME/.config/catalyst/config-${PROJECT_KEY}.json"
  if [ -f "$secrets_config" ]; then
    if jq empty "$secrets_config" 2>/dev/null; then
      print_success "✓ Catalyst secrets config is valid JSON"
    else
      print_error "✗ Catalyst secrets config is invalid JSON"
      validation_failed=true
    fi
  else
    print_warning "⚠ Catalyst secrets config not found (okay if skipped integrations)"
  fi

  # Check thoughts symlinks
  if [ -L "${PROJECT_DIR}/thoughts/shared" ]; then
    print_success "✓ Thoughts symlinks created"
  else
    print_error "✗ Thoughts not initialized in project"
    validation_failed=true
  fi

  # Check worktree directory
  if [ -n "$WORKTREE_BASE" ] && [ -d "$WORKTREE_BASE" ]; then
    print_success "✓ Worktree directory exists: $WORKTREE_BASE"
  elif [ -n "$WORKTREE_BASE" ]; then
    print_warning "⚠ Worktree directory not created (okay if skipped)"
  else
    print_success "✓ Running inside worktree (worktree management handled externally)"
  fi

  echo ""

  if [ "$validation_failed" = true ]; then
    print_error "Validation failed! Please review errors above."
    return 1
  else
    print_success "All validations passed!"
    return 0
  fi
}

print_summary() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  print_header "🎉 Catalyst Setup Complete!"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  echo "📁 Project Configuration:"
  echo "   Location: ${PROJECT_DIR}"
  echo "   Org/Repo: ${ORG_NAME}/${REPO_NAME}"
  echo "   Project Key: ${PROJECT_KEY}"
  echo ""

  echo "🧠 Thoughts Repository:"
  echo "   Location: ${THOUGHTS_REPO}"
  echo "   User: ${USER_NAME}"
  echo ""

  echo "🌳 Worktrees:"
  if [ -n "$WORKTREE_BASE" ]; then
    echo "   Location: ${WORKTREE_BASE}"
  else
    echo "   Managed externally (running inside worktree)"
  fi
  echo ""

  echo "⚙️  Configuration Files:"
  echo "   Project: ${PROJECT_DIR}/.catalyst/config.json"
  echo "   HumanLayer: ~/.config/humanlayer/config-${PROJECT_KEY}.json"
  echo "   Secrets: ~/.config/catalyst/config-${PROJECT_KEY}.json"
  echo ""

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  print_header "Next Steps"
  echo ""

  echo "1. Install Catalyst plugin in Claude Code:"
  echo "   /plugin marketplace add coalesce-labs/catalyst"
  echo "   /plugin install catalyst-dev"
  echo ""

  echo "2. Restart Claude Code to load configuration"
  echo ""

  echo "3. Try your first workflow command:"
  echo "   /research-codebase"
  echo ""

  echo "4. Create a worktree for parallel work:"
  echo "   /create-worktree PROJ-123 main"
  echo ""

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "📚 Documentation:"
  echo "   Documentation: https://catalyst.coalescelabs.ai"
  echo "   Architecture: https://github.com/coalesce-labs/catalyst/blob/main/docs/architecture.md"
  echo ""

  echo "💡 Tip: This script is idempotent. Run again anytime to:"
  echo "   - Add/update integrations"
  echo "   - Fix configuration issues"
  echo "   - Set up additional projects in same org"
  echo ""
}

#
# GitHub backup functions
#

offer_github_backup() {
  echo ""
  print_header "GitHub Backup for Thoughts"

  cd "$THOUGHTS_REPO"

  # Check if already has remote
  if git remote get-url origin >/dev/null 2>&1; then
    local remote_url
    remote_url=$(git remote get-url origin)
    print_success "Thoughts repo already backed up to: $remote_url"
    cd "$PROJECT_DIR"
    return 0
  fi

  echo "Your thoughts repository is not backed up to GitHub."
  echo ""
  echo "Options:"
  echo "  1. Create new private GitHub repo (requires 'gh' CLI)"
  echo "  2. Link to existing GitHub repo (provide URL)"
  echo "  3. Skip (set up backup manually later)"
  echo ""

  read -p "Select option (1, 2, or 3): " backup_option

  case $backup_option in
    1)
      if ! command -v gh &>/dev/null; then
        print_error "GitHub CLI ('gh') not found"
        cd "$PROJECT_DIR"
        return 1
      fi

      local repo_name="${ORG_NAME}-thoughts"
      echo ""
      echo "Creating private GitHub repo: ${ORG_NAME}/${repo_name}"

      if gh repo create "${repo_name}" --private --source=. --push; then
        print_success "Thoughts backed up to GitHub!"
      else
        print_error "Failed to create GitHub repo"
      fi
      ;;
    2)
      echo ""
      read -p "Enter GitHub repo URL (git@github.com:org/repo.git): " remote_url

      git remote add origin "$remote_url"

      if ask_yes_no "Push now?"; then
        git push -u origin main || git push -u origin master
        print_success "Thoughts pushed to GitHub"
      fi
      ;;
    3)
      echo "Skipping GitHub backup. You can set it up later with:"
      echo "  cd $THOUGHTS_REPO"
      echo "  gh repo create my-thoughts --private --source=. --push"
      ;;
    *)
      print_warning "Invalid option. Skipping GitHub backup."
      ;;
  esac

  cd "$PROJECT_DIR"
}

#
# Main execution
#

main() {
  # Handle curl | bash: redirect stdin from terminal for interactive prompts.
  # When piped, bash reads the script from stdin. Once loaded (main is a function,
  # so bash reads the full definition before executing), we redirect stdin to /dev/tty
  # so that read commands can get user input from the terminal.
  if [ ! -t 0 ]; then
    if [ -e /dev/tty ]; then
      exec < /dev/tty
    else
      print_warning "No terminal available. Interactive prompts will use defaults."
    fi
  fi

  # Print banner
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "           🚀 Catalyst Complete Setup"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Run setup steps
  check_prerequisites
  detect_git_repo
  setup_thoughts_repo
  setup_worktree_directory
  setup_project_config
  setup_humanlayer_config
  setup_catalyst_secrets
  update_config_with_linear_states
  init_humanlayer_thoughts
  sync_thoughts

  # Validate
  if validate_setup; then
    print_summary
    exit 0
  else
    echo ""
    print_error "Setup completed with errors. Please review and re-run if needed."
    exit 1
  fi
}

# Run main
main "$@"
