# PM Plugin - Complete Implementation Guide

## Executive Summary

**Status**: 80% Complete
**Your Requirements**: Daily, weekly (executive summary), and roadmap reporting with GitHub Actions automation
**Existing**: Daily + cycle/milestone reports
**Missing**: Executive summary command, roadmap review command, GitHub Actions, dashboard updates

## What Already Exists

### Agents (12 total)

**Data Collection (Haiku - Fast)**:
1. ✅ `github-metrics` - Collects PR/commit data
2. ✅ `linear-metrics` - Collects issue/cycle data
3. ✅ `thoughts-metrics` - Collects thoughts repo commits
4. ✅ `code-classifier` - Classifies code by type
5. ✅ `calendar-analyzer` - Analyzes PTO from Google Calendar
6. ✅ `linear-research` - Natural language Linear queries

**Analysis (Sonnet - High Quality)**:
7. ✅ `health-scorer` - Calculates health scores
8. ✅ `cycle-analyzer` - Analyzes cycle health
9. ✅ `milestone-analyzer` - Tracks milestone progress
10. ✅ `backlog-analyzer` - Analyzes backlog health
11. ✅ `github-linear-analyzer` - PR-issue correlation

### Commands (5 existing, 2 needed)

**✅ Existing**:
1. `/pm:report-daily` - Daily standup report
2. `/pm:analyze-cycle` - Cycle health report
3. `/pm:analyze-milestone` - Milestone progress
4. `/pm:groom-backlog` - Backlog grooming
5. `/pm:sync-prs` - GitHub-Linear correlation

**🚧 Needed**:
6. `/pm:executive-summary` - 14-day comprehensive review (YOUR DRAFT)
7. `/pm:roadmap-review` - Quarterly roadmap planning

## What We Need to Build

### 1. Executive Summary Command

**File**: `plugins/pm/commands/executive_summary.md`

**Purpose**: Your comprehensive 14-day review with health scoring, velocity trends, and context engineering analysis.

**Architecture**:
```
User invokes: /pm:executive-summary

Step 1: Spawn 5 parallel data collection agents (Haiku)
  ├─ github-metrics → PR/commit data
  ├─ linear-metrics → Issue/cycle data
  ├─ thoughts-metrics → Context engineering
  ├─ code-classifier → Code type breakdown
  └─ calendar-analyzer → PTO impact

Step 2: Wait for all agents to complete

Step 3: Spawn health-scorer (Sonnet) → Synthesize all data

Step 4: Generate executive summary report
  ├─ TL;DR section
  ├─ Health score (🟢🟡🔴)
  ├─ By The Numbers
  ├─ Code Changes Breakdown
  ├─ What Was Delivered (by project)
  ├─ Context Engineering Adoption
  └─ Key Takeaways & Next Steps

Step 5: Save to thoughts/shared/status/weekly/YYYY-MM-DD-summary.md

Step 6: Update dashboard
```

### 2. Roadmap Review Command

**File**: `plugins/pm/commands/roadmap_review.md`

**Purpose**: Quarterly milestone tracking with target date feasibility.

**Architecture**:
```
User invokes: /pm:roadmap-review

Step 1: Spawn parallel data collection (Haiku)
  ├─ linear-metrics → All milestones
  ├─ linear-research → Historical velocity
  └─ calendar-analyzer → Upcoming PTO impact

Step 2: Spawn milestone-tracker (Sonnet) → Analyze each milestone

Step 3: Generate roadmap report
  ├─ Milestone health (🟢🟡🔴 for each)
  ├─ Target date feasibility
  ├─ Risk analysis
  └─ Strategic recommendations

Step 4: Save to thoughts/shared/status/roadmap/YYYY-QQ-roadmap.md
```

### 3. Thoughts Repository Structure

**Create in your thoughts repo**:

```
~/thoughts/repos/{project}/
└── shared/
    ├── status/                      # NEW: Status reports directory
    │   ├── daily/                   # Daily standups
    │   │   ├── 2025-01-15.md
    │   │   └── 2025-01-16.md
    │   ├── weekly/                  # Executive summaries
    │   │   ├─ 2025-01-15-summary.md
    │   │   └── 2025-01-29-summary.md
    │   ├── cycle/                   # Bi-weekly cycle reviews
    │   │   ├── 2025-01-15-cycle-5.md
    │   │   └── 2025-01-29-cycle-6.md
    │   └── roadmap/                 # Quarterly roadmap reviews
    │       ├── 2025-Q1-roadmap.md
    │       └── 2025-Q2-roadmap.md
    ├── dashboards/
    │   └── README.md                # Auto-updated dashboard
    ├── research/
    ├── plans/
    └── ... (existing directories)
```

