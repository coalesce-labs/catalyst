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

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "::warning::ANTHROPIC_API_KEY not set — skipping release notes enhancement"
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
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{role: "user", content: $content}]
  }')

echo "Calling Claude API..."
response=$(curl -sS --max-time 30 \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
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

    version_line=$(grep -m1 '^## \[' "$changelog_file" || true)
    if [[ -z "$version_line" ]]; then
      continue
    fi

    version=$(echo "$version_line" | sed -E 's/^## \[([0-9]+\.[0-9]+\.[0-9]+)\].*/\1/')
    if [[ -z "$version" ]]; then
      continue
    fi

    next_version_line=$(grep -m2 '^## \[' "$changelog_file" | tail -1)
    if [[ "$next_version_line" == "$version_line" ]]; then
      section_end=$(wc -l < "$changelog_file")
    else
      section_end=$(grep -n '^## \[' "$changelog_file" | sed -n '2p' | cut -d: -f1)
      section_end=$((section_end - 1))
    fi
    first_line=$(grep -n '^## \[' "$changelog_file" | head -1 | cut -d: -f1)

    original_section=$(sed -n "${first_line},${section_end}p" "$changelog_file")

    plugin_commits=$(echo "$commit_messages" | grep -i "$plugin_name" || echo "$commit_messages")
    plugin_prompt="Write a concise release summary (2-3 sentences) for catalyst-$plugin_name version $version. Commits: $plugin_commits"

    plugin_request=$(jq -nc \
      --arg content "$plugin_prompt" \
      '{
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{role: "user", content: $content}]
      }')

    plugin_response=$(curl -sS --max-time 30 \
      -H "x-api-key: $ANTHROPIC_API_KEY" \
      -H "anthropic-version: 2023-06-01" \
      -H "content-type: application/json" \
      -d "$plugin_request" \
      "https://api.anthropic.com/v1/messages" 2>/dev/null) || continue

    plugin_summary=$(echo "$plugin_response" | jq -r '.content[0].text // empty' 2>/dev/null) || continue

    if [[ -z "$plugin_summary" ]]; then
      continue
    fi

    enhanced_section="$version_line"$'\n\n'
    enhanced_section+="$plugin_summary"$'\n\n'
    enhanced_section+='<details><summary>Detailed changes</summary>'$'\n\n'
    detail_lines=$(echo "$original_section" | tail -n +2)
    enhanced_section+="$detail_lines"$'\n\n'
    enhanced_section+='</details>'

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
    echo "Updated $changelog_file with enhanced notes"

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
