# Workflow Discovery System

A comprehensive meta-workflow system for discovering, importing, creating, and validating Claude Code workflows from external repositories.

**Version**: 1.0.0
**Last Updated**: 2025-01-08

## Overview

The Workflow Discovery System provides four interconnected commands that help you:

1. **Discover** workflows from external Claude Code repositories
2. **Import** discovered workflows into your workspace
3. **Create** new workflows using discovered patterns
4. **Validate** frontmatter consistency across all workflows

This system leverages parallel sub-agents for efficiency and follows context engineering principles.

## Commands

### 1. `/discover-workflows` - Research External Repositories

Discovers and catalogs workflows from the Claude Code community.

**Purpose**: Research external repositories to find reusable agents, commands, and patterns.

**Key Features**:

- Researches 11+ curated Claude Code repositories
- Uses 3 parallel sub-agents per repository for efficiency:
  - **Workflow Discovery** - Lists all available workflows
  - **Frontmatter Analysis** - Extracts frontmatter patterns
  - **Implementation Patterns** - Finds reusable templates
- Catalogs findings in `thoughts/shared/workflows/`
- Creates searchable catalog with categorization

**Usage**:

```bash
# Research specific repository
/discover-workflows wshobson/commands

# Research all supported repositories (33 parallel agents!)
/discover-workflows all

# Research custom repository
/discover-workflows org/custom-repo
```

**Output**:

- Repository analysis at `thoughts/shared/workflows/{repo}/analysis.md`
- Master catalog at `thoughts/shared/workflows/catalog.md`
- Organized by category and use case

**Supported Repositories**:

- `wshobson/commands` - Production slash commands
- `wshobson/agents` - Production subagents
- `qdhenry/Claude-Command-Suite` - 148+ commands
- `VoltAgent/awesome-claude-code-subagents` - 100+ subagents
- `catlog22/Claude-Code-Workflow` - Multi-agent automation
- `automazeio/ccpm` - Project management system
- `hesreallyhim/awesome-claude-code` - Curated commands/agents
- `feiskyer/claude-code-settings` - Workflow improvements
- `OneRedOak/claude-code-workflows` - Code review workflows
- `anthropics/claude-code` - Official Claude Code repo
- `winfunc/opcode` - GUI toolkit for agents/commands

### 2. `/import-workflow` - Adapt External Workflows

Imports workflows from external repositories and adapts them to your workspace standards.

**Purpose**: Bring external workflows into your workspace with proper adaptation and validation.

**Key Features**:

- Uses 3 parallel validation tasks:
  - **External Research** - Understands the workflow thoroughly
  - **Local Pattern Check** - Finds similar existing workflows
  - **Historical Context** - Checks for previous attempts
- Adapts frontmatter to workspace standards
- Replaces repository-specific values (ticket prefixes, paths, IDs)
- Validates tool compatibility
- Tracks provenance and modifications
- Records imports in `thoughts/shared/workflows/imports.md`

**Usage**:

```bash
# Interactive import with analysis
/import-workflow wshobson/commands code-review

# Import with custom adaptations
/import-workflow wshobson/commands code-review --adapt "Use our custom linting rules"

# Import multiple workflows
/import-workflow wshobson/commands code-review refactor test-gen

# Dry run (preview without saving)
/import-workflow wshobson/commands code-review --dry-run
```

**Process**:

1. Spawns 3 parallel research tasks
2. Aggregates and analyzes findings
3. Presents comprehensive import analysis
4. Asks for confirmation
5. Adapts frontmatter to standards
6. Replaces config values from `.claude/config.json`
7. Validates and saves
8. Records import details

**Output**:

- Workflow saved to `agents/{name}.md` or `commands/{name}.md`
- Import record in `thoughts/shared/workflows/imports.md`
- Attribution and source tracking

### 3. `/create-workflow` - Interactive Workflow Creator

Creates new agents or commands using discovered patterns and templates.

**Purpose**: Build new workflows following workspace standards with guidance from existing examples.

**Key Features**:

- Uses 3 parallel research tasks:
  - **Local Examples** - Finds similar workflows in workspace
  - **Catalog Examples** - Finds external examples from catalog
  - **Frontmatter Standards** - Extracts workspace conventions
