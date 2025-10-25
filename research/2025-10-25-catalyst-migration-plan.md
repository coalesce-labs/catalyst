---
date: 2025-10-25T18:35:00+0000
author: Claude
repository: ryan-claude-workspace → catalyst
topic: "Migration Plan: Restructuring ryan-claude-workspace to Catalyst Multi-Plugin Marketplace"
tags: [planning, migration, catalyst, plugins, restructure]
status: draft
---

# Migration Plan: ryan-claude-workspace → Catalyst

## Overview

Restructure the monolithic `ryan-claude-workspace` into `catalyst`, a multi-plugin marketplace that provides focused, composable development workflows.

**Key changes:**
1. Rename repository: `ryan-claude-workspace` → `catalyst`
2. Split into 5 focused plugins: `dev`, `pm`, `research`, `workflow`, `handoff`
3. Create marketplace structure for distribution
4. Maintain backward compatibility with existing installations

## Proposed Structure

```
catalyst/
├── .claude-plugin/
│   └── marketplace.json              # Marketplace catalog
├── plugins/
│   ├── dev/                          # Development workflows plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   └── commands/
│   │       ├── commit.md
│   │       ├── debug.md
│   │       └── describe_pr.md
│   │
│   ├── pm/                           # Project management plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   └── commands/
│   │       ├── linear.md
│   │       ├── linear_setup_workflow.md
│   │       ├── create_pr.md
│   │       ├── merge_pr.md
│   │       ├── create_worktree.md
│   │       └── update_project.md
│   │
│   ├── research/                     # Research & analysis plugin ⭐ Core value
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
│   │   └── skills/                   # Optional: autonomous capabilities
│   │       ├── analyze-code/
│   │       │   └── SKILL.md
│   │       └── find-patterns/
│   │           └── SKILL.md
│   │
│   ├── workflow/                     # Planning & implementation plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   └── commands/
│   │       ├── create_plan.md
│   │       ├── implement_plan.md
│   │       └── validate_plan.md
│   │
│   └── handoff/                      # Context management plugin
│       ├── .claude-plugin/
│       │   └── plugin.json
│       └── commands/
│           ├── create_handoff.md
│           └── resume_handoff.md
│
├── meta/                             # Workspace-only tools (not plugin)
│   └── commands/
│       ├── validate_frontmatter.md
│       ├── discover_workflows.md
│       ├── import_workflow.md
│       ├── create_workflow.md
│       └── workflow_help.md
│
├── .claude/                          # Local development config
│   ├── settings.json                 # Enable local plugins
│   └── config.json                   # Development values
│
├── hack/                             # Installation scripts (backward compat)
│   ├── install-user.sh
│   ├── install-project.sh
│   ├── update-project.sh
│   └── ...
│
├── docs/                             # Documentation
│   ├── README.md                     # Main docs
│   ├── MIGRATION.md                  # Upgrade guide
│   └── ...
│
└── README.md                         # Marketplace overview
```

## Plugin Breakdown

### 1. `dev` - Development Workflows

**Purpose**: Daily development tasks - commits, debugging, PR descriptions

**Commands:**
- `/commit` - Smart git commit with AI-generated messages
- `/debug` - Systematic debugging workflow
- `/describe-pr` - Generate PR descriptions

**Target users**: All developers

**plugin.json:**
```json
{
  "name": "catalyst-dev",
  "description": "AI-powered development workflows: smart commits, debugging, and PR descriptions",
  "version": "1.0.0",
  "keywords": ["git", "commit", "debug", "pr", "development"]
}
```

### 2. `pm` - Project Management

**Purpose**: Project-level operations - Linear integration, worktrees, project updates

**Commands:**
- `/linear` - Ticket management
- `/linear-setup-workflow` - Configure Linear integration
- `/create-pr` - Create pull requests
- `/merge-pr` - Merge pull requests
- `/create-worktree` - Parallel work environments
- `/update-project` - Update project from workspace

**Target users**: Teams using Linear, developers managing multiple features

**plugin.json:**
```json
{
  "name": "catalyst-pm",
  "description": "Project management workflows: Linear integration, worktrees, and project updates",
  "version": "1.0.0",
  "keywords": ["linear", "project-management", "worktree", "pr"]
}
```

### 3. `research` - Research & Analysis ⭐