### 4. GitHub Actions Workflows

**Challenge**: Reports run FROM thoughts repo, but need access TO code repos.

**Solution**: Multi-repo access via fine-grained PAT.

**Setup**:

1. **In thoughts repository**, create `.github/workflows/`
2. Add secrets to thoughts repo settings:
   - `LINEAR_API_TOKEN`
   - `CODE_REPO_ACCESS_TOKEN` (fine-grained PAT with access to code repos)
   - `GOOGLE_SERVICE_ACCOUNT` (for calendar)

3. Create three workflows:

#### A. Daily Report Workflow

**File**: `thoughts-repo/.github/workflows/daily-report.yml`

```yaml
name: Daily Team Report

on:
  schedule:
    - cron: '0 9 * * 1-5'  # Weekdays at 9 AM UTC
  workflow_dispatch:

jobs:
  daily-report:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout thoughts repo
        uses: actions/checkout@v4

      - name: Checkout code repo (for GitHub metrics)
        uses: actions/checkout@v4
        with:
          repository: acme-corp/main-repo
          path: code-repo
          token: ${{ secrets.CODE_REPO_ACCESS_TOKEN }}

      - name: Install tools
        run: |
          sudo apt-get install -y jq
          npm install -g @linear/cli
          gh auth login --with-token <<< "${{ secrets.CODE_REPO_ACCESS_TOKEN }}"

      - name: Configure Linear
        run: |
          linear auth --token ${{ secrets.LINEAR_API_TOKEN }}

      - name: Collect GitHub metrics
        working-directory: code-repo
        run: |
          # Use gh CLI to collect PR/commit data
          gh pr list --state merged --search "merged:>=$(date -d yesterday +%Y-%m-%d)" \
            --json number,title,author,mergedAt,additions,deletions > /tmp/github-prs.json

      - name: Collect Linear metrics
        run: |
          # Use linearis to collect issue data
          linearis issues search "completed:>=$(date -d yesterday +%Y-%m-%d)" \
            --team ACME --format json > /tmp/linear-issues.json

      - name: Generate report
        run: |
          # TODO: Call /pm:report-daily via Claude Code API
          # For now, use shell script to generate basic report
          ./scripts/pm/generate-daily-report.sh \
            /tmp/github-prs.json \
            /tmp/linear-issues.json \
            > shared/status/daily/$(date +%Y-%m-%d).md

      - name: Update dashboard
        run: |
          ./scripts/pm/update-dashboard.sh

      - name: Commit and push
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add shared/status/daily/ shared/dashboards/
          git commit -m "Daily report: $(date +%Y-%m-%d)" || echo "No changes"
          git push
```

#### B. Weekly Executive Summary Workflow

**File**: `thoughts-repo/.github/workflows/executive-summary.yml`

```yaml
name: Executive Summary Report

on:
  schedule:
    - cron: '0 9 * * MON'  # Every Monday at 9 AM UTC
  workflow_dispatch:
    inputs:
      period_days:
        description: 'Reporting period (days)'
        default: '14'

jobs:
  executive-summary:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout thoughts repo
        uses: actions/checkout@v4

      - name: Checkout code repos
        uses: actions/checkout@v4
        with:
          repository: acme-corp/main-repo
          path: code-repo
          token: ${{ secrets.CODE_REPO_ACCESS_TOKEN }}

      - name: Install tools
        run: |
          sudo apt-get install -y jq
          npm install -g @linear/cli
          pip install gcalcli

      - name: Collect all metrics
        run: |
          PERIOD="${{ github.event.inputs.period_days || '14' }}"
          START_DATE=$(date -d "$PERIOD days ago" +%Y-%m-%d)
          END_DATE=$(date +%Y-%m-%d)

          # GitHub metrics
          cd code-repo
          gh pr list --state merged --search "merged:>=$START_DATE" \
            --json number,title,author,mergedAt,additions,deletions,files \
            > /tmp/github-metrics.json

          # Linear metrics
          cd ..
          linearis issues search "completed:>=$START_DATE" \
            --team ACME --format json > /tmp/linear-metrics.json

          # Thoughts metrics
          git log --since="$START_DATE" --until="$END_DATE" \
            --pretty=format:'%H|%an|%ai' --numstat \
            > /tmp/thoughts-commits.txt

      - name: Generate executive summary
        run: |
          # TODO: Call /pm:executive-summary via Claude Code API
          ./scripts/pm/generate-executive-summary.sh \
            /tmp/github-metrics.json \
            /tmp/linear-metrics.json \
            /tmp/thoughts-commits.txt \
            > shared/status/weekly/$(date +%Y-%m-%d)-summary.md

      - name: Update dashboard
        run: |
          ./scripts/pm/update-dashboard.sh

      - name: Commit and push
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add shared/status/weekly/ shared/dashboards/
          git commit -m "Executive summary: $(date +%Y-%m-%d)" || echo "No changes"
          git push
```

