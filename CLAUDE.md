# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What This Repository Is

This is a **portable collection of Claude Code agents, commands, and workflows** for AI-assisted
development distributed as plugins. It's both:

1. A **source repository** for plugin-based agents and commands
2. A **working installation** that uses its own tools (dogfooding)

The workspace uses a plugin-based architecture where agents and commands are organized in
`plugins/dev/` and `plugins/meta/`, and installed locally via `.claude/` symlinks.

## Key Architecture Concepts

### Three-Layer System

1. **Plugin Source** (`plugins/dev/`, `plugins/meta/`)
   - Canonical definitions of agents and commands
   - Edit these when making changes
   - Organized by plugin type (dev for workflows, meta for creation)

2. **Installation Layer** (`.claude/`)
   - Symlinks to local plugin directories
   - Configuration file (`config.json`)
   - Claude Code reads plugins from here

3. **Thoughts System** (external, `~/thoughts/`)
   - Git-backed context management
   - Shared across all worktrees
   - Initialized per-project via `init-project.sh`

### Workflow State Management

Commands track workflow state via `.claude/.workflow-context.json`:

**Purpose**: Enable workflow commands to auto-discover recent documents without manual paths.

**How it works**:
- `/research-codebase` saves research → `/create-plan` auto-references it
- `/create-plan` saves plan → `/implement-plan` auto-finds it
- `/create-handoff` saves handoff → `/resume-handoff` auto-finds it

**Structure**:
```json
{
  "lastUpdated": "2025-10-26T10:30:00Z",
  "currentTicket": "PROJ-123",
  "mostRecentDocument": {
    "type": "plans",
    "path": "thoughts/shared/plans/2025-10-26-PROJ-123-feature.md",
    "created": "2025-10-26T10:30:00Z",
    "ticket": "PROJ-123"
  },
  "workflow": {
    "research": [...],  // Recent research documents
    "plans": [...],     // Recent plans
    "handoffs": [...],  // Recent handoffs
    "prs": [...]        // Recent PR descriptions
  }
}
```

**Key benefit**: Users don't need to remember or specify file paths. Commands chain together automatically.

**Management**: Automatically updated by workflow commands. Tracked per-worktree (not committed to git).

### Three-Layer Memory System

Catalyst uses a three-layer memory architecture to manage context across multiple projects:

**1. Project Configuration** (`.claude/config.json`)
   - Specifies which HumanLayer config to use (`configName`)
   - Contains project-specific settings (ticket prefix, Linear team, etc.)
   - Points to the long-term memory repository for this project

**2. Long-term Memory** (HumanLayer thoughts repository)
   - Git-backed persistent storage shared across worktrees
   - Contains: `shared/research/`, `shared/plans/`, `shared/prs/`, `shared/handoffs/`
   - Synced via `humanlayer thoughts sync`
   - Survives across sessions and team members

**3. Short-term Memory** (`.claude/.workflow-context.json`)
   - Local to each worktree (not committed to git)
   - Contains pointers to recent documents in long-term memory
   - Enables command chaining (e.g., `/create-plan` auto-finds recent research)
   - Refreshed each session

**How They Work Together:**

```
┌─────────────────────────────────────┐
│  .claude/config.json                │
│  {                                  │
│    "configName": "acme",            │ ← Which thoughts repo?
│    "project": {                     │
│      "ticketPrefix": "ACME"         │
│    }                                │
│  }                                  │
└─────────────────────────────────────┘
          │
          ├──→ Points to HumanLayer config "acme"
          │
          ▼
┌─────────────────────────────────────┐
│  ~/thoughts/repos/acme/             │
│  ├─ shared/research/                │ ← Long-term memory
│  ├─ shared/plans/                   │   (git-backed)
│  ├─ shared/prs/                     │
│  └─ shared/handoffs/                │
└─────────────────────────────────────┘
          │
          ├──→ Commands read/write here
          │
          ▼
┌─────────────────────────────────────┐
│  .claude/.workflow-context.json     │
│  {                                  │ ← Short-term memory
│    "mostRecentDocument": {          │   (session pointers)
│      "type": "plans",               │
│      "path": "thoughts/shared/..."  │ ← Points into long-term
│    },                                │
│    "workflow": {                    │
│      "research": [...],             │ ← Recent docs
│      "plans": [...]                 │
│    }                                │
│  }                                  │
└─────────────────────────────────────┘
```

