#!/usr/bin/env bash
# Sentry project management helper
# Query and manage Sentry projects from config

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

print_success() { echo -e "${GREEN}✓ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠ $1${NC}"; }
print_error() { echo -e "${RED}✗ $1${NC}"; }
print_info() { echo -e "${BLUE}ℹ $1${NC}"; }

# Get project config
get_project_key() {
  if [[ -f ".claude/config.json" ]]; then
    jq -r '.catalyst.projectKey // empty' .claude/config.json
  fi
}

# Get Sentry config
get_sentry_config() {
  local project_key=$(get_project_key)
  if [[ -z "$project_key" ]]; then
    print_error "No project key found in .claude/config.json"
    return 1
  fi

  local config_file="$HOME/.config/catalyst/config-${project_key}.json"
  if [[ ! -f "$config_file" ]]; then
    print_error "Sentry config not found: $config_file"
    return 1
  fi

  cat "$config_file"
}

# List all projects in organization
list_projects() {
  local config=$(get_sentry_config)
  local org=$(echo "$config" | jq -r '.catalyst.sentry.org')
  local token=$(echo "$config" | jq -r '.catalyst.sentry.authToken')

  if [[ -z "$org" ]] || [[ -z "$token" ]]; then
    print_error "Sentry org or token not configured"
    return 1
  fi

  print_info "Fetching projects for organization: $org"

  local response
  response=$(curl -s -X GET \
    -H "Authorization: Bearer $token" \
    "https://sentry.io/api/0/organizations/$org/projects/" 2>&1)

  if ! echo "$response" | jq -e '.' >/dev/null 2>&1; then
    print_error "Failed to fetch projects"
    echo "$response"
    return 1
  fi

  echo ""
  echo "Projects in $org:"
  echo "$response" | jq -r '.[] | "  \(.slug): \(.name) (\(.platform // "unknown"))"'
}

# Get configured projects
show_config() {
  local config=$(get_sentry_config)
  local org=$(echo "$config" | jq -r '.catalyst.sentry.org')
  local project=$(echo "$config" | jq -r '.catalyst.sentry.project // empty')
  local projects=$(echo "$config" | jq -r '.catalyst.sentry.projects // empty')

  echo ""
  print_info "Sentry Configuration"
  echo ""
  echo "Organization: $org"

  if [[ -n "$projects" ]] && [[ "$projects" != "null" ]]; then
    echo "Monitored projects:"
    echo "$projects" | jq -r '.[] | "  - \(.)"'
    echo "Default: $(echo "$config" | jq -r '.catalyst.sentry.defaultProject')"
  elif [[ -n "$project" ]] && [[ "$project" != "null" ]]; then
    echo "Project: $project"
  else
    echo "Monitoring: All projects"
  fi
}

# Update config to monitor all projects
monitor_all() {
  local project_key=$(get_project_key)
  local config_file="$HOME/.config/catalyst/config-${project_key}.json"

  local config=$(cat "$config_file")
  local org=$(echo "$config" | jq -r '.catalyst.sentry.org')
  local token=$(echo "$config" | jq -r '.catalyst.sentry.authToken')

  # Remove project/projects fields
  echo "$config" | jq \
    --arg org "$org" \
    --arg token "$token" \
    '.catalyst.sentry = {
      "org": $org,
      "authToken": $token
    }' > "$config_file"

  print_success "Updated config to monitor all projects"
}

# Update config to monitor specific projects
monitor_projects() {
  local projects_arg="$1"

  if [[ -z "$projects_arg" ]]; then
    print_error "Usage: $0 monitor-specific project1 project2 ..."
    return 1
  fi

  local project_key=$(get_project_key)
  local config_file="$HOME/.config/catalyst/config-${project_key}.json"

  local config=$(cat "$config_file")
  local org=$(echo "$config" | jq -r '.catalyst.sentry.org')
  local token=$(echo "$config" | jq -r '.catalyst.sentry.authToken')

  # Build projects array
  local projects_json="["
  local first=true
  for proj in $projects_arg; do
    if [[ "$first" == "true" ]]; then
      projects_json+="\"$proj\""
      first=false
    else
      projects_json+=",\"$proj\""
    fi
  done
  projects_json+="]"

  # Update config
  echo "$config" | jq \
    --arg org "$org" \
    --argjson projects "$projects_json" \
    --arg token "$token" \
    '.catalyst.sentry = {
      "org": $org,
      "projects": $projects,
      "defaultProject": $projects[0],
      "authToken": $token
    }' > "$config_file"

  print_success "Updated config to monitor $(echo "$projects_json" | jq 'length') project(s)"
  echo "$projects_json" | jq -r '.[] | "  - \(.)"'
}

# Main CLI
case "${1:-}" in
  list)
    list_projects
    ;;
  show)
    show_config
    ;;
  monitor-all)
    monitor_all
    ;;
  monitor-specific)
    shift
    monitor_projects "$*"
    ;;
  *)
    echo "Sentry Project Helper"
    echo ""
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  list              - List all projects in your organization"
    echo "  show              - Show current Sentry configuration"
    echo "  monitor-all       - Update config to monitor all projects"
    echo "  monitor-specific  - Monitor specific projects (space-separated)"
    echo ""
    echo "Examples:"
    echo "  $0 list"
    echo "  $0 show"
    echo "  $0 monitor-all"
    echo "  $0 monitor-specific bravo-1-backend bravo-1-frontend"
    exit 1
    ;;
esac
