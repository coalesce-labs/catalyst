#!/usr/bin/env bash
# backfill-release-notes.sh — One-shot script to enhance existing CHANGELOG.md
# entries with AI-generated summaries.
#
# Usage:
#   LOCAL_ANTHROPIC_API_KEY=sk-... bash scripts/backfill-release-notes.sh [plugin]
#
# If plugin is omitted, processes all plugins. Otherwise just the named one.
# Writes enhanced CHANGELOGs in-place with AI summaries inserted after each
# version heading, preserving the original conventional changelog entries
# (with PR links) below the summary.
#
# Uses LOCAL_ANTHROPIC_API_KEY to avoid conflicts with Claude Code's own
# ANTHROPIC_API_KEY. Falls back to ANTHROPIC_API_KEY for CI environments.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${GITHUB_REPOSITORY:-coalesce-labs/catalyst}"
PROMPT_TEMPLATE="$SCRIPT_DIR/templates/backfill-release-notes-prompt.md"
API_KEY="${LOCAL_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}"

if [[ -z "$API_KEY" ]]; then
  echo "Error: LOCAL_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) not set"
  exit 1
fi

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: Prompt template not found at $PROMPT_TEMPLATE"
  exit 1
fi

# Which plugins to process
TARGET_PLUGIN="${1:-}"
if [[ -n "$TARGET_PLUGIN" ]]; then
  CHANGELOG_FILES=("plugins/$TARGET_PLUGIN/CHANGELOG.md")
