# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What This Repository Is

This is a **portable collection of Claude Code agents, commands, and workflows** for AI-assisted
development. It's both:

1. A **source repository** for reusable agents/commands
2. A **working installation** that uses its own tools (dogfooding)

The workspace is installed into itself at `.claude/`, meaning you can use all the commands and
agents while developing them.

## Key Architecture Concepts

### Three-Layer System

1. **Source Files** (`agents/`, `commands/`)
   - Canonical definitions of agents and commands
   - Edit these when making changes
   - Automatically synced to `.claude/` since they're in the same repo

2. **Installation Layer** (`.claude/`)
   - Working copies used by Claude Code
   - Auto-updated from source files in this repo
   - Used by the `/update-project` command to push to other projects

3. **Thoughts System** (external, `~/thoughts/`)
   - Git-backed context management
   - Shared across all worktrees
   - Symlinked into projects via `ryan-init-project`

### Agent Philosophy

All agents follow a **documentarian, not critic** approach:

- Document what EXISTS, not what should exist
- NO suggestions for improvements unless explicitly asked
- NO root cause analysis unless explicitly asked
- NO architecture critiques or quality assessments
- Focus on answering "WHERE is X?" and "HOW does X work?"

This is critical - agents are for understanding codebases, not evaluating them.

### Command Organization

Commands are organized into namespaces for clarity and discoverability:

