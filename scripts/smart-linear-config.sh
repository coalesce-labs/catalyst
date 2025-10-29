#!/usr/bin/env bash
# Smart Linear configuration with auto-discovery and validation
# Usage: source this in setup-catalyst.sh

prompt_linear_config_smart() {
  local config="$1"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Linear Configuration (Project Management)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

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

  # Source helper functions
  local helpers_script=""
  if [[ -f "scripts/catalyst-integration-helpers.sh" ]]; then
    helpers_script="scripts/catalyst-integration-helpers.sh"
  elif [[ -f "$(dirname "$0")/catalyst-integration-helpers.sh" ]]; then
    helpers_script="$(dirname "$0")/catalyst-integration-helpers.sh"
  fi

  local discovered_token=""
  local discovery_source=""
  local linear_token=""
  local linear_org=""
  local linear_teams=""
  local linear_team=""
  local linear_team_name=""

  # Try to discover existing token
  if [[ -n "$helpers_script" ]]; then
    echo "🔍 Checking for existing Linear API token..." >&2

    if discovered_token=$(bash "$helpers_script" discover-linear 2>&1); then
      discovery_source=$(echo "$discovered_token" | head -1)
      discovered_token=$(echo "$discovered_token" | tail -1)

      echo "" >&2
      echo "✓ Found existing Linear API token in: $discovery_source" >&2

      # Validate the token
      echo "🔍 Validating token and fetching organization info..." >&2

      if validation_result=$(bash "$helpers_script" validate-linear "$discovered_token" 2>&1); then
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
    if [[ -n "$helpers_script" ]] && [[ -n "$linear_token" ]]; then
      echo "" >&2
      echo "🔍 Validating token..." >&2

      if validation_result=$(bash "$helpers_script" validate-linear "$linear_token" 2>&1); then
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
    if [ -f "${PROJECT_DIR}/.claude/config.json" ]; then
      linear_team=$(jq -r '.catalyst.project.ticketPrefix // "PROJ"' "${PROJECT_DIR}/.claude/config.json")
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
