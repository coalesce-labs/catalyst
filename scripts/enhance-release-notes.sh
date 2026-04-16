#!/usr/bin/env bash
set -euo pipefail

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" ]]; then
  echo "Usage: enhance-release-notes.sh <pr-number>"
  exit 1
fi

REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_TEMPLATE="$SCRIPT_DIR/templates/release-notes-prompt.md"
BACKFILL_PROMPT_TEMPLATE="$SCRIPT_DIR/templates/backfill-release-notes-prompt.md"

# Prefer LOCAL_ANTHROPIC_API_KEY to avoid conflicts with Claude Code's own key.
# Falls back to ANTHROPIC_API_KEY for CI environments.
API_KEY="${LOCAL_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}"

if [[ -z "$API_KEY" ]]; then
  echo "::warning::LOCAL_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) not set — skipping release notes enhancement"
  exit 0
fi

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "::error::Prompt template not found at $PROMPT_TEMPLATE"
  exit 1
fi

echo "Enhancing release notes for PR #$PR_NUMBER in $REPO"

pr_body=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.body // ""')

commits_json=$(gh api "repos/$REPO/pulls/$PR_NUMBER/commits" --paginate)
commit_messages=$(echo "$commits_json" | jq -r '.[].commit.message' | head -100)

files_json=$(gh api "repos/$REPO/pulls/$PR_NUMBER/files" --paginate)
changed_files=$(echo "$files_json" | jq -r '.[].filename')

pr_numbers=$(echo "$commit_messages" | grep -oE '#[0-9]+' | tr -d '#' | sort -u || true)
pr_descriptions=""
for pr_num in $pr_numbers; do
  if [[ "$pr_num" == "$PR_NUMBER" ]]; then
    continue
  fi
  desc=$(gh api "repos/$REPO/pulls/$pr_num" --jq '.body // ""' 2>/dev/null || true)
  if [[ -n "$desc" ]]; then
    pr_descriptions+="### PR #$pr_num"$'\n'"$desc"$'\n\n'
  fi
done

migration_signals=""

new_sql_files=$(echo "$changed_files" | grep -E 'db-migrations/[0-9]+_.*\.sql$' || true)
if [[ -n "$new_sql_files" ]]; then
  migration_signals+="- **Database migration detected**: New SQL migration files added:"$'\n'
  while IFS= read -r f; do
    migration_signals+="  - \`$f\`"$'\n'
  done <<< "$new_sql_files"
  migration_signals+="  Users should run \`catalyst-db.sh migrate\` after updating."$'\n'
fi

config_template_changed=$(echo "$changed_files" | grep -F 'templates/config.template.json' || true)
if [[ -n "$config_template_changed" ]]; then
  migration_signals+="- **Config schema change detected**: \`config.template.json\` was modified. Users may need to update \`.catalyst/config.json\` or re-run \`setup-catalyst.sh\`."$'\n'
fi

setup_changed=$(echo "$changed_files" | grep -F 'setup-catalyst.sh' || true)
if [[ -n "$setup_changed" ]]; then
  migration_signals+="- **Setup script changed**: \`setup-catalyst.sh\` was modified. Users should re-run the setup script to pick up new configuration."$'\n'
fi

breaking_commits=$(echo "$commit_messages" | grep -E '^(feat|fix|refactor|perf)\(.*\)!:' || true)
if [[ -n "$breaking_commits" ]]; then
  migration_signals+="- **Breaking changes detected** in commits:"$'\n'
  while IFS= read -r bc; do
    migration_signals+="  - \`$bc\`"$'\n'
  done <<< "$breaking_commits"
fi

plugin_json_changed=$(echo "$changed_files" | grep -E 'plugin\.json$' || true)
agent_changes=""
for pj in $plugin_json_changed; do
  if echo "$files_json" | jq -r --arg f "$pj" '.[] | select(.filename == $f) | .patch // ""' | grep -q '"agents"'; then
    agent_changes+="  - \`$pj\`"$'\n'
  fi
done
if [[ -n "$agent_changes" ]]; then
  migration_signals+="- **Plugin agent changes detected**:"$'\n'"$agent_changes"
fi

state_schema_changed=$(echo "$changed_files" | grep -E 'templates/global-(state|event)\.json$' || true)
if [[ -n "$state_schema_changed" ]]; then
  migration_signals+="- **Runtime schema change detected**: Global state or event schema templates were modified. Dashboard consumers may need updates."$'\n'
fi

if [[ -z "$migration_signals" ]]; then
  migration_signals="No migration or upgrade signals detected."
