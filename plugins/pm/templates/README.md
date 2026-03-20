# Catalyst PM - Report Templates & Examples

This directory contains templates and examples for the Catalyst PM plugin's automated reporting system.

## 📁 Directory Structure

```
templates/
├── config.yml.example          # Configuration template for users
├── reports/                    # Example report layouts
│   ├── DAILY_EXAMPLE.md        # Daily standup format
│   ├── WEEKLY_EXAMPLE.md       # Weekly executive summary
│   ├── CYCLE_EXAMPLE.md        # Bi-weekly cycle review
│   ├── MONTHLY_EXAMPLE.md      # Monthly roadmap review
│   └── DASHBOARD_EXAMPLE.md    # Auto-updating dashboard
├── github-actions/             # (Coming soon) Workflow templates
│   ├── setup.sh                # Installer script
│   ├── daily-report.yml.template
│   ├── weekly-summary.yml.template
│   ├── cycle-review.yml.template
│   └── monthly-roadmap.yml.template
└── README.md                   # This file
```

## 🎯 Report Types Overview

### Daily Standup (`DAILY_EXAMPLE.md`)

**Purpose**: Quick team status for daily standups
**Frequency**: Every weekday
**Runtime**: < 30 seconds to read
**Audience**: Team members

**Includes**:
- ✅ What shipped yesterday
- 🔄 Current work in progress (by developer)
- 👥 Who needs work assigned
- ⚠️ Quick blockers and risks
- 📊 Quick stats and velocity tracking

**UX Highlights**:
- Scannable tables with clear status indicators
- Collapsible sections for details
- Color-coded health status (🟢🟡🔴)
- Direct links to Linear issues

---

### Weekly Summary (`WEEKLY_EXAMPLE.md`)

**Purpose**: Comprehensive executive summary for leadership
**Frequency**: Every Monday
**Runtime**: 2-3 minutes to read
**Audience**: Leadership, stakeholders

**Includes**:
- 🟢🟡🔴 Team health score with breakdown
- 📊 By the numbers (code, PRs, Linear issues)
- 💻 Code changes breakdown by type
- 🎯 What was delivered (grouped by project)
- 🧠 Context engineering adoption analysis
- 🎯 Key takeaways and next steps
- 📈 Trend analysis (week-over-week)

**UX Highlights**:
- TL;DR section at top (30-second read)
- Health scores with visual indicators
- Project-grouped deliveries (not issue lists)
- User value explanations for each project
- Actionable recommendations with owners
- Trend visualizations (ASCII charts)

---

### Cycle Review (`CYCLE_EXAMPLE.md`)

**Purpose**: Bi-weekly sprint/cycle health assessment
**Frequency**: End of each Linear cycle (typically Fridays)
**Runtime**: 3-5 minutes to read
**Audience**: Team, product managers

**Includes**:
- 🟡🟢🔴 Cycle health with confidence score
- 📊 Progress overview and burndown
- 👥 Team capacity analysis
- ⚠️ Risks and blockers (prioritized)
- 💡 Recommendations with priority ordering
- 📈 Velocity and burndown charts
- 🎯 Success criteria tracking
- 📅 Next cycle preview

