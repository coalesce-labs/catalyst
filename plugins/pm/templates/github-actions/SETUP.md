# Context Engineering GitHub Actions Setup

This guide walks you through setting up automated daily context engineering dashboards using GitHub Actions in your thoughts repository.

## What This Does

The Context Engineering Daily Dashboard:
- **Tracks adoption** of context engineering across your team
- **Identifies developers** with code activity but NO thoughts activity
- **Generates daily reports** automatically via GitHub Actions
- **Saves reports** to the root of your thoughts repository

## Prerequisites

1. **Thoughts repository on GitHub**
   - Your thoughts repo must be hosted on GitHub
   - GitHub Actions must be enabled

2. **Code repositories on GitHub**
   - The code repositories you want to analyze must be accessible
   - For private repos, you may need a GitHub Personal Access Token (PAT)

3. **Project configuration**
   - Know your project key (e.g., "myproject")
   - List of code repositories to analyze (e.g., "org/repo-1,org/repo-2")

## Quick Start

### Option 1: Automated Setup (Recommended)

Run the setup script from the Catalyst PM plugin:

```bash
# Navigate to the Catalyst PM templates directory
cd /path/to/catalyst/plugins/pm/templates/github-actions

# Run setup script
./setup.sh <thoughts-repo-path> <project-key> <code-repos>

# Example:
./setup.sh ~/thoughts/repos/myproject myproject "acme/api,acme/web,acme/mobile"
```

The script will:
1. Create `.github/workflows/` directory in your thoughts repo
2. Generate `context-daily.yml` with your configuration
3. Provide next steps for committing and enabling

### Option 2: Manual Setup

1. **Copy the template**:
   ```bash
   mkdir -p ~/thoughts/repos/myproject/.github/workflows
   cp context-daily.yml.template ~/thoughts/repos/myproject/.github/workflows/context-daily.yml
   ```

2. **Edit the workflow file** and replace placeholders:
   - `{{PROJECT_KEY}}` → your project key (e.g., "myproject")
   - `{{CODE_REPOS}}` → comma-separated repos (e.g., "org/repo-1,org/repo-2")

3. **Commit and push**:
   ```bash
   cd ~/thoughts/repos/myproject
   git add .github/workflows/context-daily.yml
   git commit -m "ci: add context engineering daily dashboard"
   git push
   ```

## Configuration

### Environment Variables

The workflow uses these environment variables (configured in the template):

```yaml
env:
  PROJECT_KEY: "myproject"           # Your project identifier
  CODE_REPOS: "org/repo-1,org/repo-2" # Code repos to analyze
  TZ: "America/Chicago"               # Timezone for report timestamps
```

### Schedule

By default, the workflow runs:
- **Daily at 9:15 AM Central Time** (14:15 UTC during CST)
- Adjust the cron schedule if needed:
  ```yaml
  schedule:
    - cron: '15 14 * * *'  # Minute Hour Day Month DayOfWeek
  ```

### Permissions

The workflow needs these permissions (already configured):
```yaml
permissions:
  contents: write        # To commit dashboard to repo
  pull-requests: read    # To read PR data
```

## GitHub Secrets (Optional)

For **private code repositories**, you may need to configure a Personal Access Token (PAT):

1. **Create a PAT** with `repo` scope:
   - Go to: https://github.com/settings/tokens
   - Generate new token (classic)
   - Select scope: `repo` (Full control of private repositories)
   - Copy the token

2. **Add secret to your thoughts repository**:
   - Go to: https://github.com/YOUR-ORG/YOUR-THOUGHTS-REPO/settings/secrets/actions
   - Click "New repository secret"
   - Name: `GH_PAT`
   - Value: [paste your PAT]

3. **Update workflow to use PAT**:
   ```yaml
   - name: Collect GitHub metrics
     env:
       GH_TOKEN: ${{ secrets.GH_PAT }}  # Use PAT instead of GITHUB_TOKEN
   ```

For **public repositories**, the default `GITHUB_TOKEN` is sufficient (no setup needed).

## Enabling GitHub Actions

After pushing the workflow:

1. Go to your thoughts repository on GitHub
2. Click the **Actions** tab
3. If prompted, click **"I understand my workflows, go ahead and enable them"**
4. You should see **"Context Engineering Daily Dashboard"** in the workflows list

## Testing the Workflow

### Manual Trigger

1. Go to: **Actions** → **Context Engineering Daily Dashboard**
2. Click **"Run workflow"** dropdown
3. Select branch (usually `main`)
4. Click **"Run workflow"** button

The workflow will run immediately and you can watch the live logs.

### Verify Output

After the workflow completes:

1. Check the root of your thoughts repo for: `context-engineering-daily.md`
2. The report should contain:
   - Quick stats (7-day window)
   - Developers NOT using context engineering (if any)
   - Thoughts contributors breakdown
   - Recommendations