fi

prompt_content=$(jq -Rrs \
  --arg changelog "$pr_body" \
  --arg commits "$commit_messages" \
  --arg prs "$pr_descriptions" \
  --arg migrations "$migration_signals" \
  'gsub("\\{CHANGELOG\\}"; $changelog)
   | gsub("\\{COMMITS\\}"; $commits)
   | gsub("\\{PR_DESCRIPTIONS\\}"; $prs)
   | gsub("\\{MIGRATION_SIGNALS\\}"; $migrations)' \
  "$PROMPT_TEMPLATE")

request_body=$(jq -nc \
  --arg content "$prompt_content" \
  '{
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{role: "user", content: $content}]
  }')

echo "Calling Claude API..."
response=$(curl -sS --max-time 30 \
  -H "x-api-key: $API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "$request_body" \
  "https://api.anthropic.com/v1/messages" 2>&1) || {
  echo "::warning::Claude API call failed — keeping original release notes"
  exit 0
}

ai_notes=$(echo "$response" | jq -r '.content[0].text // empty' 2>/dev/null) || {
  echo "::warning::Failed to parse Claude API response — keeping original release notes"
  echo "Response: $response"
  exit 0
}

if [[ -z "$ai_notes" ]]; then
  echo "::warning::Claude API returned empty response — keeping original release notes"
  echo "Response: $response"
  exit 0
fi

enhanced_body="$ai_notes"
enhanced_body+=$'\n\n---\n\n'
enhanced_body+='<details><summary>Conventional Changelog (auto-generated)</summary>'$'\n\n'
enhanced_body+="$pr_body"
enhanced_body+=$'\n\n</details>'

gh pr edit "$PR_NUMBER" --repo "$REPO" --body "$enhanced_body"
echo "PR #$PR_NUMBER body updated with enhanced release notes"

head_branch=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.head.ref')
current_branch=$(git branch --show-current 2>/dev/null || echo "")