**Why This Matters:**

This architecture enables you to:
- Work on multiple separate projects (work/personal, unrelated clients)
- Keep project contexts isolated via different HumanLayer configs
- Share long-term knowledge across worktrees within a project
- Chain commands together without remembering file paths
- Avoid committing secrets or session state to git

**Example Flow:**

1. Project config says "use acme thoughts repo"
2. `/research-codebase` saves to `~/thoughts/repos/acme/shared/research/`
3. Workflow-context tracks this as `mostRecentDocument`
4. `/create-plan` auto-references the research (no manual path needed)
5. Plan saves to `~/thoughts/repos/acme/shared/plans/`
6. Workflow-context updates to point to the new plan
7. `/implement-plan` auto-finds the plan

All while keeping different projects completely isolated.

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

This repository is both the source and a working installation (dogfooding).

**Plugin Installation (Dogfooding)**:
```bash
# The workspace has symlinks in .claude/plugins/ pointing to the plugin source
ls -la .claude/plugins/
# dev -> ../../plugins/dev
# meta -> ../../plugins/meta
```

This means:
- ✅ Changes to `plugins/dev/` or `plugins/meta/` are immediately available
- ✅ No hardcoded commands/agents in `.claude/` - uses plugin system like users do
- ✅ Restart Claude Code to reload after editing plugins
- ✅ True dogfooding - we use Catalyst exactly as users do

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
├── plugins/                 # Plugin packages for distribution
│   ├── dev/                 # Development workflow plugin (catalyst-dev)
│   │   ├── agents/          # Specialized research agents
│   │   │   ├── codebase-locator.md
│   │   │   ├── codebase-analyzer.md
│   │   │   ├── codebase-pattern-finder.md
│   │   │   ├── thoughts-locator.md
│   │   │   ├── thoughts-analyzer.md
│   │   │   ├── external-research.md
│   │   │   └── README.md
│   │   ├── commands/        # Core workflow commands
│   │   │   ├── commit.md
│   │   │   ├── debug.md
│   │   │   ├── describe_pr.md
│   │   │   ├── create_plan.md
│   │   │   ├── implement_plan.md
│   │   │   ├── validate_plan.md
│   │   │   ├── create_worktree.md
│   │   │   └── README.md
│   │   ├── scripts/         # Runtime scripts bundled with plugin
│   │   │   ├── check-prerequisites.sh
│   │   │   ├── create-worktree.sh
│   │   │   └── workflow-context.sh
│   │   └── plugin.json      # Plugin manifest
│   └── meta/                # Meta/workflow management plugin (catalyst-meta)
│       ├── commands/        # Workflow discovery & creation
│       │   ├── create_workflow.md
│       │   ├── discover_workflows.md
│       │   ├── import_workflow.md
│       │   ├── validate_frontmatter.md
│       │   └── workflow_help.md
│       ├── scripts/         # Runtime scripts for meta commands
│       │   └── validate-frontmatter.sh
│       └── plugin.json      # Plugin manifest
├── scripts/                 # One-time setup scripts (not bundled in plugins)
│   ├── humanlayer/          # HumanLayer/thoughts setup
│   │   ├── setup-thoughts.sh
│   │   ├── init-project.sh
│   │   ├── add-client-config
│   │   └── setup-personal-thoughts.sh
│   ├── linear/              # Linear workflow setup
│   │   └── setup-linear-workflow
│   └── README.md            # Setup scripts documentation
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
├── .claude/                 # Local Claude Code installation
│   ├── config.json          # Configuration (generic template values)
│   ├── .workflow-context.json # Workflow state (not committed)
│   └── plugins/             # Symlinks to plugin source (dogfooding)
│       ├── dev -> ../../plugins/dev/
│       └── meta -> ../../plugins/meta/
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
5. **plugins/dev/agents/codebase-locator.md** - Example of agent structure
6. **plugins/dev/commands/create_plan.md** - Example of command structure

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

1. Edit plugin files in `plugins/dev/` or `plugins/meta/`
2. Test locally (symlinks make changes immediately available)
3. Commit to workspace
4. Publish plugin updates to marketplace
5. Users update with `/plugin update catalyst-dev`

