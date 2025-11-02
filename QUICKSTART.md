# Catalyst Installation & Configuration Guide

Complete guide to installing and configuring Catalyst for Claude Code.

## Table of Contents

- [Quick Start (5 Minutes)](#quick-start-5-minutes)
- [Installation](#installation)
- [Configuration](#configuration)
- [Thoughts System Setup](#thoughts-system-setup)
- [Service Integration](#service-integration)
- [Worktree Setup](#worktree-setup)
- [Core Workflow](#core-workflow)
- [Commands & Agents Reference](#commands--agents-reference)
- [Troubleshooting](#troubleshooting)

---

## Quick Start (5 Minutes)

**Download and run setup script:**
```bash
# Download the setup script
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh
chmod +x setup-catalyst.sh

# Run it (requires interactive input)
./setup-catalyst.sh
```

**What this does:**
- ✅ Checks/installs prerequisites (HumanLayer, jq)
- ✅ Sets up thoughts repository (one per org)
- ✅ Creates project configuration
- ✅ Configures worktree directories
- ✅ Prompts for API tokens (Linear, Sentry, etc.)
- ✅ Links project to shared thoughts

**Then:**
```bash
# In Claude Code:
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev

# Restart Claude Code
```

You're ready! Try `/research-codebase` in your next session.

---

## Installation

### Prerequisites

- **Claude Code** installed and working
- **HumanLayer CLI** (for thoughts system)
  ```bash
  pip install humanlayer
  # or
  pipx install humanlayer

  # Verify
  humanlayer --version
  ```

### Install Catalyst Plugins

Catalyst is distributed as a 5-plugin system. Install what you need:

```bash
# Add the marketplace
/plugin marketplace add coalesce-labs/catalyst

# Core workflow (required)
/plugin install catalyst-dev

# Optional: Project management (Linear integration)
/plugin install catalyst-pm

# Optional: Analytics (PostHog integration)
/plugin install catalyst-analytics

# Optional: Debugging (Sentry integration)
/plugin install catalyst-debugging

# Optional: Workflow discovery
/plugin install catalyst-meta
```

### What You Get

**catalyst-dev** (Always enabled):
- 11 research agents
- 18 workflow commands
- Linear integration
- Handoff system
- ~3.5k context (lightweight)

**catalyst-pm** (Enable for project management):
- Cycle tracking, milestone planning
- Backlog grooming, daily standups
- GitHub-Linear sync

**catalyst-analytics** (Enable when analyzing metrics):
- PostHog MCP integration
- ~40k context when enabled

**catalyst-debugging** (Enable for incident response):
- Sentry MCP integration
- ~20k context when enabled

**catalyst-meta** (Advanced users):
- Discover and import workflows from community

---

## Configuration

Catalyst uses a **two-layer configuration system**:

### Setup Configuration

**Unified setup script (recommended):**

```bash
# Download and run
curl -fsSL https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh | bash
```

**What you'll be asked:**
1. Project location (existing repo or clone fresh)
2. Project key (defaults to GitHub org name)
3. Ticket prefix (e.g., "ENG", "PROJ")
4. Your name (for thoughts system)
5. API tokens for integrations (can skip optional ones)

**Result:**
- ✅ `.claude/config.json` (committable, no secrets)
- ✅ `~/.config/humanlayer/config-{projectKey}.json` (thoughts location)
- ✅ `~/.config/catalyst/config-{projectKey}.json` (API tokens)
- ✅ Thoughts repository at org level
- ✅ Worktree directory created

**Idempotent:** Safe to re-run to add/update integrations.

### Layer 1: Project Config (`.claude/config.json`)

This file contains **non-sensitive** project metadata and is **safe to commit** to git.

**Location**: `.claude/config.json` (in your project root)

**Example**:
```json
{
  "catalyst": {
    "projectKey": "acme",
    "repository": {
      "org": "acme-corp",
      "name": "api"
    },
    "project": {
      "ticketPrefix": "ACME",
      "name": "Acme Corp Project"
    },
    "thoughts": {
      "user": null
    }
  }
}
```

**What goes here**:
- All Catalyst configuration under the `catalyst` key
- `catalyst.projectKey` - Links to your secrets config
- `catalyst.project.ticketPrefix` - Your Linear/project ticket prefix (e.g., "ENG", "PROJ")
- Project name and metadata

### Layer 2: Secrets Config (`~/.config/catalyst/`)

This file contains **API tokens and secrets** and is **never committed** to git.

**Location**: `~/.config/catalyst/config-{projectKey}.json`

**Example** (`~/.config/catalyst/config-acme.json`):
```json
{
  "catalyst": {
    "linear": {
      "apiToken": "lin_api_...",
      "teamKey": "ACME",
      "defaultTeam": "ACME"
    },
    "sentry": {
      "org": "acme-corp",
      "project": "acme-web",
      "authToken": "sntrys_..."
    },
    "railway": {
      "token": "...",
      "projectId": "..."
    },
    "posthog": {
      "apiKey": "...",
      "projectId": "..."
    },
    "exa": {
      "apiKey": "..."
    }
  }
}
```

**What goes here**:
- API tokens
- Auth tokens
- Service credentials

### Switching Between Projects

Working on multiple projects? Just change the `projectKey`:

```json
// .claude/config.json
{
  "catalyst": {
    "projectKey": "work"  // Change to "personal", "client-a", etc.
  }
}
```

Each project key points to a different secrets file in `~/.config/catalyst/`.

---

## Thoughts System Setup

The thoughts system provides git-backed persistent context across sessions.

### Automatic Setup

**Automatic setup** (included in unified setup script):

The setup script automatically:
- Creates org-level thoughts repo (`<org_root>/thoughts/`)
- Configures HumanLayer CLI
- Initializes thoughts in your project
- Creates symlinks to shared thoughts

### Manual Setup

**Manual setup** (if needed):

If you skipped thoughts setup or want to initialize additional projects:

```bash
# Initialize thoughts in current project
cd /path/to/your-project
humanlayer thoughts init --directory <repo-name>
```

**Directory structure:**
```
<org_root>/
├── thoughts/                    # Shared by all org projects
│   ├── repos/
│   │   ├── project-a/
│   │   │   ├── {your_name}/
│   │   │   └── shared/
│   │   └── project-b/
│   └── global/
├── project-a/
│   └── thoughts/                # Symlinks to ../thoughts/repos/project-a/
└── project-b/
    └── thoughts/                # Symlinks to ../thoughts/repos/project-b/
```

### Syncing Thoughts

```bash
# Sync thoughts (creates searchable index)
humanlayer thoughts sync

# Check status
humanlayer thoughts status

# Sync with message
humanlayer thoughts sync -m "Updated research on feature X"
```

### Backing Up to GitHub

```bash
cd <org_root>/thoughts
gh repo create my-thoughts --private --source=. --push
```

Now thoughts automatically sync to GitHub.

---

## Service Integration

### Linear (Project Management)

**Installation**:
```bash
npm install -g --install-links ryanrozich/linearis#feat/cycles-cli
```

**Configuration**:

Project config (`.claude/config.json`):
```json
{
  "catalyst": {
    "project": {
      "ticketPrefix": "ENG"
    }
  }
}
```

Secrets config (`~/.config/catalyst/config-{projectKey}.json`):
```json
{
  "catalyst": {
    "linear": {
      "apiToken": "lin_api_...",
      "teamKey": "ENG",
      "defaultTeam": "Engineering"
    }
  }
}
```

**Authentication**: Set `LINEAR_API_TOKEN` environment variable or store in `~/.linear_api_token`

### Railway (Deployment)

**Installation**:
```bash
npm install -g @railway/cli
railway login
```

**Configuration**:

Secrets config:
```json
{
  "catalyst": {
    "railway": {
      "projectId": "your-project-id",
      "defaultService": "web"
    }
  }
}
```

### Sentry (Error Monitoring)

**Installation**:
```bash
curl -sL https://sentry.io/get-cli/ | sh
```

**Configuration**:

Secrets config:
```json
{
  "catalyst": {
    "sentry": {
      "org": "your-org",
      "project": "your-project",
      "authToken": "sntrys_..."
    }
  }
}
```

**Authentication**: Set `SENTRY_AUTH_TOKEN` or configure `~/.sentryclirc`

### PostHog (Analytics)

Secrets config:
```json
{
  "catalyst": {
    "posthog": {
      "apiKey": "phc_...",
      "projectId": "12345"
    }
  }
}
```

### Exa (Web Search)

Secrets config:
```json
{
  "catalyst": {
    "exa": {
      "apiKey": "exa_..."
    }
  }
}
```

---

## Worktree Setup

For clean parallel work organization, set the `GITHUB_SOURCE_ROOT` environment variable.

### Configuration

Add to `~/.zshrc` or `~/.bashrc`:

```bash
export GITHUB_SOURCE_ROOT="$HOME/code-repos/github"
```

### Directory Structure

This organizes your code as:

- **Main repos**: `~/code-repos/github/<org>/<repo>`
- **Worktrees**: `~/code-repos/github/<org>/<repo>-worktrees/<feature>`

**Example**:
```
~/code-repos/github/
├── coalesce-labs/catalyst/          # Main branch
├── coalesce-labs/catalyst-worktrees/ # Feature branches
│   ├── PROJ-123/
│   └── PROJ-456/
└── acme/api/                         # Client project
```

### Creating Worktrees

```bash
/create-worktree PROJ-123 main
```

This creates:
- Isolated git worktree
- Separate branch
- Shared `.claude/` config (symlink)
- Thoughts automatically synced
- Dependencies installed

**Fallback**: If `GITHUB_SOURCE_ROOT` not set, defaults to `~/wt/<repo>`

---

## Core Workflow

Catalyst provides a research → plan → implement → validate → ship workflow.

### 1. Research Phase

```
/research-codebase
```

Follow prompts to research your codebase. This:
- Spawns parallel research agents
- Documents what exists (no critique)
- Saves to `thoughts/shared/research/`

### 2. Planning Phase

```
/create-plan
```

This:
- Reads research documents
- Interactively builds a plan with you
- Saves to `thoughts/shared/plans/YYYY-MM-DD-TICKET-description.md`

### 3. Implementation Phase

```
/implement-plan
```

**Note**: If you just created a plan, omit the path - it auto-finds your most recent plan!

This:
- Reads the plan
- Implements each phase
- Runs automated tests
- Updates checkboxes

### 4. Validation Phase

```
/validate-plan
```

This:
- Verifies all success criteria
- Runs automated tests
- Documents deviations
- Provides manual testing checklist

### 5. Create PR

```
/create-pr
```

Automatically creates a PR with comprehensive description from your research and plan.

### Context Persistence

**Handoffs** save context between sessions:

```bash
# Save context
/create-handoff

# Resume later
/resume-handoff
```

### Workflow Context Auto-Discovery

Catalyst tracks your workflow via `.claude/.workflow-context.json`:

- `/research-codebase` → `/create-plan` references it
- `/create-plan` → `/implement-plan` auto-finds it
- `/create-handoff` → `/resume-handoff` auto-finds it

**You don't need to specify file paths** - commands remember your work!

---

## Commands & Agents Reference

### Common Commands

| Command | Purpose |
|---------|---------|
| `/research-codebase` | Research codebase and save findings |
| `/create-plan` | Interactive planning with research |
| `/implement-plan` | Execute a plan (auto-finds recent) |
| `/validate-plan` | Verify implementation |
| `/create-pr` | Create PR with rich description |
| `/merge-pr` | Merge PR and update Linear |
| `/create-worktree` | Set up parallel workspace |
| `/create-handoff` | Save context for later |
| `/resume-handoff` | Restore previous context |

### PM Commands (catalyst-pm plugin)

| Command | Purpose |
|---------|---------|
| `/pm:analyze-cycle` | Cycle health report |
| `/pm:analyze-milestone` | Milestone progress |
| `/pm:report-daily` | Daily standup summary |
| `/pm:groom-backlog` | Backlog analysis |
| `/pm:sync-prs` | GitHub-Linear sync |

### Research Agents

| Agent | Purpose |
|-------|---------|
| `@catalyst-dev:codebase-locator` | Find files by topic |
| `@catalyst-dev:codebase-analyzer` | Understand implementation |
| `@catalyst-dev:thoughts-locator` | Find historical docs |
| `@catalyst-dev:codebase-pattern-finder` | Find code examples |
| `@catalyst-dev:thoughts-analyzer` | Extract key insights |

**Example**:
```
@catalyst-dev:codebase-locator find all files related to authentication
```

---

## Troubleshooting

### Commands not showing up

1. Check plugin installation:
   ```bash
   /plugin list
   ```
2. Reinstall if needed:
   ```bash
   /plugin install catalyst-dev
   ```
3. Restart Claude Code

### "humanlayer command not found"

Install the HumanLayer CLI:
```bash
pip install humanlayer
# or
pipx install humanlayer
```

### Thoughts not syncing

1. Check status:
   ```bash
   humanlayer thoughts status
   ```
2. Re-initialize:
   ```bash
   humanlayer thoughts init
   ```

### Config not being read

**Check**:
1. File exists: `ls .claude/config.json`
2. Valid JSON: `cat .claude/config.json | jq`
3. Correct location: Must be in `.claude/` directory
4. Secrets file exists: `ls ~/.config/catalyst/config-{projectKey}.json`

### Commands still use generic placeholders

Commands use `PROJ-XXX` as placeholders in examples. When you run them, they'll use your configured `ticketPrefix` from `.claude/config.json`.

### Plugin not loading service integration

Check that you've enabled the plugin:
```bash
# Enable PM plugin for Linear
/plugin enable catalyst-pm

# Enable analytics for PostHog
/plugin enable catalyst-analytics

# Disable when done to free context
/plugin disable catalyst-analytics
```

---

## Next Steps

**You're ready!** Start with `/research-codebase` or `/create-plan` in your next Claude Code session.

**Learn more**:
- [USAGE.md](docs/USAGE.md) - Detailed usage guide
- [BEST_PRACTICES.md](docs/BEST_PRACTICES.md) - Workflow patterns
- [PATTERNS.md](docs/PATTERNS.md) - Create custom agents
- [CONTEXT_ENGINEERING.md](docs/CONTEXT_ENGINEERING.md) - Context management theory
- [docs/](docs/) - Full documentation

**Get help**:
- Visit [GitHub repository](https://github.com/coalesce-labs/catalyst)
- Check documentation in [docs/](docs/)
