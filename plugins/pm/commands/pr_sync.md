---
description: Correlate GitHub PRs with Linear issues and identify sync gaps
category: pm
tools: Bash(gh *), Bash(linearis *), Bash(jq *), Bash(git *), Read, Write, Task
model: inherit
version: 1.0.0
---

# PR Sync Command

Analyzes the relationship between GitHub pull requests and Linear issues to identify:
- PRs without linked Linear issues
- Linear issues without associated PRs
- Merged PRs with open Linear issues (candidates for closure)
- Open PRs for completed Linear issues (stale PRs)

## Process

### Step 1: Gather PR Data from GitHub

```bash
# Get open PRs
open_prs=$(gh pr list --json number,title,headRefName,author,createdAt,url --limit 100)

# Get recently merged PRs (last 7 days)
merged_prs=$(gh pr list \
  --state merged \
  --search "merged:>=@(date -v-7d +%Y-%m-%d)" \
  --json number,title,headRefName,author,mergedAt,url \
  --limit 100)
```

### Step 2: Extract Linear Ticket IDs from PRs

Use two methods:

**Method 1: Branch naming convention**
```bash
# Extract TEAM-123 from branch name
for pr in $(echo "$open_prs" | jq -c '.[]'); do
  branch=$(echo "$pr" | jq -r '.headRefName')

  if [[ "$branch" =~ ([A-Z]+-[0-9]+) ]]; then
    ticket_id="${BASH_REMATCH[1]}"
    echo "$ticket_id,$pr_number" >> /tmp/pr-ticket-map.csv
  fi
done
```

**Method 2: Check Linear for PR attachments**
```bash
# Query Linear for issues with PR attachments
issues_with_prs=$(linearis issues list \
  --team "$TEAM_KEY" \
  --with-attachments \
  --json)

# Parse attachments for GitHub PR URLs
# (linearis returns attachment URLs in issue JSON)
```

### Step 3: Spawn PR Correlator Agent

Use Task tool with pr-correlator agent:

**Agent Input**:
- Open PRs JSON
- Merged PRs JSON
- Linear issues with cycle assignment
- PR-ticket mapping

**Agent Analysis**:
1. Match PRs to Linear issues (by branch name, PR description, attachments)
2. Identify orphaned PRs (no Linear issue)
3. Identify orphaned issues (no PR, status = "In Review" or "In Progress")
4. Flag stale PRs (open >14 days)
5. Flag merge candidates (PR merged, Linear issue still open)

### Step 4: Generate Correlation Report

```markdown
# PR-Linear Sync Report

**Generated**: 2025-01-27
**Repository**: user/repo
**Linear Team**: TEAM

## 📊 Summary

- Open PRs: 12 (8 linked, 4 orphaned)
- Merged PRs (7d): 15 (13 linked, 2 orphaned)
- Linear issues in review: 10 (8 with PRs, 2 without)

## 🔗 Linked PRs (Healthy)

| PR | Linear Issue | Status | Author |
|----|--------------|--------|--------|
| #123 | TEAM-456 | Open | Alice |
| #124 | TEAM-457 | Merged | Bob |

## ⚠️ Orphaned PRs (No Linear Issue)

| PR | Title | Branch | Author | Action |
|----|-------|--------|--------|--------|
| #125 | "Fix bug" | fix-bug | Alice | Create Linear issue or link existing |
| #126 | "Update docs" | docs-update | Bob | Create Linear issue or link existing |

**Recommended Actions**:
```bash
# Create Linear issue for PR #125
linearis issues create \
  --team TEAM \
  --title "Fix bug (from PR #125)" \
  --description "Imported from PR: https://github.com/user/repo/pull/125"

# Or manually link in Linear UI
```

## 🏷️ Orphaned Issues (No PR)

| Issue | Title | Status | Assignee | Action |
|-------|-------|--------|----------|--------|
| TEAM-789 | "Implement feature" | In Progress | Alice | Create PR or update status |
| TEAM-790 | "Refactor code" | In Review | Bob | PR might exist with different branch name |

## ✅ Ready to Close (PR merged, issue open)

| Issue | PR | Merged | Action |
|-------|----|--------|--------|
| TEAM-456 | #123 | 2025-01-25 | Close issue |
| TEAM-457 | #124 | 2025-01-26 | Close issue |

**Auto-close commands**:
```bash
linearis issues update TEAM-456 --status "Done" \
  --comment "PR #123 merged: https://github.com/user/repo/pull/123"

linearis issues update TEAM-457 --status "Done" \
  --comment "PR #124 merged: https://github.com/user/repo/pull/124"
```

## 🕐 Stale PRs (Open >14 days)

| PR | Issue | Days Open | Author | Action |
|----|-------|-----------|--------|--------|
| #120 | TEAM-450 | 18 days | Alice | Review and merge or close |
```

### Step 5: Save Report

Save to `thoughts/shared/reports/pr-sync/YYYY-MM-DD-pr-sync.md`

### Step 6: Display Summary

```
🔗 PR-Linear Sync Report

Health Score: 75/100
  ✅ 8 properly linked PRs
  ⚠️ 4 orphaned PRs need Linear issues
  ⚠️ 2 orphaned issues need PRs
  ✅ 2 ready to close

Actions available:
  1. Auto-close merged issues (generates commands)
  2. Create Linear issues for orphaned PRs
  3. View full report

Full report: thoughts/shared/reports/pr-sync/2025-01-27-pr-sync.md
```

## Success Criteria

### Automated Verification:
- [ ] GitHub PR data fetched successfully
- [ ] Linear issue data fetched successfully
- [ ] PR-ticket correlation logic executes
- [ ] Report generated with all sections
- [ ] Auto-close commands are valid

### Manual Verification:
- [ ] PR-issue matches are accurate
- [ ] Orphaned detection has minimal false positives
- [ ] Branch name extraction works correctly
- [ ] Recommendations are actionable
- [ ] Report provides clear next steps
