# Ryan's Claude Workspace

A portable collection of Claude Code agents, commands, and workflows for effective AI-assisted development across multiple repositories.

## What This Is

This repository contains battle-tested patterns for working with Claude Code on large codebases, including:

- **Specialized Agents** - Research, analysis, and implementation agents
- **Workflow Commands** - Create → Plan → Implement → Validate workflows
- **Thoughts System** - Persistent context management across worktrees
- **Setup Scripts** - Automated initialization for new projects

## Philosophy

Based on Anthropic's context engineering principles:

- **Context is precious** - Use specialized, focused agents rather than monolithic ones
- **Just-in-time loading** - Load context dynamically, not all at once
- **Sub-agent architecture** - Parallel, focused research > sequential analysis
- **Structured persistence** - Save context outside the conversation window

## Quick Start

### 1. Install Thoughts Repository

```bash
# Initialize your central thoughts repository
./hack/setup-thoughts.sh

# This creates:
# ~/thoughts/
# ├── repos/         # Per-repository thoughts
# └── global/        # Cross-repository thoughts
```

### 2. Install Agents & Commands

```bash
# Install to user directory (available in all projects)
./hack/install-user.sh

# Or install to specific project
./hack/install-project.sh /path/to/project

# Later, update project from workspace (preserves customizations!)
./hack/update-project.sh /path/to/project
# Or use slash command: /update-project /path/to/project
```

### 3. Initialize a Project

```bash
# In your project directory
cd /path/to/my-project

# Initialize thoughts for this project
ryan-init-project my-project

# Now you have:
# my-project/thoughts/
# ├── {your_name}/  → Personal notes for this repo
# ├── shared/       → Team-shared notes
# ├── global/       → Cross-repo thoughts
# └── searchable/   → Hard links for searching
```

### 4. Create a Worktree for Parallel Work

```bash
# In your main repository
./hack/create-worktree.sh ENG-123 feature-name

# This creates an isolated workspace with:
# - Git worktree at ~/wt/my-project/feature-name
# - .claude/ directory copied over
# - thoughts/ automatically synced
# - All dependencies installed
```

## Complete Development Workflow

### 1. Research Phase

```bash
# Start by researching the codebase
/research-codebase

# Prompt: "How does authentication work in the API?"

# This:
# 1. Spawns parallel sub-agents (codebase-locator, codebase-analyzer, pattern-finder)
# 2. Documents what EXISTS (not what should exist)
# 3. Synthesizes findings with file:line references
# 4. Saves to thoughts/shared/research/YYYY-MM-DD-description.md
```

**Output**: Comprehensive research document explaining current system state

### 2. Planning Phase

```bash
# Create implementation plan based on research
/create-plan

# Can reference research: "Create a plan based on thoughts/shared/research/2025-01-08-auth.md"

# This:
# 1. Reads research documents and ticket files fully
# 2. Spawns parallel research agents to understand current state
# 3. Interactively builds comprehensive plan with user
# 4. Includes automated AND manual success criteria
# 5. Saves to thoughts/shared/plans/YYYY-MM-DD-PROJ-XXX-description.md
```

**Output**: Detailed implementation plan with phases and verification steps

### 3. Implementation Phase

```bash
# Execute the approved plan in a worktree
/implement-plan thoughts/shared/plans/2025-01-08-PROJ-123-feature.md

# This:
# 1. Reads the full plan (no partial reads!)
# 2. Implements each phase sequentially
# 3. Runs automated verification after each phase
# 4. Updates checkboxes as work completes
# 5. Asks before moving to next phase
```

**Output**: Code changes with passing tests

### 4. Validation Phase

```bash
/validate-plan

# This:
# 1. Verifies all phases completed
# 2. Runs automated test suites
# 3. Documents any deviations from plan
# 4. Provides manual testing steps
# 5. Confirms success criteria met
```

**Output**: Validation report confirming implementation

### Complete Flow Example

```bash
# 1. Research existing authentication system
/research-codebase
> "How does authentication currently work?"
→ thoughts/shared/research/2025-01-08-auth-system.md

# 2. Create plan to add OAuth support
/create-plan
> Reference: thoughts/shared/research/2025-01-08-auth-system.md
> Task: Add OAuth2 authentication
→ thoughts/shared/plans/2025-01-08-PROJ-456-oauth-support.md

# 3. Create worktree and implement
./hack/create-worktree.sh PROJ-456 oauth-support
cd ~/wt/my-project/oauth-support
/implement-plan thoughts/shared/plans/2025-01-08-PROJ-456-oauth-support.md
→ Code changes + tests

# 4. Validate implementation
/validate-plan
→ All tests pass, manual verification steps listed

# 5. Create PR with full automation
/commit              # Conventional commits with auto-detection
/create-pr           # Auto-rebase, create PR, generate description, link Linear
/describe-pr         # Update description after code review changes
/merge-pr            # Safe merge with verification, auto-cleanup
```