**UX Highlights**:
- Health assessment with scoring breakdown
- Progress bars (ASCII art for GitHub)
- Prioritized recommendations (P1, P2, P3, P4)
- Specific actions with owners and deadlines
- Burndown visualization
- Capacity heatmap (who's overloaded)

---

### Monthly Roadmap (`MONTHLY_EXAMPLE.md`)

**Purpose**: Quarterly strategic milestone tracking
**Frequency**: 1st of each month
**Runtime**: 5-7 minutes to read
**Audience**: Leadership, executives

**Includes**:
- 🎯 Quarter at a glance (all milestones)
- 📊 Milestone deep dives (each major project)
- 💡 Strategic recommendations
- 📈 Velocity and resource trends
- 🗓️ Q2 preview (upcoming milestones)

**UX Highlights**:
- Executive summary table (scan in 30 seconds)
- Per-milestone health with projection
- Confidence levels (HIGH/MEDIUM/LOW)
- Options analysis for at-risk milestones
- Resource utilization tracking
- Timeline visualizations

---

### Dashboard (`DASHBOARD_EXAMPLE.md`)

**Purpose**: Central hub auto-updated by all reports
**Frequency**: Updated daily, weekly, cycle, monthly
**Runtime**: Quick reference (always up-to-date)
**Audience**: Everyone

**Includes**:
- 🎯 Quick status (current health, cycle progress)
- 🚨 Immediate attention items (top 3 priorities)
- 📈 Health breakdown
- 👥 Team capacity snapshot
- 📊 This week's highlights
- 🗓️ Roadmap health summary
- 📅 Links to all recent reports
- 🔗 Quick links to tools (Linear, GitHub, docs)

**UX Highlights**:
- Always current (updated by workflows)
- Quick scan (< 30 seconds)
- Top priorities front and center
- Direct links to full reports
- Useful commands reference
- Tool integrations

---

## 🎨 UX Design Principles

All report templates follow these design principles:

### 1. Scannable First

- **TL;DR** sections at the top
- **Tables** for structured data
- **Visual indicators** (🟢🟡🔴) for health
- **Collapsible sections** (`<details>`) for drill-down
- **Bold names** and **key metrics** for easy scanning

### 2. Action-Oriented

- Every report ends with **specific next steps**
- Recommendations have **owners, deadlines, impact**
- **Priority ordering** (P1 > P2 > P3 > P4)
- **No analysis without action** - insights lead to decisions

### 3. Data-Backed

- Every claim has **specific numbers**
- Trends show **comparison vs previous period**
- Links to **source data** (Linear issues, GitHub PRs)
- **Confidence levels** for projections

### 4. User-Centric

- **Project-grouped** deliveries (not ticket lists)
- **User value** explained for each feature
- **Business impact** highlighted
- **Human-readable** (not just metrics)

### 5. Progressive Disclosure

- **Quick read** versions (TL;DR, summaries)
- **Drill-down** for details (collapsible sections)
- **Links** to supporting documents
- **Multiple entry points** (dashboard → reports → data)

---

## 🚀 Using These Templates

### For Users (Installing in Your Thoughts Repo)

1. **Download the setup script** (coming soon):
   ```bash
   curl -o setup-catalyst-pm.sh \
     https://raw.githubusercontent.com/coalesce-labs/catalyst/main/plugins/pm/templates/github-actions/setup.sh
   chmod +x setup-catalyst-pm.sh
   ./setup-catalyst-pm.sh
   ```

2. **Configure your project**:
   - Edit `.catalyst/config.yml`
   - Set your org, repos, Linear team
   - Adjust schedules

3. **Run setup again** to generate workflows:
   ```bash
   ./setup-catalyst-pm.sh
   ```

4. **Add secrets** to GitHub repo settings

5. **Commit and push**

### For Developers (Extending These Templates)

These templates are **guidelines and examples**. When implementing actual report generation:

1. **Use the structure** from these examples
2. **Adapt sections** to your team's needs
3. **Keep the UX principles** (scannable, action-oriented, data-backed)
4. **Generate programmatically** from actual data sources

Example: The daily report template shows the ideal format. Your `generate-daily-report.sh` script should:
- Collect data from GitHub/Linear/thoughts
- Format according to the template structure
- Output markdown matching the example

---

## 📊 Report Metrics Reference

### Health Score Components

**Team Health (0-100)**:
- **Velocity** (0-40 pts): Progress vs time, adjusted for PTO
- **Quality** (0-30 pts): Test coverage, PR review quality, cycle time
- **Collaboration** (0-30 pts): Context eng. adoption, work distribution, code reviews

**Thresholds**:
- 🟢 80-100: Excellent/Healthy
- 🟡 60-79: Good/At Risk
- 🔴 0-59: Fair/Critical

### Issue Age Thresholds

- **At Risk**: In progress > 5 days
- **Stale**: No activity > 30 days
- **Blocked**: Has blocking dependency

### Velocity Metrics

- **Story points per day**: Total points / business days
- **Issues per day**: Completed issues / business days
- **PR cycle time**: Merge date - creation date (avg)

---

## 🔗 Related Documentation

- **[Plugin README](../README.md)** - Overview of PM plugin
- **[Documentation Site](https://catalyst.coalescelabs.ai)** - Setup and configuration

---

## 💡 Tips for Great Reports

1. **Keep it fresh** - Reports older than 1 week lose value
2. **Make it actionable** - Every insight should lead to a decision
3. **Show trends** - Point-in-time is less valuable than week-over-week
4. **Highlight people** - Bold developer names for recognition
5. **Link everything** - Direct links to Linear issues, GitHub PRs, docs
6. **Explain why** - Don't just show metrics, explain what they mean
7. **Be specific** - "Unblock TEAM-512" not "resolve blockers"
8. **Own it** - Every recommendation has an owner and deadline

---

## 📝 Customization Guide

Want to adapt these templates for your team? Here are common customizations:

### Add Custom Sections

Add sections relevant to your workflow:
- **Security vulnerabilities** (if using Snyk/Dependabot)
- **Production incidents** (if tracking in PagerDuty)
- **Customer feedback** (if integrated with support tools)
- **Deploy frequency** (if tracking deployments)

### Adjust Thresholds

Modify health score thresholds in `config.yml`:
```yaml
reports:
  healthScore:
    excellent: 85    # Change from default 80
    good: 65         # Change from default 60
```

### Change Frequency

Adjust schedules in `config.yml`:
```yaml
schedules:
  daily:
    cron: "0 14 * * 1-5"    # 2 PM UTC instead of 9 AM
  cycle:
    cron: "0 9 * * THU"     # Thursday instead of Friday
```

### Rename Sections

Edit the report generation scripts to rename sections:
- "Shipped" → "Delivered"
- "In Progress" → "Active Work"
- "Blockers" → "Impediments"

---

## 🎯 Success Metrics

A successful reporting system has:

- ✅ **High consumption rate** - Team actually reads reports
- ✅ **Action taken** - Recommendations lead to changes
- ✅ **Time savings** - Automation reduces manual status checks
- ✅ **Early warning** - Problems surfaced before they're critical
- ✅ **Team alignment** - Everyone sees the same picture

Measure these:
- Report views (GitHub repo insights)
- Action items completed (Linear status changes)
- Time saved (manual reporting time before vs after)
- Issues caught early (blockers < 3 days)

---

*Generated by Catalyst PM Plugin • [Report Issues](https://github.com/coalesce-labs/catalyst/issues)*
