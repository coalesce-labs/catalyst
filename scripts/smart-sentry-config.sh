#!/usr/bin/env bash
# Smart Sentry configuration with auto-discovery and validation

prompt_sentry_config_smart() {
  local config="$1"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Sentry Configuration (Error Monitoring)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

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

  # Source helper functions
  local helpers_script=""
  if [[ -f "scripts/catalyst-integration-helpers.sh" ]]; then
    helpers_script="scripts/catalyst-integration-helpers.sh"
  elif [[ -f "$(dirname "$0")/catalyst-integration-helpers.sh" ]]; then
    helpers_script="$(dirname "$0")/catalyst-integration-helpers.sh"
  fi

  local discovered_token=""
  local discovery_source=""
  local sentry_token=""
  local sentry_orgs=""
  local sentry_org=""
  local sentry_projects=""
  local sentry_project=""

  # Try to discover existing token
  if [[ -n "$helpers_script" ]]; then
    echo "🔍 Checking for existing Sentry auth token..." >&2

    if discovered_token=$(bash "$helpers_script" discover-sentry 2>&1); then
      discovery_source=$(echo "$discovered_token" | head -1)
      discovered_token=$(echo "$discovered_token" | tail -1)

      echo "" >&2
      echo "✓ Found existing Sentry auth token in: $discovery_source" >&2

      # Validate the token
      echo "🔍 Validating token and fetching organization info..." >&2

      if validation_result=$(bash "$helpers_script" validate-sentry "$discovered_token" 2>&1); then
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

          # Let user select project
          if [[ -n "$sentry_projects" ]]; then
            local project_count=$(echo "$sentry_projects" | jq 'length')

            if [[ $project_count -eq 1 ]]; then
              sentry_project=$(echo "$sentry_projects" | jq -r '.[0].slug')
              local project_name=$(echo "$sentry_projects" | jq -r '.[0].name')
              echo "Using project: $sentry_project ($project_name)" >&2
            elif [[ $project_count -gt 1 ]]; then
              echo "" >&2
              echo "Select a project:" >&2
              echo "$sentry_projects" | jq -r 'to_entries | .[] | "  \(.key + 1). \(.value.slug): \(.value.name)"' >&2
              echo "" >&2

              read -p "Enter project number [1-$project_count]: " project_num
              project_num=$((project_num - 1))

              sentry_project=$(echo "$sentry_projects" | jq -r ".[$project_num].slug")
            fi
          fi
        fi
      else
        echo "⚠ Token validation failed. You'll need to enter it manually." >&2
      fi
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
    if [[ -n "$helpers_script" ]] && [[ -n "$sentry_token" ]]; then
      echo "" >&2
      echo "🔍 Validating token..." >&2

      if validation_result=$(bash "$helpers_script" validate-sentry "$sentry_token" 2>&1); then
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

  # Build config
  echo "$config" | jq \
    --arg org "$sentry_org" \
    --arg project "$sentry_project" \
    --arg token "$sentry_token" \
    '.catalyst.sentry = {
      "org": $org,
      "project": $project,
      "authToken": $token
    }'
}