### PR Lifecycle (New!)

Complete automation from commit to merge:

```bash
# Make changes
/commit
# → Conventional commits (feat/fix/docs/etc)
# → Auto-detects type and scope
# → Extracts ticket from branch

/create-pr
# → Auto-rebases if behind main
# → Creates PR with ticket-based title
# → Generates comprehensive description
# → Linear: ticket → In Review (assigned to you)

# Code review, push more commits...

/describe-pr
# → Incremental update (preserves manual edits)
# → Appends new changes
# → Reruns verification checks

/merge-pr
# → Runs tests automatically
# → Squash merges (always)
# → Deletes branches (always)
# → Linear: ticket → Done
```

## Directory Structure

```
ryan-claude-workspace/
├── agents/                  # Specialized research agents
│   ├── README.md            # Agent documentation
│   ├── codebase-locator.md
│   ├── codebase-analyzer.md
│   ├── codebase-pattern-finder.md
│   ├── thoughts-locator.md
│   ├── thoughts-analyzer.md
│   └── external-research.md
├── commands/                # Slash commands for workflows
│   ├── README.md            # Command documentation and types
│   ├── research_codebase.md
│   ├── create_plan.md
│   ├── implement_plan.md
│   ├── validate_plan.md
│   ├── linear.md
│   ├── create_worktree.md
│   └── ... (18 total)
├── hack/                    # Installation & setup scripts
│   ├── README.md            # Script documentation and workflows
│   ├── install-user.sh      # Install globally
│   ├── install-project.sh   # Install to project
│   ├── update-project.sh    # Smart update with merging
│   ├── setup-thoughts.sh    # Initialize thoughts system
│   ├── create-worktree.sh   # Create git worktree
│   └── ... (12 total)
├── docs/                    # Comprehensive guides
│   ├── README.md            # Documentation index
│   ├── USAGE.md             # Usage guide
│   ├── CONFIGURATION.md     # Configuration system
│   ├── LINEAR_WORKFLOW_AUTOMATION.md
│   ├── AGENTIC_WORKFLOW_GUIDE.md
│   └── ... (12 total)
├── .claude/                 # Working installation (dogfooding)
│   ├── agents/              # Installed agent copies
│   ├── commands/            # Installed command copies
│   └── config.json          # Configuration template
├── README.md                # This file
├── QUICKSTART.md            # 5-minute setup guide
└── CLAUDE.md                # Instructions for Claude Code
```

## Key Concepts

### Agents

Agents are specialized AI experts that Claude Code can delegate to:

- **codebase-locator** - Finds files by topic (read-only, grep/glob/ls)
- **codebase-analyzer** - Understands how code works
- **thoughts-locator** - Finds historical context in thoughts/
- **codebase-pattern-finder** - Finds similar implementations

### Commands

Commands are workflows you invoke with `/command_name`:

**Development Workflow:**

- **/research-codebase** - Document existing system with parallel sub-agents
- **/create-plan** - Interactive planning with research
- **/implement-plan** - Execute approved plans
- **/validate-plan** - Verify implementation

**Workflow Discovery:**

- **/discover-workflows** - Research external Claude Code repositories
- **/import-workflow** - Import and adapt external workflows
- **/create-workflow** - Create new agents/commands with templates
- **/validate-frontmatter** - Ensure frontmatter consistency

**Utilities:**

- **/create-worktree** - Set up parallel work environment
- **/commit** - Create well-structured git commits
- **/describe-pr** - Generate comprehensive PR descriptions
- **/debug** - Investigate logs, database, and git state
- **/linear** - Linear ticket integration (if configured)

### Thoughts System

A git-backed context management system:

```
~/thoughts/                  # Central repo (version controlled)
├── repos/
│   └── my-project/
│       ├── ryan/           # Your personal notes
│       └── shared/         # Team-shared
│           ├── plans/      # Implementation plans
│           ├── research/   # Research documents
│           ├── tickets/    # Ticket details
│           └── prs/        # PR descriptions
└── global/                 # Cross-repository thoughts
```

Benefits:

- **Persistent** - Context survives across worktrees
- **Searchable** - Fast grep via searchable/ directory
- **Version controlled** - All context is tracked in git
- **Collaborative** - shared/ for team knowledge

## Documentation

### Quick Links

- **[hack/README.md](hack/README.md)** - Installation scripts, setup workflows, troubleshooting
- **[commands/README.md](commands/README.md)** - Command types, frontmatter, installation behavior
- **[agents/README.md](agents/README.md)** - Agent philosophy, specializations, usage patterns
- **[docs/README.md](docs/README.md)** - Complete documentation index and guide

### Essential Guides