if [[ -n "$head_branch" ]]; then
  git fetch origin "$head_branch" 2>/dev/null || true
  git checkout "$head_branch" 2>/dev/null || {
    echo "::warning::Could not checkout release branch $head_branch — skipping CHANGELOG update"
    exit 0
  }

  changelogs_updated=false

  while IFS= read -r changelog_file; do
    if [[ ! -f "$changelog_file" ]]; then
      continue
    fi

    plugin_dir=$(dirname "$changelog_file")
    plugin_name=$(basename "$plugin_dir")

    # Read all version heading line numbers into an array (avoids grep|head pipe)
    local_line_nums=()
    local_versions=()
    while IFS=: read -r lnum line; do
      local_line_nums+=("$lnum")
      local_versions+=("$line")
    done < <(grep -n '^## \[' "$changelog_file" || true)

    if [[ ${#local_versions[@]} -eq 0 ]]; then
      continue
    fi

    version_line="${local_versions[0]}"
    first_line="${local_line_nums[0]}"

    version=$(echo "$version_line" | sed -E 's/^## \[([0-9]+\.[0-9]+\.[0-9]+)\].*/\1/')
    if [[ -z "$version" ]]; then
      continue
    fi

    # Determine section end from array (no pipe needed)
    if [[ ${#local_line_nums[@]} -gt 1 ]]; then
      section_end=$(( ${local_line_nums[1]} - 1 ))
    else
      section_end=$(wc -l < "$changelog_file")
    fi

    original_section=$(sed -n "${first_line},${section_end}p" "$changelog_file")

    # Skip if already enhanced
    if echo "$original_section" | grep -q '<!-- ai-enhanced -->'; then
      echo "  [$version] already enhanced, skipping"
      continue
    fi

    # Extract PR numbers from original entries
    section_pr_nums=$(echo "$original_section" | grep -oE '#[0-9]+' | tr -d '#' | sort -u || true)

    # Fetch PR descriptions for the backfill prompt
    section_pr_descriptions=""
    for pr_num in $section_pr_nums; do
      desc=$(gh api "repos/$REPO/pulls/$pr_num" --jq '.body // ""' 2>/dev/null || true)
      if [[ -n "$desc" ]]; then
        section_pr_descriptions+="### PR #$pr_num"$'\n'"$desc"$'\n\n'
      fi
    done

    # Use the backfill prompt template for consistent formatting
    if [[ -f "$BACKFILL_PROMPT_TEMPLATE" ]]; then
      plugin_prompt=$(jq -Rrs \
        --arg changelog "$original_section" \
        --arg commits "$commit_messages" \
        --arg prs "$section_pr_descriptions" \
        --arg migrations "$migration_signals" \
        'gsub("\\{CHANGELOG\\}"; $changelog)
         | gsub("\\{COMMITS\\}"; $commits)
         | gsub("\\{PR_DESCRIPTIONS\\}"; $prs)
         | gsub("\\{MIGRATION_SIGNALS\\}"; $migrations)' \
        "$BACKFILL_PROMPT_TEMPLATE")
    else
      plugin_prompt="Write a concise release summary for catalyst-$plugin_name version $version. Output a short title (3-6 words) on the first line, then a blank line, then a 2-4 sentence summary. Commits: $commit_messages"
    fi

    plugin_request=$(jq -nc \
      --arg content "$plugin_prompt" \
      '{
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{role: "user", content: $content}]
      }')

    echo "  [$version] calling Claude API for CHANGELOG enhancement..."
    plugin_response=$(curl -sS --max-time 60 \
      -H "x-api-key: $API_KEY" \
      -H "anthropic-version: 2023-06-01" \
      -H "content-type: application/json" \
      -d "$plugin_request" \
      "https://api.anthropic.com/v1/messages" 2>/dev/null) || continue

    plugin_ai_notes=$(echo "$plugin_response" | jq -r '.content[0].text // empty' 2>/dev/null) || continue

    if [[ -z "$plugin_ai_notes" ]]; then
      continue
    fi

    # Parse title and summary from AI output (same as backfill script)
    ai_title=$(echo "$plugin_ai_notes" | head -1 | sed 's/^#* *//')
    ai_summary=$(echo "$plugin_ai_notes" | tail -n +2 | sed '/./,$!d')

    # Extract date from version line or use today
    release_date=$(echo "$version_line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)
    if [[ -n "$release_date" ]]; then
      formatted_date=$(date -d "$release_date" '+%b %d, %Y' 2>/dev/null || date -jf '%Y-%m-%d' "$release_date" '+%b %d, %Y' 2>/dev/null || echo "$release_date")
    else
      formatted_date=$(date '+%b %d, %Y')
    fi

    # Strip inline date from version heading for clean format
    clean_version_line=$(echo "$version_line" | sed -E 's/ \([0-9]{4}-[0-9]{2}-[0-9]{2}\)//')

    # Collect original PR entries (### Features, ### Bug Fixes, bullets)
    original_entries=$(echo "$original_section" | tail -n +2 | sed '/^$/d')

    # Build enhanced section matching backfill format
    enhanced_section="$clean_version_line"$'\n\n'
    enhanced_section+="$formatted_date"$'\n\n'
    enhanced_section+='<!-- ai-enhanced -->'$'\n\n'
    if [[ -n "$ai_title" ]]; then
      enhanced_section+="### $ai_title"$'\n\n'
    fi
    if [[ -n "$ai_summary" ]]; then
      enhanced_section+="$ai_summary"$'\n\n'
    fi
    enhanced_section+=$'\n\n### PRs\n\n'
    # Keep original bullet entries (strip ### headings, keep * lines)
    original_bullets=$(echo "$original_section" | grep '^\* ' || true)
    if [[ -n "$original_bullets" ]]; then
      enhanced_section+="$original_bullets"$'\n'
    fi

    tmp_file=$(mktemp)
    {
      if [[ "$first_line" -gt 1 ]]; then
        head -n $((first_line - 1)) "$changelog_file"
      fi
      echo "$enhanced_section"
      if [[ "$section_end" -lt $(wc -l < "$changelog_file") ]]; then
        tail -n +"$((section_end + 1))" "$changelog_file"
      fi
    } > "$tmp_file"

    mv "$tmp_file" "$changelog_file"
    git add "$changelog_file"
    changelogs_updated=true
    echo "  [$version] enhanced with AI-generated title and summary"

  done < <(echo "$changed_files" | grep 'CHANGELOG.md$' || true)

  if [[ "$changelogs_updated" == "true" ]]; then
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git commit -m "chore: enhance release notes with AI-generated summaries" || true
    git push origin "$head_branch" || {
      echo "::warning::Could not push CHANGELOG updates to $head_branch"
    }
    echo "Pushed enhanced CHANGELOGs to $head_branch"
  fi

  if [[ -n "$current_branch" && "$current_branch" != "$head_branch" ]]; then
    git checkout "$current_branch" 2>/dev/null || true
  fi
fi

echo "Release notes enhancement complete for PR #$PR_NUMBER"