- **workflow/** - Core research/plan/implement/validate flow
- **dev/** - Development workflow (commit, debug, PR descriptions)
- **linear/** - Linear ticket management and PR lifecycle
- **project/** - Project-level operations (worktrees, updates)
- **handoff/** - Context persistence across sessions
- **meta/** - Workflow discovery, creation, validation

All commands:
- Orchestrate multi-step processes via sub-agents
- Use the thoughts system for persistent context
- Are configuration-driven (see `.claude/config.json`)
- Spawn parallel sub-agents for efficiency

## Common Development Tasks

### Building and Testing

This workspace has no build process - it's markdown files and bash scripts.

**Testing changes:**

1. Edit source files in `agents/` or `commands/`
2. Changes are immediately available (same repo)
3. Restart Claude Code to reload
4. Test by invoking the agent/command

### Distribution and Installation

**Catalyst is distributed as a Claude Code plugin:**

```bash
# Add to marketplace
/plugin marketplace add coalesce-labs/catalyst

# Install development workflow plugin
/plugin install catalyst-dev

# Optional: Install meta/workflow creation plugin
/plugin install catalyst-meta
```

**For development on Catalyst itself:**

This repository is both the source and a working installation (dogfooding). Source files in `agents/` and `commands/` are mirrored in `.claude/` for immediate use. Changes are available after restarting Claude Code.

### Configuration System

Configuration lives in `.claude/config.json`:

```json
{
  "project": {
    "ticketPrefix": "PROJ",
    "defaultTicketPrefix": "PROJ"
  },
  "linear": {
    "teamKey": "[NEEDS_SETUP]",
    "defaultTeam": "[NEEDS_SETUP]",
    "apiToken": "[NEEDS_SETUP]",
    "thoughtsRepoUrl": null
  },
  "railway": {
    "projectId": "[NEEDS_SETUP]",
    "defaultService": "[NEEDS_SETUP]"
  },
  "sentry": {
    "org": "[NEEDS_SETUP]",
    "project": "[NEEDS_SETUP]",
    "authToken": "[NEEDS_SETUP]"
  },
  "posthog": {
    "apiKey": "[NEEDS_SETUP]",
    "projectId": "[NEEDS_SETUP]"
  },
  "exa": {
    "apiKey": "[NEEDS_SETUP]"
  },
  "thoughts": {
    "user": null
  }
}
```

**In this workspace:** Keep values generic/null (it's a template) **In actual projects:** Fill in
real values (ENG-123, team IDs, etc.)

Commands read config to customize behavior per-project.

## Directory Structure

```
ryan-claude-workspace/
├── agents/                  # Source: Specialized research agents
│   ├── codebase-locator.md
│   ├── codebase-analyzer.md
│   ├── codebase-pattern-finder.md
│   ├── thoughts-locator.md
│   ├── thoughts-analyzer.md
│   └── external-research.md
├── commands/                # Source: Namespaced slash commands
│   ├── dev/                 # Development workflow commands
│   │   ├── commit.md
│   │   ├── debug.md
│   │   └── describe_pr.md
│   ├── handoff/             # Context handoff commands
│   │   ├── create_handoff.md
│   │   └── resume_handoff.md
│   ├── linear/              # Linear integration commands
│   │   ├── linear.md
│   │   ├── create_pr.md
│   │   ├── merge_pr.md
│   │   └── linear_setup_workflow.md
│   ├── meta/                # Meta/workflow management commands
│   │   ├── create_workflow.md
│   │   ├── discover_workflows.md
│   │   ├── import_workflow.md
│   │   ├── validate_frontmatter.md
│   │   └── workflow_help.md
│   ├── project/             # Project management commands
│   │   ├── create_worktree.md
│   │   └── update_project.md
│   └── workflow/            # Core workflow commands
│       ├── research_codebase.md
│       ├── create_plan.md
│       ├── implement_plan.md
│       └── validate_plan.md
├── scripts/             # Setup and development scripts
│   ├── setup-thoughts.sh         # Initialize ~/thoughts/
│   ├── init-project.sh           # Init thoughts in project
│   ├── create-worktree.sh        # Create git worktree (bundled in plugin)
│   ├── setup-personal-thoughts.sh
│   ├── setup-multi-config.sh
│   ├── setup-linear-workflow
│   ├── hl-switch                 # Multi-config switching
│   └── add-client-config
├── docs/                    # Documentation
│   ├── USAGE.md                  # Comprehensive usage guide
│   ├── BEST_PRACTICES.md
│   ├── PATTERNS.md
│   ├── CONTEXT_ENGINEERING.md
│   ├── CONFIGURATION.md
│   ├── AGENTIC_WORKFLOW_GUIDE.md
│   ├── WORKFLOW_DISCOVERY_SYSTEM.md
│   ├── LINEAR_WORKFLOW_AUTOMATION.md
│   ├── FRONTMATTER_STANDARD.md
│   ├── DEEPWIKI_INTEGRATION.md
│   ├── MULTI_CONFIG_GUIDE.md
│   ├── HUMANLAYER_COMMANDS_ANALYSIS.md
│   └── PR_LIFECYCLE.md
├── .claude/                 # Working installation (dogfooding)
│   ├── agents/              # Installed copies
│   ├── commands/            # Installed copies
│   └── config.json          # Configuration (generic values)
├── README.md                # Overview and quick start
├── QUICKSTART.md            # 5-minute setup guide
├── COMMANDS_ANALYSIS.md     # Command catalog
└── CLAUDE.md                # This file
```

## Core Workflows

### Research → Plan → Implement → Validate

**1. Research Phase:**

```
/research-codebase
> "How does authentication work in the API?"
```

- Spawns parallel sub-agents (locator, analyzer, pattern-finder)
- Documents what exists with file:line references
- Saves to `thoughts/shared/research/YYYY-MM-DD-description.md`

**2. Planning Phase:**

```
/create-plan
> Reference: thoughts/shared/research/2025-01-08-auth.md
> Task: Add OAuth support
```

- Reads research documents fully
- Interactive planning with user
- Includes automated AND manual success criteria
- Saves to `thoughts/shared/plans/YYYY-MM-DD-PROJ-XXX-description.md`

**3. Implementation Phase:**

```
/implement-plan thoughts/shared/plans/2025-01-08-PROJ-123-oauth.md
```

- Reads full plan (no partial reads)
- Implements each phase sequentially
- Runs automated verification
- Updates checkboxes as work completes

**4. Validation Phase:**

```
/validate-plan
```

- Verifies all phases completed
- Runs automated test suites
- Documents deviations
- Provides manual testing steps

### Worktree Development

Create isolated workspace for parallel work:

```bash
/create-worktree PROJ-123 feature-name
```

This creates:

- Git worktree at `~/wt/{repo-name}/feature-name/`
- New branch `PROJ-123-feature-name`
- `.claude/` copied over
- `thoughts/` automatically shared (symlinked)
- Dependencies installed

**Key benefit:** Multiple features in progress, shared context via thoughts.

### Workflow Discovery

Discover and import workflows from external repos:

```
/discover-workflows
> Research Claude Code repositories for workflow patterns

/import-workflow
> Import workflow from repository X and adapt it

/create-workflow
> Create new agent/command based on discovered patterns
```

## Important Files to Read

When understanding the system:

1. **README.md** - High-level overview and philosophy
2. **docs/USAGE.md** - Comprehensive usage guide with examples
3. **docs/CONFIGURATION.md** - How config system works
4. **docs/AGENTIC_WORKFLOW_GUIDE.md** - Agent patterns and best practices
5. **agents/codebase-locator.md** - Example of agent structure
6. **commands/workflow/research_codebase.md** - Example of command structure

## Frontmatter Standard

All agents and commands use YAML frontmatter:

**Agents:**

```yaml
---
name: agent-name
description: What this agent does
tools: Grep, Glob, Read
model: inherit
---
```

**Commands:**

```yaml
---
description: What this command does
category: workflow|utility
tools: Read, Write, Task, TodoWrite
model: inherit
version: 1.0.0
---
```

Use `/validate-frontmatter` to check consistency.

## Dependencies

**Required:**

- Claude Code (claude.ai/code)
- Git
- Bash

**Optional:**

- HumanLayer CLI (`humanlayer`) - For thoughts system
- Linear CLI (`linear`) - For Linear integration
- GitHub CLI (`gh`) - For PR creation

**Installation:** The thoughts system requires HumanLayer CLI. Setup with:

```bash
./scripts/setup-thoughts.sh
```

## Update Strategy

**When improving Catalyst:**

1. Edit source files in `agents/` or `commands/`
2. Test locally (changes auto-sync in this repo)
3. Commit to workspace
4. Publish plugin updates to marketplace
5. Users update with `/plugin update catalyst-dev`

**Plugin Distribution:**

- Agents and commands are bundled in plugins
- Users get updates via Claude Code plugin system
- Local config (`.claude/config.json`) is never overwritten
- Project-specific customizations are preserved

## Integration Points

### Linear Integration

- `/linear` command for ticket management
- Auto-configures on first use
- Saves config to `.claude/config.json`
- See `docs/LINEAR_WORKFLOW_AUTOMATION.md`

### DeepWiki Integration

- External research via `external-research` agent
- Queries GitHub repositories for patterns
- See `docs/DEEPWIKI_INTEGRATION.md`

### HumanLayer Integration

- Thoughts system via `humanlayer` CLI
- Personal/shared/global directories
- Git-backed persistence
- Commands: `humanlayer thoughts sync`, `humanlayer thoughts status`

## Context Management Principles

Based on Anthropic's context engineering:

1. **Context is precious** - Use specialized agents, not monoliths
2. **Just-in-time loading** - Load context dynamically
3. **Sub-agent architecture** - Parallel research > sequential
4. **Structured persistence** - Save outside conversation (thoughts/)
5. **Read files fully** - No partial reads of key documents
6. **Wait for agents** - Don't proceed until research completes

See `docs/CONTEXT_ENGINEERING.md` for details.

## Common Patterns

### Spawning Parallel Agents

When researching, spawn multiple agents at once:

```
@agent-codebase-locator find authentication files
@agent-thoughts-locator find authentication research
@agent-codebase-analyzer analyze auth flow
```

### Reading Files Fully

Always read key documents without limit/offset:

```
Read tool: file_path only, no limit/offset
```

### Using TodoWrite for Planning

Break down complex tasks:

```
TodoWrite:
1. Research existing implementation
2. Design new approach
3. Implement changes
4. Run tests
5. Validate against success criteria
```

### Configuration Access

Commands access config with:

```bash
CONFIG_FILE=".claude/config.json"
TICKET_PREFIX=$(jq -r '.project.ticketPrefix // "PROJ"' "$CONFIG_FILE")
```

## Testing and Validation

**Testing agents:**

1. Make changes to `agents/*.md`
2. Restart Claude Code
3. Invoke with `@agent-name task description`
4. Verify output matches expected behavior

**Testing commands:**

1. Make changes to `commands/{namespace}/*.md`
2. Restart Claude Code
3. Invoke with `/command-name args`
4. Verify workflow executes correctly

Namespaces: `dev/`, `handoff/`, `linear/`, `meta/`, `project/`, `workflow/`

**Validating frontmatter:**

```
/validate-frontmatter
```

**Testing plugin installation:**

```bash
/plugin list
# Should show catalyst-dev and optionally catalyst-meta

# Test a command
/research-codebase
```

## Deployment and Distribution

**Users install Catalyst via Claude Code marketplace:**

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
```

**Setting up thoughts in a new project:**

```bash
cd /path/to/new-project

# Download init script
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/scripts/init-project.sh
chmod +x init-project.sh
./init-project.sh . project-name

# Sync thoughts
humanlayer thoughts sync
```

**Sharing with team:** Commit `thoughts/` to project repo. Team gets shared context via thoughts system. Each team member installs the Catalyst plugin independently.

## Multi-Config Support

For consultants working across clients:

```bash
# Download multi-config setup
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/scripts/setup-multi-config.sh
chmod +x setup-multi-config.sh
./setup-multi-config.sh

# Switch between configs
hl-switch client-name
```

Manages separate configs per client. See `docs/MULTI_CONFIG_GUIDE.md`.

## Key Principles When Editing

1. **Agents are documentarians** - Never suggest improvements unless asked
2. **Commands are workflows** - Orchestrate, don't implement
3. **Config drives behavior** - No hardcoded values
4. **Read fully, not partially** - Especially tickets, plans, research
5. **Spawn parallel agents** - Maximize efficiency
6. **Wait for completion** - Don't synthesize partial results
7. **Preserve context** - Save to thoughts/, not just memory
8. **Smart updates** - Merge workspace changes, keep local config

## Getting Help

- Check `docs/` for comprehensive guides
- Review `README.md` for philosophy
- Read `QUICKSTART.md` for setup
- Use `/workflow-help` for interactive guidance
- Examine source in `agents/` and `commands/`

## Version Control

This workspace tracks:

- Agent definitions
- Command workflows
- Documentation
- Scripts
- Configuration templates (generic values)

**Do NOT commit to this workspace:**

- Specific ticket prefixes (keep "PROJ")
- Linear team/project IDs (keep null)
- Personal thoughts user (keep null)

**Do commit to project repos:**

- Real config values
- Project-specific customizations
- Shared thoughts content