#### C. Quarterly Roadmap Review Workflow

**File**: `thoughts-repo/.github/workflows/roadmap-review.yml`

```yaml
name: Quarterly Roadmap Review

on:
  schedule:
    - cron: '0 9 1 */3 *'  # First day of quarter at 9 AM
  workflow_dispatch:

jobs:
  roadmap-review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout thoughts repo
        uses: actions/checkout@v4

      - name: Install tools
        run: |
          sudo apt-get install -y jq
          npm install -g @linear/cli
          pip install gcalcli

      - name: Collect milestone data
        run: |
          # Get all active milestones/projects
          linearis projects list --team ACME --format json > /tmp/milestones.json

          # Get historical velocity
          linearis cycles list --team ACME --format json > /tmp/cycles.json

      - name: Generate roadmap review
        run: |
          # TODO: Call /pm:roadmap-review via Claude Code API
          ./scripts/pm/generate-roadmap-review.sh \
            /tmp/milestones.json \
            /tmp/cycles.json \
            > shared/status/roadmap/$(date +%Y-Q%q)-roadmap.md

      - name: Commit and push
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add shared/status/roadmap/
          git commit -m "Roadmap review: Q$(date +%q) $(date +%Y)" || echo "No changes"
          git push
```

### 5. Dashboard Update Script

**File**: `plugins/pm/scripts/update-dashboard.sh`

```bash
#!/usr/bin/env bash
# Update dashboard with latest report data

set -e

# Paths
DASHBOARD="shared/dashboards/README.md"
LATEST_DAILY=$(ls -t shared/status/daily/*.md 2>/dev/null | head -1)
LATEST_WEEKLY=$(ls -t shared/status/weekly/*.md 2>/dev/null | head -1)
LATEST_CYCLE=$(ls -t shared/status/cycle/*.md 2>/dev/null | head -1)
LATEST_ROADMAP=$(ls -t shared/status/roadmap/*.md 2>/dev/null | head -1)

# Extract health score from latest weekly report
if [ -f "$LATEST_WEEKLY" ]; then
  HEALTH_SCORE=$(grep -oP 'Health.*?(\d+)/100' "$LATEST_WEEKLY" | grep -oP '\d+' | head -1)
  HEALTH_STATUS=$(grep -oP '(🟢|🟡|🔴)' "$LATEST_WEEKLY" | head -1)
else
  HEALTH_SCORE="N/A"
  HEALTH_STATUS="⚪"
fi

# Extract current cycle from Linear
CYCLE_NAME=$(linearis cycles list --team "$TEAM_KEY" --format json | jq -r '.[0].name')

# Generate dashboard
cat > "$DASHBOARD" << EOF
# Team Dashboard

**Last Updated**: $(date '+%Y-%m-%d %H:%M %Z')
**Health**: $HEALTH_STATUS $HEALTH_SCORE/100
**Cycle**: $CYCLE_NAME

## Quick Status

$(if [ -f "$LATEST_DAILY" ]; then
  grep -A 4 "## Quick Status" "$LATEST_DAILY" | tail -n +2
else
  echo "No daily report available"
fi)

## Health Breakdown

| Category | Score | Status |
|----------|-------|--------|
$(if [ -f "$LATEST_WEEKLY" ]; then
  grep -A 5 "## Health Breakdown" "$LATEST_WEEKLY" | grep "|" | tail -n +2
else
  echo "| N/A | N/A | N/A |"
fi)

## Recent Reports

$(if [ -f "$LATEST_DAILY" ]; then echo "- [Daily - $(basename "$LATEST_DAILY" .md)](../status/daily/$(basename "$LATEST_DAILY"))"; fi)
$(if [ -f "$LATEST_WEEKLY" ]; then echo "- [Weekly Summary - $(basename "$LATEST_WEEKLY" .md)](../status/weekly/$(basename "$LATEST_WEEKLY"))"; fi)
$(if [ -f "$LATEST_CYCLE" ]; then echo "- [Cycle Review - $(basename "$LATEST_CYCLE" .md)](../status/cycle/$(basename "$LATEST_CYCLE"))"; fi)
$(if [ -f "$LATEST_ROADMAP" ]; then echo "- [Roadmap - $(basename "$LATEST_ROADMAP" .md)](../status/roadmap/$(basename "$LATEST_ROADMAP"))"; fi)

## Top Priorities

$(if [ -f "$LATEST_WEEKLY" ]; then
  grep -A 10 "## Recommendations" "$LATEST_WEEKLY" | grep "^[0-9]" | head -3
else
  echo "No priorities available"
fi)

## Links

- [Linear Team](https://linear.app/$ORG/team/$TEAM_KEY)
- [GitHub Repositories](https://github.com/$ORG)
$(if [ -f "$LATEST_ROADMAP" ]; then echo "- [Full Roadmap](../status/roadmap/$(basename "$LATEST_ROADMAP"))"; fi)

---

*Auto-generated by Catalyst PM Plugin*
EOF

echo "✅ Dashboard updated: $DASHBOARD"
```

