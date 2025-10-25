---
date: 2025-10-25T19:15:00+0000
author: Claude
repository: catalyst (formerly ryan-claude-workspace)
topic: "Catalyst Final Plugin Structure"
tags: [final, plugins, architecture, organization]
status: aligned
---

# Catalyst Final Plugin Structure

## Overview

Based on alignment discussion, Catalyst will have **4 plugins** organized around clear functional boundaries:

1. **catalyst-research** - Deep codebase understanding (THE differentiator)
2. **catalyst-dev** - Complete development workflow (research → plan → implement → validate → PR → merge)
3. **catalyst-handoff** - Context management
4. **catalyst-meta** - Workflow discovery and creation tools (inspiration/best practices)

## Key Decisions Made

✅ **Simplified structure**: Consolidated 7 proposals → 4 focused plugins
✅ **Removed /update-project**: Plugin-based installs only, no script-based distribution
✅ **All workflow commands in dev**: Research, planning, implementation, validation, commits, PRs all under catalyst-dev
✅ **No PM plugin yet**: Current workspace doesn't have true PM functionality to package
✅ **Meta is for inspiration**: Commands for discovering/creating workflows, learning best practices

---

## Plugin 1: catalyst-research ⭐

**Tagline**: "Deep codebase understanding with specialized AI agents"

**Purpose**: The differentiator - comprehensive research agents that understand codebases

**What it contains**:
- **6 agents**:
  - `codebase-locator` - Find WHERE code lives
  - `codebase-analyzer` - Understand HOW code works
  - `codebase-pattern-finder` - Find existing patterns to follow
  - `thoughts-locator` - Discover previous research/plans
  - `thoughts-analyzer` - Extract insights from documents
  - `external-research` - Research external repos/frameworks
- **1 command**: `/research-codebase`
- **1 script**: `scripts/check-prerequisites.sh`

**Who uses it**: Any developer needing to understand code

**When used**: Before making changes, onboarding, learning codebase

**Dependencies**: None (fully self-contained)

**Value proposition**: "Most plugins provide commands. Catalyst provides comprehensive research agents that actually understand your codebase."

---

## Plugin 2: catalyst-dev

**Tagline**: "Research-driven development workflow from research to production"

**Purpose**: Complete development lifecycle - research, plan, implement, validate, PR, merge

**What it contains**:

### Commands (13 total):

**Workflow Phase Commands**:
- `/research-codebase` - Comprehensive research (spawns research agents)
- `/create-plan` - Interactive implementation planning
- `/implement-plan` - Execute approved plans
- `/validate-plan` - Verify implementation completeness

**Daily Development Commands**:
- `/commit` - Smart conventional commits
- `/describe-pr` - Generate/update PR descriptions
- `/debug` - Systematic debugging investigation

**Linear Integration Commands**:
- `/linear` - Ticket management and workflow automation
- `/linear-setup-workflow` - Setup Linear workflow statuses
- `/create-pr` - Create PR with Linear integration
- `/merge-pr` - Merge PR with verification and Linear updates

**Project Management Commands**:
- `/create-worktree` - Create git worktree for parallel work

**Utility Commands**:
- `/workflow-help` - Interactive workflow guidance

### Scripts:
- `scripts/check-prerequisites.sh` - Validate tools (HumanLayer CLI, jq, etc.)
- `scripts/create-worktree.sh` - Worktree creation logic
- `scripts/frontmatter-utils.sh` - YAML parsing utilities

**Who uses it**: All developers - junior to senior

**When used**: Complete development lifecycle

**Dependencies**:
- Optional: catalyst-research (works better with it, but can work alone)
- Optional: Linear MCP (for Linear integration features)
- Optional: HumanLayer CLI (for thoughts system)

**Value proposition**: "Everything you need from idea to production - research, plan, implement, validate, commit, PR, merge with optional Linear automation"

**Note**: This is deliberately comprehensive - one plugin for the complete workflow

---

## Plugin 3: catalyst-handoff

**Tagline**: "Context persistence across sessions"

**Purpose**: Save and restore work context when pausing/resuming

**What it contains**:
- **2 commands**:
  - `/create-handoff` - Create handoff document (pause work)
  - `/resume-handoff` - Resume from handoff (restore context)
- **1 script**: `scripts/check-prerequisites.sh`

**Who uses it**: Developers hitting context limits, switching contexts frequently

**When used**: When pausing work, when resuming work

**Dependencies**:
- Optional: HumanLayer CLI (for thoughts system integration)

**Value proposition**: "Never lose context. Pause and resume work seamlessly."

---

## Plugin 4: catalyst-meta

**Tagline**: "Discover, create, and validate workflows"

**Purpose**: Tools for learning workflow best practices and creating new workflows