## Report Location

The dashboard is saved to:
```
~/thoughts/repos/myproject/context-engineering-daily.md
```

**Why the root?** This report is ABOUT the thoughts repository itself, so it lives at the root level (not in `shared/status/` or other subdirectories).

## Troubleshooting

### Workflow Fails: "Resource not accessible by integration"

**Problem**: Insufficient permissions for GITHUB_TOKEN.

**Solution**:
1. Go to: **Settings** → **Actions** → **General**
2. Scroll to "Workflow permissions"
3. Select "Read and write permissions"
4. Save

### No Developers Found

**Problem**: GitHub API returns empty contributor lists.

**Possible causes**:
- Code repositories are private and PAT is not configured
- Repository names are incorrect
- No commits in the analysis window (last 7 days)

**Solution**:
- Verify repository names in `CODE_REPOS` variable
- For private repos, configure a PAT (see "GitHub Secrets" section)
- Check that there are recent commits in the code repos

### Report Not Committed

**Problem**: Workflow runs successfully but no commit appears.

**Possible causes**:
- Report unchanged (no new data)
- Git configuration issues

**Solution**:
- Check workflow logs for "No changes to commit" message
- Verify git user is configured (should be github-actions[bot])

### Wrong Timezone

**Problem**: Report timestamps show wrong timezone.

**Solution**:
- Edit `TZ` environment variable in workflow file:
  ```yaml
  env:
    TZ: "America/New_York"  # or your timezone
  ```
- Valid timezones: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones

## Advanced Configuration

### Multiple Code Repositories

To analyze many repositories, add them comma-separated:

```yaml
env:
  CODE_REPOS: "org/api,org/web,org/mobile,org/admin,org/analytics"
```

### Custom Cron Schedule

Examples:

```yaml
# Every weekday at 9 AM
- cron: '0 9 * * 1-5'

# Every Monday, Wednesday, Friday at 10 AM
- cron: '0 10 * * 1,3,5'

# Twice daily (9 AM and 5 PM)
- cron: '0 9,17 * * *'
```

### Notify on Failures

Add a notification step to alert on failures:

```yaml
- name: Notify on failure
  if: failure()
  uses: 8398a7/action-slack@v3
  with:
    status: ${{ job.status }}
    text: 'Context Engineering Dashboard failed'
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

## Integration with /catalyst-pm:context-daily

The GitHub Actions workflow is a **simplified version** of the full `/catalyst-pm:context-daily` command:

| Feature | GitHub Actions | /catalyst-pm:context-daily |
|---------|---------------|----------------------------|
| **Cross-repo analysis** | ✅ Yes | ✅ Yes |
| **Identifies non-adopters** | ✅ Yes | ✅ Yes |
| **File type breakdown** | ❌ Basic | ✅ Detailed (research/plans/handoffs/prs) |
| **Trend analysis** | ❌ No | ✅ Yes (28-day week-over-week) |
| **Individual scoring** | ❌ No | ✅ Yes (6-level adoption scale) |
| **Prioritized actions** | ✅ Basic | ✅ Detailed (P1/P2/P3) |
| **Runs** | Automated | Manual |

**Recommendation**: Use both!
- **GitHub Actions**: Automated daily monitoring
- **/catalyst-pm:context-daily**: Deep-dive analysis when needed

## Example Output

The generated dashboard looks like:

```markdown
# Context Engineering Adoption - Daily Dashboard

**Generated**: 2025-01-17 at 09:15 AM CST
**Project**: myproject
**Code Repos**: acme/api, acme/web

---

## 📊 Quick Stats (7-Day Window)

| Metric | Value |
|--------|-------|
| **Developers with code activity** | 7 |
| **Developers with thoughts activity** | 5 |
| **Adoption rate** | 71% |
| **🚨 NOT using context engineering** | 2 |

---

## 🚨 Not Using Context Engineering

**Developers with code activity but NO thoughts activity:**

| Developer | Status |
|-----------|--------|
| **frank** | 🔴 Not using |
| **grace** | 🔴 Not using |

**Recommended Action**: Schedule onboarding sessions to introduce context engineering workflow.

---

...
```

## Next Steps

After setting up the GitHub Actions workflow:

1. **Monitor daily reports** in your thoughts repo root
2. **Act on recommendations** (onboard developers not using context engineering)
3. **Track trends** over time to measure adoption improvement
4. **Share wins** with the team (celebrate increasing adoption rates)

## Support

- **Documentation**: See `plugins/pm/templates/README.md`
- **Issues**: Report bugs at https://github.com/coalesce-labs/catalyst/issues
- **Command help**: Run `/catalyst-pm:workflow-help` in Claude Code

---

*Catalyst PM Plugin • Context Engineering Tracking*
