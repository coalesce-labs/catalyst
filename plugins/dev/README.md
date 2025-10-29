# Catalyst Dev Plugin

Complete development workflow: research → plan → implement → validate → ship.

## Features

### Core Workflow Commands
- `/research-codebase` - Parallel research with specialized agents
- `/create-plan` - Interactive implementation planning
- `/implement-plan` - Execute plans with validation
- `/validate-plan` - Verify implementation completeness
- `/create-handoff` - Session handoffs with context
- `/resume-handoff` - Resume from handoffs

### Development Commands
- `/commit` - Conventional commits with Linear integration
- `/debug` - Investigate issues with logs and state
- `/create-pr` - Pull requests with auto-description
- `/describe-pr` - Generate/update PR descriptions
- `/merge-pr` - Safe merge with verification

### Project Management
- `/linear` - Ticket management and workflow
- `/create-worktree` - Isolated workspace creation

### Research Agents
- `codebase-locator` - Find files and patterns
- `codebase-analyzer` - Deep code analysis
- `codebase-pattern-finder` - Architectural patterns
- `thoughts-locator` - Search thoughts repository
- `thoughts-analyzer` - Analyze documentation
- `external-research` - External repository research

## Automatic Workflow Context Tracking

**New in v3.0**: Automatic tracking of thoughts documents via Claude Code hooks.

### What It Does

When you write or edit files in `thoughts/shared/`:
- ✅ Automatically updates `.claude/.workflow-context.json`
- ✅ Tracks document type (research, plans, handoffs, prs)
- ✅ Extracts ticket numbers from filenames
- ✅ Records timestamps
- ✅ Maintains most recent document reference

### How It Works

The plugin includes Claude Code hooks (`hooks.toml`) that:
1. Watch for Write/Edit tools on thoughts files
2. Trigger `hooks/update-workflow-context.sh` script
3. Update workflow context automatically
4. No manual tracking needed

### Tracked Document Types

- **Research**: `thoughts/shared/research/*`
- **Plans**: `thoughts/shared/plans/*`
- **Handoffs**: `thoughts/shared/handoffs/*`
- **PRs**: `thoughts/shared/prs/*`

### Ticket Extraction

Automatically extracts ticket numbers from:
- Filenames: `2025-10-28-PROJ-123-description.md` → `PROJ-123`
- Directories: `thoughts/shared/handoffs/PROJ-123/` → `PROJ-123`

### Workflow Context Structure

```json
{
  "lastUpdated": "2025-10-28T22:30:00Z",
  "currentTicket": "PROJ-123",
  "mostRecentDocument": {
    "type": "plans",
    "path": "thoughts/shared/plans/2025-10-28-PROJ-123-feature.md",
    "created": "2025-10-28T22:30:00Z",
    "ticket": "PROJ-123"
  },
  "workflow": {
    "research": [...],
    "plans": [...],
    "handoffs": [...],
    "prs": [...]
  }
}
```

### Commands That Use Workflow Context

- `/resume-handoff` - Auto-finds recent handoff
- `/create-plan` - References recent research
- `/implement-plan` - Finds associated plan
- `/validate-plan` - Verifies plan execution

### Manual Tracking (Fallback)

If hooks aren't working, you can manually update:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh add plans "path/to/plan.md" "PROJ-123"
```

## Installation

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
```

## Configuration

The plugin reads configuration from `.claude/config.json`:

```json
{
  "catalyst": {
    "projectKey": "project-name",
    "project": {
      "ticketPrefix": "PROJ"
    }
  }
}
```

Setup using the unified setup script:

```bash
curl -fsSL https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh | bash
```

## Requirements

- **Required**: HumanLayer CLI (thoughts system)
- **Optional**: Linear CLI (`linearis >= 1.1.0`)
- **Optional**: GitHub CLI (`gh`)

## Architecture

### Agents
Specialized research agents with focused capabilities (Glob, Grep, Read, Bash).

### Commands
Workflow orchestrators that spawn agents and manage processes.

### Hooks
Automatic tracking of thoughts documents via Claude Code hooks system.

### Scripts
Runtime utilities bundled with the plugin:
- `check-prerequisites.sh` - Validate requirements
- `create-worktree.sh` - Worktree management
- `workflow-context.sh` - Context tracking
- `update-workflow-context.sh` - Hook handler

## Philosophy

1. **Agents are documentarians** - Report what exists, don't critique
2. **Commands orchestrate** - Spawn parallel agents, manage workflows
3. **Context is precious** - Use thoughts system for persistence
4. **Automation via hooks** - Track automatically, not manually

## Documentation

- [Usage Guide](../../docs/USAGE.md)
- [Configuration](../../docs/CONFIGURATION.md)
- [Best Practices](../../docs/BEST_PRACTICES.md)
- [Agentic Workflows](../../docs/AGENTIC_WORKFLOW_GUIDE.md)

## License

MIT