**What it contains**:
- **5 commands**:
  - `/discover-workflows` - Research external Claude Code repos for patterns
  - `/import-workflow` - Import and adapt workflows from external repos
  - `/create-workflow` - Create new agents/commands using patterns
  - `/validate-frontmatter` - Validate frontmatter consistency
  - `/workflow-help` - Interactive workflow guidance (DUPLICATE from catalyst-dev)
- **1 script**: `scripts/validate-frontmatter.sh` (for Trunk linter)

**Who uses it**:
- Developers looking for inspiration
- Workspace architects creating new workflows
- Anyone learning best practices

**When used**:
- Learning how other teams structure workflows
- Creating new capabilities
- Maintaining workspace quality

**Dependencies**: None

**Value proposition**: "Learn from the community and create your own workflows using proven patterns"

**Accessibility**: Publicly available (not workspace-only) - anyone can use these for inspiration

**Note**: `/workflow-help` is intentionally duplicated in both catalyst-dev and catalyst-meta for convenience

---

## Removed Components

### ❌ /update-project (Command)
**Why removed**: Moving to plugin-based installs only. No need for script-based distribution mechanism.

**Migration path**: Users install via `/plugin install catalyst-dev@catalyst` instead of running `./hack/update-project.sh`

### ❌ update-project.sh (Script)
**Why removed**: Not needed with plugin distribution

### ❌ catalyst-pm Plugin
**Why removed**: Current workspace doesn't have true PM-specific functionality. `/create-worktree` moved to catalyst-dev.

**Future**: May create catalyst-pm later if PM-specific features emerge (e.g., sprint planning, capacity management, reporting)

---

## Scripts Organization

### Scripts in Plugins

**Duplicated in multiple plugins**:
- `check-prerequisites.sh` → In research, dev, handoff (3 copies)
  - Small file (~100 lines)
  - Validates HumanLayer CLI, jq, thoughts system
  - Self-contained plugins (no shared dependencies)

**Dev plugin only**:
- `create-worktree.sh` → Called by `/create-worktree`
- `frontmatter-utils.sh` → Utility functions for YAML parsing

**Meta plugin only**:
- `validate-frontmatter.sh` → Used by Trunk linter integration

### Scripts Staying at Workspace Root (hack/)

**Installation & setup** (not packaged in plugins):
- `install-user.sh` - Legacy: install to ~/.claude/
- `install-project.sh` - Legacy: install to project .claude/
- `setup-thoughts.sh` - Initialize ~/thoughts/
- `init-project.sh` - Project-level thoughts setup
- `setup-multi-config.sh` - Multi-client configuration
- `add-client-config` - Add new client config
- `setup-linear-workflow` - Linear setup utility
- `hl-switch` - Config switcher

**Rationale**: Migration tools and setup utilities for workspace maintainers

---

## Plugin Structure on Disk

```
catalyst/
├── .claude-plugin/
│   └── marketplace.json              # Marketplace catalog
│
├── plugins/
│   ├── research/                     # Plugin 1: catalyst-research
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── agents/
│   │   │   ├── codebase-locator.md
│   │   │   ├── codebase-analyzer.md
│   │   │   ├── codebase-pattern-finder.md
│   │   │   ├── thoughts-locator.md
│   │   │   ├── thoughts-analyzer.md
│   │   │   └── external-research.md
│   │   ├── commands/
│   │   │   └── research_codebase.md
│   │   └── scripts/
│   │       ├── check-prerequisites.sh
│   │       └── README.md
│   │
│   ├── dev/                          # Plugin 2: catalyst-dev
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   │   ├── research_codebase.md
│   │   │   ├── create_plan.md
│   │   │   ├── implement_plan.md
│   │   │   ├── validate_plan.md
│   │   │   ├── commit.md
│   │   │   ├── describe_pr.md
│   │   │   ├── debug.md
│   │   │   ├── linear.md
│   │   │   ├── linear_setup_workflow.md
│   │   │   ├── create_pr.md
│   │   │   ├── merge_pr.md
│   │   │   ├── create_worktree.md
│   │   │   └── workflow_help.md
│   │   └── scripts/
│   │       ├── check-prerequisites.sh
│   │       ├── create-worktree.sh
│   │       ├── frontmatter-utils.sh
│   │       └── README.md
│   │
│   ├── handoff/                      # Plugin 3: catalyst-handoff
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   │   ├── create_handoff.md
│   │   │   └── resume_handoff.md
│   │   └── scripts/
│   │       ├── check-prerequisites.sh
│   │       └── README.md
│   │
│   └── meta/                         # Plugin 4: catalyst-meta
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── commands/
│       │   ├── discover_workflows.md
│       │   ├── import_workflow.md
│       │   ├── create_workflow.md
│       │   ├── validate_frontmatter.md
│       │   └── workflow_help.md        # Duplicate of dev/workflow_help.md
│       └── scripts/
│           ├── validate-frontmatter.sh
│           └── README.md
│
├── hack/                             # Migration tools (not in plugins)
│   ├── install-user.sh
│   ├── install-project.sh
│   ├── setup-thoughts.sh
│   ├── init-project.sh
│   ├── setup-multi-config.sh
│   ├── add-client-config
│   ├── setup-linear-workflow
│   ├── hl-switch
│   └── README.md
│
├── docs/                             # Documentation
│   ├── README.md
│   ├── MIGRATION.md
│   └── ...
│
├── .claude/                          # Local development config
│   ├── settings.json
│   └── config.json
│
└── README.md                         # Marketplace overview
```