**Purpose**: Deep codebase understanding - THE core value proposition

**Agents:**
- `codebase-locator` - Find files and components
- `codebase-analyzer` - Understand how code works
- `codebase-pattern-finder` - Find existing patterns
- `thoughts-locator` - Search historical context
- `thoughts-analyzer` - Extract insights from docs
- `external-research` - Query external resources

**Commands:**
- `/research-codebase` - Comprehensive research workflow

**Skills (optional):**
- `analyze-code` - Autonomous code analysis
- `find-patterns` - Autonomous pattern discovery

**Target users**: Anyone needing to understand existing codebases

**plugin.json:**
```json
{
  "name": "catalyst-research",
  "description": "Deep codebase research with specialized agents: find, analyze, and document existing code",
  "version": "1.0.0",
  "keywords": ["research", "analysis", "agents", "codebase", "documentation"]
}
```

**This is the differentiator** - most plugins provide commands, few provide comprehensive research agents.

### 4. `workflow` - Planning & Implementation

**Purpose**: Structured development - plan → implement → validate

**Commands:**
- `/create-plan` - Implementation planning with research integration
- `/implement-plan` - Execute planned changes
- `/validate-plan` - Verify implementation

**Target users**: Developers following structured workflows

**plugin.json:**
```json
{
  "name": "catalyst-workflow",
  "description": "Structured development workflow: research-driven planning, implementation, and validation",
  "version": "1.0.0",
  "keywords": ["planning", "implementation", "validation", "workflow"]
}
```

### 5. `handoff` - Context Management

**Purpose**: Preserve and restore work context across sessions

**Commands:**
- `/create-handoff` - Save context for later
- `/resume-handoff` - Restore saved context

**Target users**: Developers switching contexts frequently

**plugin.json:**
```json
{
  "name": "catalyst-handoff",
  "description": "Context persistence: save and restore work across sessions",
  "version": "1.0.0",
  "keywords": ["context", "handoff", "persistence", "sessions"]
}
```

## Marketplace Structure

### Main marketplace.json

**Location**: `.claude-plugin/marketplace.json`

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "catalyst",
  "version": "1.0.0",
  "description": "Production-ready AI-assisted development workflows from Coalesce Labs",
  "owner": {
    "name": "Coalesce Labs",
    "email": "contact@coalesce-labs.com",
    "url": "https://github.com/coalesce-labs"
  },
  "metadata": {
    "description": "Catalyst accelerates development with AI-powered research, planning, and implementation workflows",
    "homepage": "https://github.com/coalesce-labs/catalyst",
    "pluginRoot": "./plugins"
  },
  "plugins": [
    {
      "name": "catalyst-dev",
      "source": "./plugins/dev",
      "description": "AI-powered development workflows: smart commits, debugging, and PR descriptions",
      "version": "1.0.0",
      "category": "development",
      "keywords": ["git", "commit", "debug", "pr"]
    },
    {
      "name": "catalyst-pm",
      "source": "./plugins/pm",
      "description": "Project management workflows: Linear integration, worktrees, and project updates",
      "version": "1.0.0",
      "category": "productivity",
      "keywords": ["linear", "project-management", "worktree"]
    },
    {
      "name": "catalyst-research",
      "source": "./plugins/research",
      "description": "Deep codebase research with specialized agents: find, analyze, and document existing code",
      "version": "1.0.0",
      "category": "development",
      "keywords": ["research", "analysis", "agents", "codebase"],
      "featured": true
    },
    {
      "name": "catalyst-workflow",
      "source": "./plugins/workflow",
      "description": "Structured development workflow: research-driven planning, implementation, and validation",
      "version": "1.0.0",
      "category": "development",
      "keywords": ["planning", "implementation", "validation"]
    },
    {
      "name": "catalyst-handoff",
      "source": "./plugins/handoff",
      "description": "Context persistence: save and restore work across sessions",
      "version": "1.0.0",
      "category": "productivity",
      "keywords": ["context", "handoff", "persistence"]
    }
  ]
}
```

## User Experience

### Installation

**Install all plugins:**
```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-research@catalyst
/plugin install catalyst-workflow@catalyst
/plugin install catalyst-dev@catalyst
/plugin install catalyst-pm@catalyst
/plugin install catalyst-handoff@catalyst
```

**Install selectively:**
```bash
# Just research agents (most unique value)
/plugin install catalyst-research@catalyst