- Shows relevant examples before creation
- Provides templates (minimal, standard, advanced)
- Enforces frontmatter consistency
- Validates before saving
- Records creation in `thoughts/shared/workflows/created.md`

**Usage**:

```bash
# Interactive creation
/create-workflow

# Create from catalog entry
/create-workflow from catalog wshobson/commands/code-review

# Quick create with defaults
/create-workflow agent data-analyzer "Analyzes data patterns"

# Create with template
/create-workflow command quick-commit "Create conventional commits" --template minimal
```

**Process**:

1. Gathers requirements (type, name, purpose, tools)
2. Spawns 3 parallel research tasks for examples
3. Presents similar workflows and patterns
4. Generates appropriate template (agent or command)
5. Validates frontmatter and structure
6. Iterates based on feedback
7. Saves and records creation

**Templates**:

- **Minimal**: Basic structure only
- **Standard**: Full featured (default)
- **Advanced**: Includes sub-agent patterns

### 4. `/validate-frontmatter` - Consistency Checker

Validates frontmatter across all workflows and auto-fixes issues.

**Purpose**: Ensure all agents and commands follow the workspace frontmatter standard.

**Key Features**:

- Uses 3 parallel validation tasks:
  - **Validate Agents** - Checks all agent frontmatter
  - **Validate Commands** - Checks all command frontmatter
  - **Extract Tool References** - Inventories all tools used
- Comprehensive validation report
- Auto-fix capability for common issues
- Generates FRONTMATTER_STANDARD.md reference
- Non-destructive (shows plan before fixing)

**Usage**:

```bash
# Validate all workflows (report only)
/validate-frontmatter

# Validate and auto-fix
/validate-frontmatter --fix

# Validate specific workflow
/validate-frontmatter agents/codebase-analyzer.md

# Generate standard document
/validate-frontmatter --generate-standard
```

**Validation Checks**:

- Required fields present
- Version follows semver (X.Y.Z)
- Tools are valid Claude Code tools
- Categories match standard list
- Name matches filename (agents)
- No name field in commands
- YAML well-formed

**Auto-Fix Capabilities**:

- ✅ Add missing version/model fields
- ✅ Convert version to semver format
- ✅ Fix common tool name typos
- ✅ Standardize YAML formatting
- ❌ Requires manual: descriptions, ambiguous categories

## Workflow Discovery Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     Workflow Discovery                      │
│                     & Management Flow                        │
└─────────────────────────────────────────────────────────────┘

1. Discover Phase
   ┌──────────────────────┐
   │ /discover-workflows  │  ← Research external repos
   └──────────┬───────────┘
              │
              ├─→ Spawn 3 parallel sub-agents per repo:
              │   • Workflow Discovery (structure)
              │   • Frontmatter Analysis (patterns)
              │   • Implementation Patterns (templates)
              │
              ├─→ Aggregate results
              │
              └─→ Create catalog at thoughts/shared/workflows/
                  • {repo}/analysis.md (per repo)
                  • catalog.md (master index)

2. Import Phase
   ┌──────────────────────┐
   │ /import-workflow     │  ← Bring external workflow in
   └──────────┬───────────┘
              │
              ├─→ Spawn 3 parallel validation tasks:
              │   • External Research (understand workflow)
              │   • Local Pattern Check (find similar)
              │   • Historical Context (check previous work)
              │
              ├─→ Present analysis and get approval
              │
              ├─→ Adapt to workspace standards:
              │   • Normalize frontmatter
              │   • Replace config values (.claude/config.json)
              │   • Add source attribution
              │   • Validate tools
              │
              └─→ Save and record import
                  • agents/{name}.md or commands/{name}.md
                  • thoughts/shared/workflows/imports.md

