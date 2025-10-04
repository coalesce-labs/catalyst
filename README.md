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
./scripts/setup-thoughts.sh

# This creates:
# ~/thoughts/
# ├── repos/         # Per-repository thoughts
# └── global/        # Cross-repository thoughts
```

### 2. Install Agents & Commands

```bash
# Install to user directory (available in all projects)
./scripts/install-user.sh

# Or install to specific project
./scripts/install-project.sh /path/to/project
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
./scripts/create-worktree.sh ENG-123 feature-name

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
./scripts/create-worktree.sh PROJ-456 oauth-support
cd ~/wt/my-project/oauth-support
/implement-plan thoughts/shared/plans/2025-01-08-PROJ-456-oauth-support.md
→ Code changes + tests

# 4. Validate implementation
/validate-plan
→ All tests pass, manual verification steps listed

# 5. Commit and create PR
/commit
gh pr create --fill
/describe-pr
```

## Directory Structure

```
ryan-claude-workspace/
├── agents/                  # Specialized Claude agents
│   ├── codebase-locator.md
│   ├── codebase-analyzer.md
│   ├── thoughts-locator.md
│   └── ...
├── commands/                # Slash commands for workflows
│   ├── create_plan.md
│   ├── implement_plan.md
│   ├── validate_plan.md
│   └── create_worktree.md
├── scripts/                 # Setup and installation scripts
│   ├── setup-thoughts.sh
│   ├── install-user.sh
│   ├── install-project.sh
│   └── create-worktree.sh
├── docs/                    # Documentation and guides
│   ├── USAGE.md
│   ├── BEST_PRACTICES.md
│   ├── PATTERNS.md
│   └── CONTEXT_ENGINEERING.md
└── README.md
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

- [Usage Guide](docs/USAGE.md) - Detailed usage instructions
- [Best Practices](docs/BEST_PRACTICES.md) - Patterns that work
- [Agent Patterns](docs/PATTERNS.md) - Creating effective agents
- [Context Engineering](docs/CONTEXT_ENGINEERING.md) - Managing context effectively

## Installation Modes

### User Installation (Recommended)

Installs to `~/.claude/` - available in all projects:

```bash
./scripts/install-user.sh
```

### Project Installation

Installs to `.claude/` in a specific project:

```bash
./scripts/install-project.sh /path/to/project
```

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

## Customization

### Adding Your Own Agents

1. Create `agents/my-agent.md` following the format
2. Run `./scripts/install-user.sh` to install
3. Test with: `@agent-my-agent help with this task`

### Adding Your Own Commands

1. Create `commands/my_command.md` following the format
2. Run `./scripts/install-user.sh` to install
3. Test with: `/my_command`

See [PATTERNS.md](docs/PATTERNS.md) for detailed guidelines.

## Credits

Patterns adapted from:
- [HumanLayer's researcher codebase](https://github.com/humanlayer/humanlayer)
- [Anthropic's Context Engineering Guide](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Claude Code Subagents Collection](https://github.com/davepoon/claude-code-subagents-collection)

## License

MIT - Adapt and modify as needed for your workflow