- [docs/USAGE.md](docs/USAGE.md) - Comprehensive usage guide
- [docs/BEST_PRACTICES.md](docs/BEST_PRACTICES.md) - Recommended workflows and patterns
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) - Configuration system details
- [docs/AGENTIC_WORKFLOW_GUIDE.md](docs/AGENTIC_WORKFLOW_GUIDE.md) - Agent patterns and best practices
- [docs/CONTEXT_ENGINEERING.md](docs/CONTEXT_ENGINEERING.md) - Context management strategies
- [docs/LINEAR_WORKFLOW_AUTOMATION.md](docs/LINEAR_WORKFLOW_AUTOMATION.md) - Linear integration guide

### All Documentation

See [docs/README.md](docs/README.md) for the complete documentation index organized by category (Setup, Workflow, Integrations, Technical).

## Installation Modes

### User Installation (Recommended)

Installs to `~/.claude/` - available in all projects:

```bash
./hack/install-user.sh
```

### Project Installation

Installs to `.claude/` in a specific project:

```bash
./hack/install-project.sh /path/to/project
```

**What gets installed:**

- All 6 agents
- 13 portable commands (excludes 5 workspace-only commands)
- Configuration template
- Metadata for version tracking
- **Note**: README.md files are excluded (they're documentation, not agents/commands)

**Workspace-only commands** (excluded from project installs):

- `/validate-frontmatter` - Workspace validation
- `/update-project` - Workspace management
- `/discover-workflows` - Workflow catalog building
- `/import-workflow` - Import to workspace
- `/create-workflow` - Create in workspace

See [commands/README.md](commands/README.md) for details on command types.

### Hybrid Approach

- Install core agents/commands to user directory
- Override with project-specific versions as needed
- Claude Code prioritizes project `.claude/` over user `~/.claude/`

## Portability

This workspace is designed to be portable across:

- **Projects** - Import into any codebase
- **Machines** - Git clone and run setup scripts
- **Teams** - Share agents/commands via git

To use in a new project:

```bash
cd /path/to/new-project
ryan-init-project new-project
```

The thoughts system automatically syncs context across all your worktrees.

## Updating Projects from Workspace

When you improve the workspace, easily update your projects:

```bash
# From workspace directory
./hack/update-project.sh /path/to/project

# Or use slash command
/update-project /path/to/project
```

**Smart updating**:

- ✅ Preserves local customizations (config values, configured commands)
- ✅ Intelligently merges config.json (workspace structure + local values)
- ✅ Auto-updates agents (pure logic, no customization)
- ✅ Prompts for conflicts (you decide what to keep)
- ✅ Creates backups automatically
- ✅ Tracks versions and detects drift

**Example workflow**:

1. Improve agents/commands in workspace
2. Commit workspace changes
3. Run `update-project.sh` on each project
4. Local configs preserved, improvements applied
5. Team shares updates via git

## Using the Workspace on Itself

This workspace "eats its own dog food" - the commands and agents are installed into `.claude/` so you can use them while working on the workspace itself!

**What this means**:

- You can use `/workflow-help` to learn about workflows
- You can use `/create-plan` to plan new features
- You can use `/research-codebase` to understand the workspace structure
- All agents and commands work on this codebase

**Source vs Installation**:

- `agents/*.md` - Source files (edit these)
- `commands/*.md` - Source files (edit these)
- `.claude/agents/*.md` - Installed copies (used by Claude Code)
- `.claude/commands/*.md` - Installed copies (used by Claude Code)

**After editing source files**:
The `.claude/` copies are automatically synced since they're in the same repo. Just restart Claude Code to pick up changes.

## Contributing

### Code Quality

All code must pass quality checks before merging:

```bash
# Run all quality checks
make check

# Fix formatting issues
make format

# Validate frontmatter
make check-frontmatter
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

### What Gets Checked

- ✅ **Shellcheck** - Shell script linting
- ✅ **Markdownlint** - Markdown formatting
- ✅ **Frontmatter validation** - Command/agent frontmatter
- ✅ **Prettier** - Code formatting
- ✅ **YAML linting** - Configuration files

## Customization

### Adding Your Own Agents

1. Create `agents/my-agent.md` following the format
2. Add required frontmatter (name, description, tools)
3. Run `make check` to validate
4. Run `./hack/install-user.sh` to install
5. Test with: `@agent-my-agent help with this task`

### Adding Your Own Commands

1. Create `commands/{namespace}/my_command.md` following the format
2. Add required frontmatter (description, category)
3. Run `make check` to validate
4. Run `./hack/install-user.sh` to install
5. Test with: `/my_command`

See [PATTERNS.md](docs/PATTERNS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

## Credits

Patterns adapted from:

- [HumanLayer's researcher codebase](https://github.com/humanlayer/humanlayer)
- [Anthropic's Context Engineering Guide](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Claude Code Subagents Collection](https://github.com/davepoon/claude-code-subagents-collection)

## License

MIT - Adapt and modify as needed for your workflow