else
  CHANGELOG_FILES=(plugins/*/CHANGELOG.md)
fi

call_claude() {
  local prompt_content="$1"
  local request_body
  request_body=$(jq -nc \
    --arg content "$prompt_content" \
    '{
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{role: "user", content: $content}]
    }')

  local response
  response=$(curl -sS --max-time 60 \
    -H "x-api-key: $API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "$request_body" \
    "https://api.anthropic.com/v1/messages" 2>&1) || {
    echo ""
    return
  }

  echo "$response" | jq -r '.content[0].text // empty' 2>/dev/null || echo ""
}

get_pr_description() {
  local pr_num="$1"
  gh api "repos/$REPO/pulls/$pr_num" --jq '.body // ""' 2>/dev/null || echo ""
}

process_changelog() {
  local changelog_file="$1"
  local plugin_dir
  plugin_dir=$(dirname "$changelog_file")
  local plugin_name
  plugin_name=$(basename "$plugin_dir")

  echo "Processing $changelog_file (plugin: $plugin_name)"

  # Read the full file
  local content
  content=$(cat "$changelog_file")

  # Find all version headings with line numbers
  local versions=()
  local line_nums=()
  while IFS=: read -r lnum line; do
    versions+=("$line")
    line_nums+=("$lnum")
  done < <(grep -n '^## \[' "$changelog_file")

  local total=${#versions[@]}
  echo "  Found $total versions"

  # Process each version
  local i=0
  local modified=false
  local new_content=""
  local prev_end=0

  for ((i = 0; i < total; i++)); do
    local version_line="${versions[$i]}"
    local start_line="${line_nums[$i]}"

    # Determine end of this version section
    local end_line
    if [[ $((i + 1)) -lt $total ]]; then
      end_line=$((${line_nums[$((i + 1))]} - 1))
    else
      end_line=$(wc -l < "$changelog_file")
    fi

    # Extract version number
    local version
    version=$(echo "$version_line" | sed -E 's/^## \[([0-9]+\.[0-9]+\.[0-9]+)\].*/\1/')
    if [[ -z "$version" ]]; then
      continue
    fi

    # Extract section content
    local section
    section=$(sed -n "${start_line},${end_line}p" "$changelog_file")

    # Skip if already enhanced (has AI summary marker)
    if echo "$section" | grep -q '<!-- ai-enhanced -->'; then
      echo "  [$version] already enhanced, skipping"
      continue
    fi

    # Extract PR numbers from the section
    local pr_nums
    pr_nums=$(echo "$section" | grep -oE '#[0-9]+' | tr -d '#' | sort -u || true)

    # Get commit messages from the section (the bullet points)
    local commit_messages
    commit_messages=$(echo "$section" | grep '^\* ' | sed 's/^\* //' || true)

    # Fetch PR descriptions
    local pr_descriptions=""
    for pr_num in $pr_nums; do
      local desc
      desc=$(get_pr_description "$pr_num")
      if [[ -n "$desc" ]]; then
        pr_descriptions+="### PR #$pr_num"$'\n'"$desc"$'\n\n'
      fi
    done

    # Build the prompt
    local prompt_content
    prompt_content=$(jq -Rrs \
      --arg changelog "$section" \
      --arg commits "$commit_messages" \
      --arg prs "$pr_descriptions" \
      --arg migrations "No migration or upgrade signals detected." \
      'gsub("\\{CHANGELOG\\}"; $changelog)
       | gsub("\\{COMMITS\\}"; $commits)
       | gsub("\\{PR_DESCRIPTIONS\\}"; $prs)
       | gsub("\\{MIGRATION_SIGNALS\\}"; $migrations)' \
      "$PROMPT_TEMPLATE")

    echo "  [$version] calling Claude API (${#pr_nums} PRs)..."
    local ai_notes
    ai_notes=$(call_claude "$prompt_content")

    if [[ -z "$ai_notes" ]]; then
      echo "  [$version] API returned empty, skipping"
      continue
    fi

    # Parse title (first non-empty line) and summary (rest) from AI output
    local ai_title=""
    local ai_summary=""
    ai_title=$(echo "$ai_notes" | head -1 | sed 's/^#* *//')
    ai_summary=$(echo "$ai_notes" | tail -n +2 | sed '/./,$!d')

    # Build enhanced section: version heading + title + summary + original entries (with PR links)
    local enhanced=""
    enhanced+="$version_line"$'\n\n'
    enhanced+='<!-- ai-enhanced -->'$'\n\n'
    if [[ -n "$ai_title" ]]; then
      enhanced+="### $ai_title"$'\n\n'
    fi
    if [[ -n "$ai_summary" ]]; then
      enhanced+="$ai_summary"$'\n\n'
    fi
    # Keep original entries with PR links visible below the summary
    local original_body
    original_body=$(echo "$section" | tail -n +2)
    enhanced+="$original_body"$'\n'

    # Replace the section in the file
    local tmp_file
    tmp_file=$(mktemp)
    {
      if [[ "$start_line" -gt 1 ]]; then
        head -n $((start_line - 1)) "$changelog_file"
      fi
      echo "$enhanced"
      if [[ "$end_line" -lt $(wc -l < "$changelog_file") ]]; then
        tail -n +"$((end_line + 1))" "$changelog_file"
      fi
    } > "$tmp_file"

    mv "$tmp_file" "$changelog_file"
    modified=true
    echo "  [$version] enhanced"

    # Re-read line numbers since we modified the file
    versions=()
    line_nums=()
    while IFS=: read -r lnum line; do
      versions+=("$line")
      line_nums+=("$lnum")
    done < <(grep -n '^## \[' "$changelog_file")
    total=${#versions[@]}

    # Rate limiting — be nice to the API
    sleep 1
  done

  if [[ "$modified" == "true" ]]; then
    echo "  Done — $changelog_file updated"
  else
    echo "  No changes needed"
  fi
}

for changelog in "${CHANGELOG_FILES[@]}"; do
  if [[ ! -f "$changelog" ]]; then
    echo "Warning: $changelog not found, skipping"
    continue
  fi
  process_changelog "$changelog"
done

echo ""
echo "Backfill complete. Review changes with:"
echo "  git diff plugins/*/CHANGELOG.md"
