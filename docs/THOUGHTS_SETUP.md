# Thoughts System Setup Guide

The thoughts system is the backbone of Catalyst workflows, providing persistent, git-backed context across sessions.

## Quick Setup

```bash
# 1. Initialize for your project
./scripts/humanlayer/init-project.sh . acme-corp

# 2. Verify structure created
ls -la thoughts/shared/

# 3. Sync with HumanLayer
humanlayer thoughts sync
```

## What Gets Stored

| Document Type | Location | Created By |
|--------------|----------|------------|
| Research | `thoughts/shared/research/` | `/research-codebase` |
| Plans | `thoughts/shared/plans/` | `/create-plan` |
| Handoffs | `thoughts/shared/handoffs/` | `/create-handoff` |
| PR Descriptions | `thoughts/shared/prs/` | `/describe-pr` |
| Cycle Reports | `thoughts/shared/reports/cycles/` | `/pm:analyze-cycle` |
| Milestone Reports | `thoughts/shared/reports/milestones/` | `/pm:analyze-milestone` |
| Daily Reports | `thoughts/shared/reports/daily/` | `/pm:report-daily` |
| Backlog Reports | `thoughts/shared/reports/backlog/` | `/pm:groom-backlog` |
| PR Sync Reports | `thoughts/shared/reports/pr-sync/` | `/pm:sync-prs` |

## Why Required?

Unlike optional fallbacks, Catalyst **requires** thoughts because:

1. **Workflow chaining**: Commands chain together (research → plan → implement)
2. **Auto-discovery**: Commands auto-find recent documents via workflow context
3. **Team collaboration**: Team members need shared context
4. **Worktree sharing**: Multiple feature branches need shared memory

Without thoughts, the workflow breaks.

## Troubleshooting

### Error: "Thoughts system not configured"

This error occurs when `thoughts/shared/` directory doesn't exist.

**Solution**:
```bash
./scripts/humanlayer/init-project.sh . {your-project-name}
```

### Warning: "Not a git repo"

The thoughts directory exists but isn't git-backed. This works but limits team collaboration.

**Solution**:
```bash
cd thoughts/shared
git init
git add .
git commit -m "Initialize thoughts"
```

### Sync Issues

If HumanLayer sync fails:

```bash
# Check current configuration
humanlayer thoughts status

# Sync with verbose output for debugging
humanlayer thoughts sync --verbose

# Verify config name is set
cat .claude/config.json | jq '.thoughts.configName'
```

## Best Practices

1. **Sync regularly**: Run `humanlayer thoughts sync` after important sessions
2. **Use descriptive names**: `2025-10-27-PROJ-123-auth-implementation.md`
3. **Include ticket IDs**: Links documents to Linear issues
4. **Review before sync**: Check what changed with `humanlayer thoughts status`

## Directory Structure

```
thoughts/shared/
├── research/          # Research documents
├── plans/             # Implementation plans
├── handoffs/          # Session handoffs
│   ├── general/       # Handoffs without tickets
│   └── PROJ-XXX/      # Handoffs for ticket PROJ-XXX
├── prs/               # PR descriptions
└── reports/           # PM reports
    ├── cycles/        # Cycle analysis reports
    ├── milestones/    # Milestone progress reports
    ├── daily/         # Daily standup reports
    ├── backlog/       # Backlog grooming reports
    └── pr-sync/       # PR-Linear sync reports
```

## Advanced Configuration

### Per-Project Thoughts

If you work on multiple projects, each can have its own thoughts repository:

```json
// .claude/config.json
{
  "projectKey": "acme",
  "thoughts": {
    "configName": "acme"  // Points to HumanLayer config named "acme"
  }
}
```

Then configure HumanLayer:
```bash
humanlayer config add --name acme --repo ~/thoughts/repos/acme
```

### Sharing Across Worktrees

Thoughts are automatically shared across worktrees:

```bash
# Main branch
cd ~/code/project-main
ls thoughts/shared/plans/

# Feature branch (worktree)
cd ~/wt/project/feature-branch
ls thoughts/shared/plans/  # Same content!
```

This is achieved via symlinks created by `/create-worktree`.

## Validation

Commands automatically validate the thoughts system before execution:

```bash
# Manual validation
./scripts/validate-thoughts-setup.sh

# Check if thoughts directory exists
[[ -d "thoughts/shared" ]] && echo "✅ Thoughts configured"

# Verify subdirectories
ls thoughts/shared/
```

Expected output:
```
thoughts/shared/
├── research/
├── plans/
├── handoffs/
├── prs/
└── reports/
```

## Migration from Legacy Paths

If you have documents in legacy locations (e.g., `research/` instead of `thoughts/shared/research/`):

```bash
# Move documents to thoughts
mkdir -p thoughts/shared/research
mv research/*.md thoughts/shared/research/

# Update workflow context
./.claude/plugins/dev/scripts/workflow-context.sh add research \
  "thoughts/shared/research/2025-10-27-doc.md" "PROJ-123"
```

## Integration with HumanLayer

HumanLayer provides:
- **Git-backed storage**: Thoughts are versioned
- **Multi-machine sync**: Work from anywhere
- **Team collaboration**: Share context with team

Setup:
```bash
# Install HumanLayer CLI
npm install -g humanlayer

# Configure for your project
humanlayer config add --name my-project --repo ~/thoughts/repos/my-project

# Sync thoughts
humanlayer thoughts sync
```

## See Also

- [Configuration Guide](CONFIGURATION.md) - Project config setup
- [Multi-Config Guide](MULTI_CONFIG_GUIDE.md) - Working across multiple clients
- [CLAUDE.md](../CLAUDE.md) - Three-layer memory architecture