## Implementation Steps

### Phase 1: Complete the Commands (Week 1)

1. **Create `executive_summary.md` command**:
   - Use your draft as foundation
   - Spawn 5 parallel agents (github-metrics, linear-metrics, thoughts-metrics, code-classifier, calendar-analyzer)
   - Use health-scorer for synthesis
   - Save to `shared/status/weekly/`

2. **Create `roadmap_review.md` command**:
   - Spawn parallel agents for milestone data
   - Use milestone-tracker for analysis
   - Generate quarterly roadmap
   - Save to `shared/status/roadmap/`

3. **Test commands locally**:
   ```bash
   /pm:executive-summary
   /pm:roadmap-review
   ```

### Phase 2: Setup Thoughts Repo Structure (Week 1)

1. **In your thoughts repo**, create directories:
   ```bash
   mkdir -p shared/status/{daily,weekly,cycle,roadmap}
   mkdir -p shared/dashboards
   ```

2. **Create initial dashboard**:
   ```bash
   touch shared/dashboards/README.md
   ```

3. **Commit structure**:
   ```bash
   git add shared/status shared/dashboards
   git commit -m "Add status reporting structure"
   git push
   ```

### Phase 3: GitHub Actions Setup (Week 2)

1. **In thoughts repo**, create workflows directory:
   ```bash
   mkdir -p .github/workflows
   ```

2. **Add secrets** to thoughts repo (Settings → Secrets):
   - `LINEAR_API_TOKEN`
   - `CODE_REPO_ACCESS_TOKEN`
   - `GOOGLE_SERVICE_ACCOUNT` (optional)

3. **Create workflow files**:
   - `.github/workflows/daily-report.yml`
   - `.github/workflows/executive-summary.yml`
   - `.github/workflows/roadmap-review.yml`

4. **Test workflows**:
   - Run manually via "Actions" tab
   - Verify reports generate correctly
   - Check dashboard updates

### Phase 4: Dashboard Automation (Week 2)

1. **Create `update-dashboard.sh` script**
2. **Integrate with workflows**
3. **Test dashboard updates**

## Key Decisions Made

### 1. Directory Naming: `status/` (not `check-in/` or `reports/`)

**Rationale**:
- ✅ Concise and clear
- ✅ Aligns with "status updates"
- ✅ Subdirectories by frequency (daily, weekly, cycle, roadmap)

**Alternative considered**: `reports/` - but this might conflict with other report types.

### 2. Workflows Run FROM Thoughts Repo

**Rationale**:
- ✅ Reports save to thoughts repo (natural location for workflows)
- ✅ Avoids committing reports to code repo
- ✅ Separates PM artifacts from code artifacts

**Challenges**:
- ❌ Needs multi-repo access (solved with fine-grained PAT)
- ❌ Can't easily invoke `/pm:` commands from GitHub Actions (requires Claude Code API)

**Workaround**: Shell scripts that collect data and generate reports using templates.

### 3. Google Calendar Integration: Optional

**Rationale**:
- ✅ Enhances capacity planning
- ✅ Adjusts velocity calculations for PTO
- ⚠️ Requires additional setup (gcalcli, service account)

**Implementation**: Start without calendar, add later.

## Next Steps for You

1. **Review this guide** and confirm the approach
2. **Choose which commands to implement first**:
   - Option A: Executive summary (your priority)
   - Option B: Roadmap review
   - Option C: Both in parallel

3. **Decide on GitHub Actions priority**:
   - Option A: Start with manual invocation, add automation later
   - Option B: Build automation from the start

4. **Confirm thoughts repo location** - where is your thoughts repo?
   - Path: `~/thoughts/repos/{project}` ?
   - Or different location?

Let me know your preferences and I'll generate the complete implementations!