3. Create Phase
   ┌──────────────────────┐
   │ /create-workflow     │  ← Create new workflow
   └──────────┬───────────┘
              │
              ├─→ Spawn 3 parallel research tasks:
              │   • Local Examples (similar in workspace)
              │   • Catalog Examples (from discoveries)
              │   • Frontmatter Standards (conventions)
              │
              ├─→ Present examples and recommendations
              │
              ├─→ Generate template (minimal/standard/advanced)
              │
              ├─→ Validate frontmatter and structure
              │
              └─→ Save and record creation
                  • agents/{name}.md or commands/{name}.md
                  • thoughts/shared/workflows/created.md

4. Validate Phase
   ┌──────────────────────┐
   │ /validate-frontmatter│  ← Ensure consistency
   └──────────┬───────────┘
              │
              ├─→ Spawn 3 parallel validation tasks:
              │   • Validate Agents (all agents/*.md)
              │   • Validate Commands (all commands/*.md)
              │   • Extract Tools (inventory usage)
              │
              ├─→ Generate comprehensive report
              │
              ├─→ Auto-fix issues (if requested):
              │   • Show fix plan
              │   • Get approval
              │   • Apply fixes
              │   • Report changes
              │
              └─→ Optionally generate reference doc
                  • docs/FRONTMATTER_STANDARD.md
```

## Parallel Sub-Agent Architecture

All four commands use parallel sub-agents for efficiency, following context engineering principles:

### Why Parallel?

1. **Speed**: 3x faster than sequential research
2. **Context Isolation**: Each agent has focused context
3. **Token Efficiency**: Smaller, targeted contexts per agent
4. **No Contamination**: Independent research areas don't interfere

### Pattern

```python
# Spawn parallel tasks
Task 1: Research aspect A (isolated context)
Task 2: Research aspect B (isolated context)
Task 3: Research aspect C (isolated context)

# All run simultaneously

# Wait for completion
[WAIT for all tasks]

# Aggregate results
Combine findings from all tasks
Analyze holistically
Present to user
```

### Example: `/discover-workflows`

For each repository:

```
Task 1: Workflow Discovery
  → "List all commands and agents available"
  → Tools: mcp__deepwiki__read_wiki_structure, ask_question
  → Returns: Complete workflow list

Task 2: Frontmatter Analysis
  → "What frontmatter format is used? Show examples"
  → Tools: mcp__deepwiki__ask_question
  → Returns: Frontmatter patterns

Task 3: Implementation Patterns
  → "What are common patterns and conventions?"
  → Tools: mcp__deepwiki__ask_question
  → Returns: Templates and conventions

[Run all 3 in parallel → Wait → Aggregate]
```

## Integration Points

### Configuration System

All commands use `.claude/config.json` for project-specific values:

```json
{
  "project": {
    "ticketPrefix": "PROJ",
    "defaultTicketPrefix": "PROJ"
  },
  "linear": {
    "teamId": "your-team-id",
    "projectId": "your-project-id"
  }
}
```

When importing or creating workflows:

- Replace hardcoded ticket prefixes with config values
- Use config for Linear integration
- Maintain portability across projects

### Thoughts Repository

All discovery work is stored in the thoughts repository:

```
thoughts/
└── shared/
    └── workflows/
        ├── catalog.md              # Master index
        ├── imports.md              # Import history
        ├── created.md              # Creation history
        ├── wshobson-commands/
        │   └── analysis.md         # Repo analysis
        ├── wshobson-agents/
        │   └── analysis.md
        └── [more repos]/
            └── analysis.md
```

Benefits:

- Persistent across worktrees
- Shareable across team
- Searchable history
- Context for future decisions

### DeepWiki MCP Integration

The discovery system heavily relies on DeepWiki MCP tools:

- `mcp__deepwiki__read_wiki_structure` - Get repository structure
- `mcp__deepwiki__read_wiki_contents` - Read documentation
- `mcp__deepwiki__ask_question` - Query repository

This enables researching external repositories without cloning them locally.

## Frontmatter Standards

All workflows must follow the workspace frontmatter standard (see `docs/FRONTMATTER_STANDARD.md`).

### Agent Frontmatter

```yaml
---
name: { agent-name } # Must match filename
description: |
  {Multi-line description}
  Use this agent when: ...
tools: [tool-list]
model: inherit
category: { research|analysis|search|execution|validation|general }
version: 1.0.0
---
```

### Command Frontmatter

```yaml
---
description: { one-line-summary } # No 'name' field!
category:
  {
    workflow|planning|implementation|validation|linear|git|workflow-discovery|general,
  }
argument-hint: { optional }
tools: [tool-list]
model: inherit
version: 1.0.0
---
```

## Best Practices

### When to Use Each Command

**Use `/discover-workflows` when**:

- Starting a new project and want to learn from others
- Looking for inspiration or examples
- Researching how others solve similar problems
- Building a catalog of reusable patterns

**Use `/import-workflow` when**:

- You found a workflow in the catalog you want to use
- You need exactly what an external workflow provides
- You want to adapt an existing workflow to your needs
- You want to track provenance of external code

**Use `/create-workflow` when**:

- You need something custom not in the catalog
- You want to combine patterns from multiple examples
- You're building something specific to your project
- You want guidance but need flexibility

**Use `/validate-frontmatter` when**:

- Before committing new workflows
- After importing or creating workflows
- Periodically to ensure consistency
- After updating the frontmatter standard
- When you notice inconsistencies

### Workflow Lifecycle

1. **Discover**: Research external repositories for ideas
2. **Import or Create**: Bring in or build workflows
3. **Validate**: Ensure consistency and standards
4. **Iterate**: Refine based on usage
5. **Share**: Contribute back to community (optional)

### Maintaining Quality

- Run `/validate-frontmatter` before committing
- Keep catalog updated with new discoveries
- Document why you imported/created workflows
- Track modifications in thoughts/
- Use version numbers for breaking changes

## Advanced Patterns

### Mass Import from Catalog

```bash
# Discover all repos
/discover-workflows all

# Review catalog
cat thoughts/shared/workflows/catalog.md

# Import top picks
/import-workflow wshobson/commands code-review
/import-workflow wshobson/agents codebase-analyzer
/import-workflow qdhenry/Claude-Command-Suite doc-generator

# Validate everything
/validate-frontmatter --fix
```

### Custom Workflow with Research

```bash
# Create custom workflow but show examples first
/create-workflow

# During creation:
# - System finds similar workflows
# - Shows examples from catalog
# - Suggests patterns to follow
# - Validates against standards
```

### Periodic Catalog Updates

```bash
# Re-discover repos quarterly to catch updates
/discover-workflows all

# Check for new workflows in catalog
diff thoughts/shared/workflows/catalog.md <previous-version>

# Import new interesting workflows
/import-workflow <repo> <new-workflow>
```

## Troubleshooting

### Discovery Issues

**Problem**: DeepWiki can't find repository

- Ensure repository is public
- Check repository name format (org/repo)
- Try alternative: provide direct GitHub URL

**Problem**: Discovery is slow

- Use parallel mode (automatic)
- Discover one repo at a time if needed
- Check network connection

### Import Issues

**Problem**: Workflow has incompatible tools

- System will list incompatible tools
- Suggests alternatives
- Ask if should proceed with modifications

**Problem**: Duplicate workflow exists

- System detects similar workflows
- Shows comparison
- Asks: Replace / Rename / Skip

### Validation Issues

**Problem**: Many validation failures

- Run `/validate-frontmatter --fix` for auto-fixes
- Review remaining issues manually
- Update frontmatter standard if needed

**Problem**: Auto-fix changes too much

- Use `--dry-run` mode first
- Review fix plan before applying
- Selectively fix with specific file validation

## Contributing

If you create excellent workflows, consider:

1. **Sharing with community**: Create a public repo
2. **Adding to discovery list**: Submit PR to update supported repos
3. **Documenting patterns**: Add to catalog with clear examples
4. **Maintaining standards**: Follow frontmatter conventions

## See Also

- [Frontmatter Standard](FRONTMATTER_STANDARD.md) - Complete standard reference
- [README](../README.md) - Workspace overview
- `.claude/config.json` - Project configuration
- `thoughts/shared/workflows/` - Discovery catalog

## Version History

- **1.0.0** (2025-01-08): Initial release
  - Four core commands
  - Parallel sub-agent architecture
  - DeepWiki integration
  - 11+ supported repositories