---

## User Personas & Plugin Mapping

### Persona 1: **Junior/Mid Developer**
**Installs**: `catalyst-research` + `catalyst-dev`

**Why**: Understand codebases, implement features, make commits, create PRs

**Workflow**: Research → implement → commit → PR

---

### Persona 2: **Senior Developer / Tech Lead**
**Installs**: `catalyst-research` + `catalyst-dev` + `catalyst-handoff`

**Why**: Full workflow with planning, complex features requiring context management

**Workflow**: Research → plan → implement → validate → commit → PR → merge, using handoffs for context

---

### Persona 3: **Developer Learning Workflow Patterns**
**Installs**: `catalyst-meta` + `catalyst-research`

**Why**: Discover how other teams build workflows, get inspiration

**Workflow**: Discover external patterns → research local code → create new workflows

---

### Persona 4: **Workspace Architect**
**Installs**: All plugins

**Why**: Building and maintaining workspace

**Workflow**: Discover → import → create → validate → distribute

---

## Installation Scenarios

### Scenario 1: "I just want to understand codebases"
```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-research@catalyst
```
**Gets**: 6 research agents + /research-codebase command

---

### Scenario 2: "I want the full development workflow"
```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev@catalyst
```
**Gets**: Complete workflow - research, plan, implement, validate, commit, PR, merge

**Note**: This includes `/research-codebase` which uses the research agents, but agents live in catalyst-research plugin

**Question**: Should catalyst-dev declare catalyst-research as a dependency?

---

### Scenario 3: "I hit context limits frequently"
```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev@catalyst
/plugin install catalyst-handoff@catalyst
```
**Gets**: Full workflow + context management

---

### Scenario 4: "I want to learn and create workflows"
```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-meta@catalyst
```
**Gets**: Workflow discovery, import, creation, validation tools

---

## Plugin Dependencies

### catalyst-research
- **Dependencies**: None
- **Fully self-contained**

### catalyst-dev
- **Hard dependencies**: None (works standalone)
- **Soft dependencies**:
  - catalyst-research (optional) - `/research-codebase` spawns research agents. If research plugin not installed, command will fail when trying to spawn agents.
  - Linear MCP (optional) - Linear commands require MCP server
  - HumanLayer CLI (optional) - Thoughts system features require CLI

**Question to resolve**: Should we make catalyst-research a required dependency, or document it as optional with graceful failure?

### catalyst-handoff
- **Dependencies**: None (works without thoughts system, just less powerful)

### catalyst-meta
- **Dependencies**: None

---

## Key Architectural Decisions

### Decision 1: /research-codebase in dev Plugin
**Problem**: `/research-codebase` command spawns agents from catalyst-research plugin

**Options**:
1. Keep command in dev, agents in research (current proposal)
2. Duplicate command in both plugins
3. Only in research plugin

**Decision needed**: Which approach?

**Recommendation**: Keep in dev plugin, document that catalyst-research is strongly recommended. Graceful failure message if research agents not available.

---

### Decision 2: workflow-help Duplication
**Status**: Decided - intentionally duplicate in both catalyst-dev and catalyst-meta

**Rationale**:
- Dev users need workflow guidance
- Meta users learning to create workflows need guidance
- Small command, duplication acceptable for convenience

---

### Decision 3: No PM Plugin Yet
**Status**: Decided - no catalyst-pm plugin in v1.0

**Rationale**: Current workspace doesn't have PM-specific functionality. `/create-worktree` is a dev tool (parallel feature work).

**Future**: Create catalyst-pm if/when PM features emerge (sprint planning, capacity management, team reporting)

---

## Marketplace Structure