**Plugin Distribution:**

- Agents and commands are bundled in `plugins/dev/` and `plugins/meta/`
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

## Architecture Decision Records

Brief records of key architectural decisions made in this project.

### ADR-001: Plugin-Based Distribution

**Decision**: Distribute Catalyst as Claude Code plugins instead of git clone/install.

**Rationale**:
- Users get updates via `/plugin update catalyst-dev`
- No manual git pulls or symlink setup
- Plugin marketplace provides discoverability
- Local customizations (`.claude/config.json`) are preserved

**Consequences**:
- Plugin structure must be maintained in `plugins/dev/` and `plugins/meta/`
- Breaking changes require version management
- Users can install only what they need (dev vs meta plugins)

---

### ADR-002: Per-Project HumanLayer Configuration

**Decision**: Support multiple HumanLayer configs via `configName` in `.claude/config.json`.

**Rationale**:
- Users work on multiple separate projects (work/personal, different clients)
- Each project needs its own thoughts repository
- Switching configs should be seamless
- Config files can be committed (no secrets, just config names)

**Consequences**:
- HumanLayer CLI must be configured with multiple named configs
- Scripts must read `configName` from project config
- Setup requires `scripts/humanlayer/add-client-config` for new projects
- Projects remain isolated with separate long-term memory

---

### ADR-003: Three-Layer Memory Architecture

**Decision**: Separate project configuration, long-term memory (thoughts), and short-term memory (workflow-context).

**Rationale**:
- Config: Project-specific settings, portable, committable
- Long-term: Git-backed persistence, team collaboration, survives sessions
- Short-term: Session state, command chaining, not committed

**Consequences**:
- Commands must update workflow-context.json when creating documents
- Thoughts must be synced via `humanlayer thoughts sync`
- Workflow-context must be in `.gitignore`
- System supports multiple projects and worktrees seamlessly

---

### ADR-004: Workflow-Context for Session State

**Decision**: Store recent document references in `.claude/.workflow-context.json` for command chaining.

**Rationale**:
- Users shouldn't remember file paths between commands
- `/research-codebase` → `/create-plan` → `/implement-plan` should flow naturally
- Context must be local to each worktree
- Must not contain secrets or be committed to git

**Consequences**:
- All workflow commands must update workflow-context.json
- Helper script `scripts/workflow-context.sh` provides consistent interface
- Context is lost when worktree is deleted (by design)
- Commands can auto-discover recent documents without user input

---

### ADR-005: Configurable Worktree Convention

**Decision**: Use `GITHUB_SOURCE_ROOT` environment variable to organize repositories and worktrees by org/repo.

**Rationale**:
- Developers have different preferences for where code lives
- Hardcoded paths (`~/Source`, `~/wt`) don't work for everyone
- Main branches and worktrees should be organized together
- Clear separation between main checkout and feature branches

**Convention**:
- Main repository: `${GITHUB_SOURCE_ROOT}/<org>/<repo>`
- Worktrees: `${GITHUB_SOURCE_ROOT}/<org>/<repo>-worktrees/<feature>`

**Consequences**:
- `create-worktree.sh` detects GitHub org from git remote
- Falls back to `~/wt/<repo>` if `GITHUB_SOURCE_ROOT` not set
- No hardcoded paths in scripts or documentation
- Clean organization by org and repo
- Easy cleanup: delete `<repo>-worktrees` directory when done

**Example**:
```
~/code-repos/github/
├── coalesce-labs/catalyst/          # Main branch
├── coalesce-labs/catalyst-worktrees/ # Feature branches
└── acme/api/                         # Client project
```

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

1. Make changes to `plugins/dev/agents/*.md`
2. Restart Claude Code (symlinks ensure changes are visible)
3. Invoke with `@agent-name task description`
4. Verify output matches expected behavior

**Testing commands:**

1. Make changes to `plugins/dev/commands/*.md` or `plugins/meta/commands/*.md`
2. Restart Claude Code (symlinks ensure changes are visible)
3. Invoke with `/command-name args`
4. Verify workflow executes correctly

**Plugin structure:**
- `plugins/dev/` - Core development workflow commands and research agents
- `plugins/meta/` - Workflow discovery and creation commands

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
- Examine plugin source in `plugins/dev/` and `plugins/meta/`

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