# Add planning workflow
/plugin install catalyst-workflow@catalyst

# Add Linear integration
/plugin install catalyst-pm@catalyst
```

**Full workflow:**
```bash
# 1. Add marketplace
/plugin marketplace add coalesce-labs/catalyst

# 2. Browse available plugins
/plugin

# 3. Install what you need
/plugin install catalyst-research@catalyst

# 4. Use commands
/research-codebase
```

### Command Discovery

Commands appear with plugin context:

```
/help

Available commands:
  /research-codebase (catalyst-research) - Comprehensive codebase research
  /create-plan (catalyst-workflow) - Create implementation plan
  /commit (catalyst-dev) - Smart git commit
  /linear (catalyst-pm) - Manage Linear tickets
  /create-handoff (catalyst-handoff) - Save context
```

### Upgrade Path for Existing Users

**Option 1: Plugin installation (recommended)**
```bash
# Remove old installation
rm -rf ~/.claude/agents ~/.claude/commands

# Install via marketplace
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-research@catalyst
/plugin install catalyst-workflow@catalyst
```

**Option 2: Script installation (legacy)**
```bash
# Continue using existing scripts
./hack/install-project.sh /path/to/project

# Note: Scripts will be deprecated in v2.0.0
```

## Migration Steps

### Phase 1: Repository Restructure (Breaking Change)

**Actions:**
1. Create `plugins/` directory structure
2. Move agents and commands to plugin subdirectories
3. Create plugin.json for each plugin
4. Create root marketplace.json
5. Update hack/ scripts to understand new structure
6. Update all documentation

**Git operations:**
```bash
# Rename repo on GitHub first
# Then locally:
git remote set-url origin https://github.com/coalesce-labs/catalyst.git
git fetch origin
git branch -u origin/main main
```

**Estimated effort**: 4-6 hours

**Risk**: High (structure changes), mitigated by clear migration docs

### Phase 2: Documentation Update

**Actions:**
1. Update README.md with new structure and branding
2. Create MIGRATION.md for existing users
3. Update all docs/ files with new names
4. Update CLAUDE.md with plugin architecture
5. Add plugin installation examples

**Estimated effort**: 2-3 hours

### Phase 3: Test & Validate

**Actions:**
1. Test local marketplace installation
2. Test each plugin individually
3. Test plugin combinations
4. Verify backward compatibility with scripts
5. Test on clean installation

**Estimated effort**: 3-4 hours

### Phase 4: Release

**Actions:**
1. Tag v1.0.0 release
2. Publish to GitHub
3. Announce in community channels
4. Monitor issues and feedback

**Estimated effort**: 1-2 hours

### Phase 5: Community (Ongoing)

**Actions:**
1. Submit to community plugin directories
2. Create examples and tutorials
3. Gather feedback and iterate
4. Consider adding more plugins

## Benefits of Multi-Plugin Architecture

### For Users

✅ **Composability**: Install only what you need
✅ **Clear boundaries**: Each plugin has focused purpose
✅ **Easier updates**: Update individual plugins without affecting others
✅ **Discovery**: Browse and find relevant plugins
✅ **Dependencies**: Can install research plugin alone, or add workflow on top

### For Maintenance

✅ **Modularity**: Changes to one plugin don't affect others
✅ **Independent versioning**: Different plugins can evolve at different rates
✅ **Testing**: Test plugins in isolation
✅ **Contributions**: Easier for community to contribute to specific plugins

### For Branding

✅ **Professional**: Multi-plugin marketplace signals maturity
✅ **Showcase value**: Research plugin stands out as unique offering
✅ **Expansion**: Easy to add new plugins under catalyst brand
✅ **Recognition**: "catalyst-research" becomes known for quality research agents

## Risks & Mitigations

### Risk 1: Breaking existing installations

**Mitigation:**
- Maintain hack/ scripts that work with new structure
- Provide clear MIGRATION.md guide
- Support both approaches for 6 months
- Add deprecation warnings in v1.x, remove in v2.0

### Risk 2: Too many plugins (complexity)

**Mitigation:**
- Clear documentation of what each plugin does
- Recommend "starter pack" (research + workflow)
- Allow bundle installation command
- Good descriptions in marketplace

### Risk 3: Plugin interdependencies

**Mitigation:**
- Design plugins to work independently
- Document recommended combinations
- Use shared config.json for cross-plugin configuration
- Example: workflow plugin can work without research, but better with it

### Risk 4: User confusion about naming

**Mitigation:**
- Clear README explaining "catalyst" is marketplace name
- Plugin names include "catalyst-" prefix for clarity
- Good descriptions that explain purpose
- Examples in documentation

## Backward Compatibility Strategy

### Phase 1: Dual Support (v1.0.0 - v1.9.x, ~6 months)

**Support both:**
- Plugin installation (recommended, documented first)
- Script installation (legacy, documented second)

**hack/ scripts:**
- Update to work with new structure
- Add deprecation warnings
- Point to plugin installation docs

### Phase 2: Plugin-Only (v2.0.0+)

**Remove:**
- Script installation support
- Legacy documentation
- Flattening logic

**Keep:**
- Plugin structure
- Clear migration guide for stragglers

## Configuration Management

### Shared config.json

**Location**: Project `.claude/config.json` (not in plugins)

**Structure:**
```json
{
  "project": {
    "ticketPrefix": "PROJ",
    "defaultTicketPrefix": "PROJ"
  },
  "linear": {
    "teamId": null,
    "projectId": null,
    "thoughtsRepoUrl": null
  },
  "thoughts": {
    "user": null
  },
  "catalyst": {
    "installedPlugins": ["research", "workflow", "dev"],
    "version": "1.0.0"
  }
}
```

**Access from plugins:**
```bash
# All plugins read from same config location
CONFIG_FILE=".claude/config.json"
TICKET_PREFIX=$(jq -r '.project.ticketPrefix // "PROJ"' "$CONFIG_FILE")
```

**Benefits:**
- Cross-plugin consistency
- Single configuration source
- Project-specific values work across all catalyst plugins

## Success Metrics

Track these to measure migration success:

1. **Adoption rate**: Plugin installs vs script usage
2. **Plugin popularity**: Which plugins are most installed
3. **User feedback**: Issues, questions, satisfaction
4. **Contribution**: External PRs to individual plugins
5. **Discovery**: Marketplace adds and searches

## Timeline

### Week 1: Restructure
- Day 1-2: Create plugin directories and structure
- Day 3-4: Create all plugin.json and marketplace.json files
- Day 5: Update hack/ scripts for new structure

### Week 2: Documentation & Testing
- Day 1-2: Update all documentation
- Day 3-4: Test all plugins individually and combined
- Day 5: Create migration guide and examples

### Week 3: Release
- Day 1: Final testing and polish
- Day 2: Tag v1.0.0 and publish
- Day 3-5: Monitor feedback and fix issues

## Open Questions

1. **Should we create a "catalyst-all" meta-plugin** that installs all plugins at once?
   - Pro: Easier for users wanting everything
   - Con: Defeats purpose of modularity
   - Recommendation: No, but document recommended bundles

2. **Should meta/ commands become a plugin**?
   - Pro: Consistent structure
   - Con: They're workspace-only, not useful for users
   - Recommendation: Keep as separate directory, not plugin

3. **Should we add Skills to research plugin initially**?
   - Pro: Showcases autonomous capabilities
   - Con: Adds complexity, not well-tested yet
   - Recommendation: Start without, add in v1.1.0

4. **Version numbers: all plugins start at 1.0.0, or inherit?**
   - Option A: All at 1.0.0 (fresh start)
   - Option B: All at current workspace version
   - Recommendation: All at 1.0.0 (clean slate)

5. **Should we split linear commands into separate plugin**?
   - Pro: Linear users can install just that
   - Con: Too fine-grained, PM plugin is already focused
   - Recommendation: Keep in PM plugin, can split later if needed

## Recommended Next Steps

1. ✅ **You've decided on "catalyst"** - Great choice!
2. ⏭️ **Review this migration plan** - Adjust based on your preferences
3. ⏭️ **Decide on timeline** - All at once, or phased?
4. ⏭️ **Create plugin structure** - Start with restructure
5. ⏭️ **Test locally** - Verify plugins work
6. ⏭️ **Update docs** - Clear migration guide
7. ⏭️ **Release v1.0.0** - Tag and publish

Would you like me to start implementing the restructure, or would you like to adjust this plan first?
