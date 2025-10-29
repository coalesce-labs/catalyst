#!/usr/bin/env bash
# Integration helper functions for Catalyst setup
# Discovers existing tokens and validates them via APIs

set -euo pipefail

#
# Linear API helpers
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
# Returns JSON: {"valid": true, "viewer": {...}, "teams": [...]}
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

# Format Linear teams for user selection
format_linear_teams() {
  local teams_json="$1"

  echo "$teams_json" | jq -r '.[] | "\(.key): \(.name)"'
}

#
# Sentry API helpers
#

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

# Format Sentry organizations for user selection
format_sentry_orgs() {
  local orgs_json="$1"

  echo "$orgs_json" | jq -r '.[] | "\(.slug): \(.name)"'
}

# Format Sentry projects for user selection
format_sentry_projects() {
  local projects_json="$1"

  echo "$projects_json" | jq -r '.[] | "\(.slug): \(.name)"'
}

#
# Railway API helpers
#

discover_railway_token() {
  local token=""

  # Check environment variable
  if [[ -n "${RAILWAY_TOKEN:-}" ]]; then
    echo "env" >&2
    echo "$RAILWAY_TOKEN"
    return 0
  fi

  # Check ~/.railway/config.json
  if [[ -f ~/.railway/config.json ]]; then
    token=$(jq -r '.railway_token // empty' ~/.railway/config.json 2>/dev/null || echo "")
    if [[ -n "$token" ]]; then
      echo "file" >&2
      echo "$token"
      return 0
    fi
  fi

  return 1
}

validate_railway_token() {
  local token="$1"

  # Railway uses GraphQL
  local query='{ me { id name email } projects { edges { node { id name } } } }'

  local response
  response=$(curl -s -X POST \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"$query\"}" \
    https://backboard.railway.app/graphql/v2 2>&1)

  if echo "$response" | jq -e '.errors' >/dev/null 2>&1; then
    echo '{"valid": false, "error": "Invalid token"}' >&2
    return 1
  fi

  local user=$(echo "$response" | jq -r '.data.me')

  if [[ "$user" == "null" ]]; then
    echo '{"valid": false, "error": "No user data"}' >&2
    return 1
  fi

  echo "$response" | jq '{
    valid: true,
    user: .data.me,
    projects: .data.projects.edges
  }'
}

#
# PostHog API helpers
#

discover_posthog_key() {
  local key=""

  if [[ -n "${POSTHOG_API_KEY:-}" ]]; then
    echo "env" >&2
    echo "$POSTHOG_API_KEY"
    return 0
  fi

  return 1
}

validate_posthog_key() {
  local key="$1"
  local project_id="${2:-}"

  # If no project ID, try to get user info
  local url="https://app.posthog.com/api/users/@me/"
  if [[ -n "$project_id" ]]; then
    url="https://app.posthog.com/api/projects/$project_id/"
  fi

  local response
  response=$(curl -s -X GET \
    -H "Authorization: Bearer $key" \
    "$url" 2>&1)

  if ! echo "$response" | jq -e '.' >/dev/null 2>&1; then
    echo '{"valid": false, "error": "Invalid response"}' >&2
    return 1
  fi

  if echo "$response" | jq -e '.detail' >/dev/null 2>&1; then
    echo '{"valid": false, "error": "Invalid API key"}' >&2
    return 1
  fi

  echo '{"valid": true}' | jq --argjson data "$response" '. + {data: $data}'
}

#
# Main CLI
#

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    discover-linear)
      discover_linear_token
      ;;
    validate-linear)
      validate_linear_token "${2:-}"
      ;;
    discover-sentry)
      discover_sentry_token
      ;;
    validate-sentry)
      validate_sentry_token "${2:-}"
      ;;
    discover-railway)
      discover_railway_token
      ;;
    validate-railway)
      validate_railway_token "${2:-}"
      ;;
    *)
      echo "Usage: $0 {discover-linear|validate-linear|discover-sentry|validate-sentry|discover-railway|validate-railway}"
      exit 1
      ;;
  esac
fi