### marketplace.json

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "catalyst",
  "version": "1.0.0",
  "description": "Production-ready AI-assisted development workflows from Coalesce Labs",
  "owner": {
    "name": "Coalesce Labs",
    "url": "https://github.com/coalesce-labs"
  },
  "metadata": {
    "description": "Catalyst: Research-driven development workflow with specialized AI agents",
    "homepage": "https://github.com/coalesce-labs/catalyst",
    "pluginRoot": "./plugins"
  },
  "plugins": [
    {
      "name": "catalyst-research",
      "source": "./plugins/research",
      "description": "Deep codebase understanding with specialized AI agents: locate, analyze, and document existing code",
      "version": "1.0.0",
      "category": "development",
      "keywords": ["research", "analysis", "agents", "codebase", "documentation"],
      "featured": true
    },
    {
      "name": "catalyst-dev",
      "source": "./plugins/dev",
      "description": "Complete development workflow: research → plan → implement → validate → commit → PR → merge with optional Linear automation",
      "version": "1.0.0",
      "category": "development",
      "keywords": ["workflow", "planning", "implementation", "validation", "git", "linear", "pr"]
    },
    {
      "name": "catalyst-handoff",
      "source": "./plugins/handoff",
      "description": "Context persistence: save and restore work across sessions to manage context limits",
      "version": "1.0.0",
      "category": "productivity",
      "keywords": ["context", "handoff", "persistence", "sessions"]
    },
    {
      "name": "catalyst-meta",
      "source": "./plugins/meta",
      "description": "Discover, import, and create workflows: learn from community patterns and extend Catalyst",
      "version": "1.0.0",
      "category": "development",
      "keywords": ["meta", "discovery", "creation", "validation", "best-practices"]
    }
  ]
}
```

---

## Bundle Recommendations

### "Essentials" (Recommended for most developers)
```bash
/plugin install catalyst-dev@catalyst
```
**Includes**: Complete workflow from research to production

**Optional add-on**: `catalyst-handoff` if hitting context limits

---

### "Full Suite" (Power users)
```bash
/plugin install catalyst-research@catalyst
/plugin install catalyst-dev@catalyst
/plugin install catalyst-handoff@catalyst
/plugin install catalyst-meta@catalyst
```
**Includes**: Everything

---

### "Workflow Learning" (Learning best practices)
```bash
/plugin install catalyst-meta@catalyst
```
**Includes**: Discovery and creation tools

---

## Migration Checklist

- [ ] Create plugin directory structure (4 plugins)
- [ ] Move commands to appropriate plugins
- [ ] Copy agents to research plugin
- [ ] Duplicate check-prerequisites.sh to 3 plugins
- [ ] Copy create-worktree.sh to dev plugin
- [ ] Copy frontmatter-utils.sh to dev plugin
- [ ] Copy validate-frontmatter.sh to meta plugin
- [ ] Update all command script references to use ${CLAUDE_PLUGIN_ROOT}
- [ ] Make all scripts executable (chmod +x)
- [ ] Create plugin.json for each plugin (4 files)
- [ ] Create marketplace.json at root
- [ ] Add scripts/README.md to each plugin
- [ ] Remove /update-project from commands
- [ ] Test each plugin independently
- [ ] Test plugin combinations
- [ ] Update documentation (README, MIGRATION.md)
- [ ] Verify Linear integration works
- [ ] Verify thoughts system integration works
- [ ] Tag v1.0.0 release

---

## Open Questions for Final Alignment

### Question 1: /research-codebase Command Location

**Issue**: `/research-codebase` command is in catalyst-dev but spawns agents from catalyst-research

**Options**:
1. Keep in dev, document research plugin as strongly recommended
2. Duplicate in both plugins
3. Move to research plugin only

**Your preference**: _________________

---

### Question 2: Research Plugin as Dependency

**Issue**: catalyst-dev uses research agents

**Options**:
1. Hard dependency (catalyst-dev requires catalyst-research)
2. Soft dependency (works without it, graceful failure)
3. No dependency (users figure it out)

**Your preference**: _________________

---

### Question 3: Plugin Versioning

**Issue**: Should all 4 plugins version together or independently?

**Options**:
1. Independent (catalyst-research v1.2.0, catalyst-dev v1.0.1)
2. Synchronized (all plugins always same version)
3. Major together, minor independent

**Your preference**: _________________

---

## Summary

**4 Plugins**:
1. `catalyst-research` (6 agents, 1 command) ⭐ THE DIFFERENTIATOR
2. `catalyst-dev` (13 commands, 3 scripts) - COMPLETE WORKFLOW
3. `catalyst-handoff` (2 commands, 1 script) - CONTEXT MANAGEMENT
4. `catalyst-meta` (5 commands, 1 script) - WORKFLOW INSPIRATION

**Removed**:
- /update-project (plugin-based installs only)
- catalyst-pm (no PM functionality yet)

**Key characteristics**:
- **Simplified**: 4 focused plugins vs 7 fragmented ones
- **Complete**: catalyst-dev has everything for full workflow
- **Independent**: Each plugin works standalone
- **Composable**: Work better together
- **Practical**: Organized around what devs actually do

**Ready for**: `/create-plan` phase once final questions resolved
