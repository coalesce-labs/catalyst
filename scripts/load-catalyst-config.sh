#!/bin/bash
# Load Catalyst config from ~/.config/catalyst/

load_config() {
  local config_file=".claude/config.json"

  if [[ ! -f "$config_file" ]]; then
    echo "ERROR: .claude/config.json not found" >&2
    return 1
  fi

  # Get project key from .claude/config.json
  local project_key=$(jq -r '.projectKey // empty' "$config_file")

  if [[ -z "$project_key" ]]; then
    echo "ERROR: projectKey not set in .claude/config.json" >&2
    echo "Run: ./scripts/setup-catalyst-config.sh" >&2
    return 1
  fi

  local external_config="$HOME/.config/catalyst/config-$project_key.json"

  if [[ ! -f "$external_config" ]]; then
    echo "ERROR: Config not found: $external_config" >&2
    echo "Run: ./scripts/setup-catalyst-config.sh" >&2
    return 1
  fi

  # Merge configs: .claude/config.json + external config
  jq -s '.[0] * .[1]' "$config_file" "$external_config"
}

# Usage:
# FULL_CONFIG=$(load_config)
# LINEAR_TOKEN=$(echo "$FULL_CONFIG" | jq -r '.linear.apiToken')
