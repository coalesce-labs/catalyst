---
name: ci-describe-pr
description:
  "Generate PR descriptions autonomously for CI/automation (no user interaction). Non-interactive
  variant of /describe-pr for use in CI pipelines and automated workflows. Auto-detects current PR,
  generates description, and updates GitHub."
user-invocable: false
allowed-tools: Bash, Read, Write
version: 1.0.0
---

# CI Describe PR

Generate or update PR descriptions autonomously without user interaction. Designed for CI pipelines
and automated workflows.

## Key Differences from `/describe_pr`

- **No user prompts** — auto-detects current PR
- **No interactive refinement** — generates and updates immediately
- **Same quality** — uses PR template, gathers full context
- **Auto-syncs** — runs `humanlayer thoughts sync` automatically

## Process

### 1. Identify Current PR

```bash
# Auto-detect PR for current branch
PR_JSON=$(gh pr view --json number,url,title,state,body,headRefName,baseRefName 2>/dev/null)

if [[ -z "$PR_JSON" ]]; then
  echo "No PR found for current branch"
  exit 1
fi

PR_NUMBER=$(echo "$PR_JSON" | jq -r '.number')
```

### 2. Read PR Template

```bash
if [[ -f "thoughts/shared/pr_description.md" ]]; then
  # Read template
else
  echo "No PR template found at thoughts/shared/pr_description.md"
  # Generate without template
fi
```

### 3. Gather PR Information

```bash
gh pr diff $PR_NUMBER
gh pr view $PR_NUMBER --json commits,files
gh pr view $PR_NUMBER --json url,title,number,state,baseRefName,headRefName,author
```

### 4. Extract Ticket Reference

```bash
branch=$(echo "$PR_JSON" | jq -r '.headRefName')
if [[ "$branch" =~ ([A-Z]+)-([0-9]+) ]]; then
  ticket="${BASH_REMATCH[0]}"
fi
```

### 5. Generate Description

Analyze all commits and changes. Generate a complete PR description following the template.

**CRITICAL: NO Claude attribution** — remove any "Generated with Claude" or "Co-Authored-By" lines.

**CTL-623 — sibling reference format (REQUIRED):** When referencing related/sibling
work in prose, reference it by its **GitHub PR number (`#NNN`)**, never by a bare Linear
token (`TEAM-NNN`) or a Linear issue URL. A bare sibling `TEAM-NNN` token is auto-linked
by Linear's GitHub integration and drags that sibling's workflow status (Done → Implement)
on PR open/merge. Do **not** emit bare sibling Linear tokens in prose. The own ticket's
`Fixes https://linear.app/...` line is correct and stays. Sibling neutralization is
handled mechanically by the guard block appended at write-back time (step 6).

### 6. Save and Update

```bash
# Save to thoughts
cat > "thoughts/shared/prs/${PR_NUMBER}_description.md" <<EOF
[Generated description]
EOF

# CTL-623: append a Linear automation guard block so sibling tickets embedded in
# the branch name or pulled into the body are NOT auto-linked and dragged backward
# in status when this PR opens/merges. Scans the branch AND the assembled body;
# no-op for single-ticket PRs. See https://linear.app/docs/github (skip/ignore
# negative magic word).
# CTL-633: branch and body are scanned in DIFFERENT modes — the branch goes
# through the awk segmenter (legitimate sibling-number recovery); the body
# uses canonical-only regex so prose, dashed dates, and SHAs cannot fabricate
# fake `skip TEAM-NNN` lines. Stays non-interactive — no cache refresh prompt.
# shellcheck source=/dev/null
source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/linear-pr-skip.sh"
body="$(cat "$body_file")"
skip_block="$( {
    linear_sibling_skip_block_from_branch "$ticket" "$branch"
    linear_sibling_skip_block_from_body   "$ticket" "$body"
} | awk '/^skip /{if(!seen[$0]++) print; next} {if(!h){print; h=1}}' )"
[[ -n "$skip_block" ]] && printf '\n%s\n' "$skip_block" >>"$body_file"

# Sync thoughts
humanlayer thoughts sync

# Update PR on GitHub
gh pr edit $PR_NUMBER --title "$new_title"
gh pr edit $PR_NUMBER --body-file "thoughts/shared/prs/${PR_NUMBER}_description.md"
```

### 7. Update Linear (if ticket found)

If Linearis CLI is available, update the ticket status to `stateMap.inReview` from config.
Use `linearis issues usage` for exact update syntax. Skip silently if CLI not available.

### 8. Report

```
PR description updated: #$PR_NUMBER
URL: $PR_URL
Ticket: $ticket (updated to In Review)
```

## Important

- **NEVER prompt the user** — fully autonomous
- **NEVER add Claude attribution** to PR descriptions
- **ALWAYS save to thoughts/shared/prs/** before updating GitHub

**IMPORTANT: Document Storage Rules**

- ALWAYS write to `thoughts/shared/prs/` for PR descriptions
- NEVER write to `thoughts/searchable/` — this is a read-only search index
