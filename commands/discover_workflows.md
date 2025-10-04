---
description: Research and catalog workflows from external Claude Code repositories
category: workflow-discovery
tools: mcp__deepwiki__ask_question, mcp__deepwiki__read_wiki_structure, Read, Write
model: inherit
version: 1.0.0
---

# Discover Workflows

You are tasked with researching external Claude Code repositories to discover, analyze, and catalog their agents, commands, and workflow patterns.

## Purpose

This command helps you learn from the Claude Code community by analyzing workflow repositories and extracting reusable patterns.

## Supported Repositories

Default repositories to research:
- `catlog22/Claude-Code-Workflow` - Multi-agent automation
- `automazeio/ccpm` - Project management system
- `wshobson/commands` - Production slash commands
- `wshobson/agents` - Production subagents
- `qdhenry/Claude-Command-Suite` - 148+ commands, 54 agents
- `VoltAgent/awesome-claude-code-subagents` - 100+ subagents
- `hesreallyhim/awesome-claude-code` - Curated commands/agents
- `feiskyer/claude-code-settings` - Workflow improvements
- `OneRedOak/claude-code-workflows` - Code review workflows
- `anthropics/claude-code` - Official Claude Code repo
- `winfunc/opcode` - GUI toolkit for agents/commands

## Initial Response

When invoked:

```
I'll research Claude Code workflows from external repositories.

Which repository would you like to explore?
1. wshobson/commands - Production slash commands
2. wshobson/agents - Production subagents
3. qdhenry/Claude-Command-Suite - 148+ commands
4. VoltAgent/awesome-claude-code-subagents - 100+ subagents
5. Custom repository (provide org/repo)

Or type 'all' to catalog all supported repos (this may take a while).
```

## Process

### Step 1: Select Repository

Get user selection or use provided parameter.

### Step 2: Research Repository (Parallel Sub-Agents)

**IMPORTANT**: Spawn 3 parallel research tasks for efficiency and context isolation.

Use TodoWrite to track the 3 parallel research tasks.

**Task 1 - Workflow Discovery**:
```
Use external-research agent:
"Research {repo-name}. What commands and agents are available? List all workflows with brief descriptions of what each does."

Tools: mcp__deepwiki__read_wiki_structure, mcp__deepwiki__ask_question
Return: Complete list of all workflows found
```

**Task 2 - Frontmatter Analysis**:
```
Use external-research agent:
"Research {repo-name}. What frontmatter format is used for agents and commands? Provide specific examples showing all frontmatter fields used."

Tools: mcp__deepwiki__ask_question
Return: Frontmatter patterns with concrete examples
```

**Task 3 - Implementation Patterns**:
```
Use external-research agent:
"Research {repo-name}. What are the common implementation patterns, structures, and conventions used across workflows? Include naming conventions, file organization, and any templates."

Tools: mcp__deepwiki__ask_question
Return: Patterns, templates, conventions observed
```

**WAIT for all 3 tasks to complete before proceeding.**

**Why parallel**:
- 3x faster than sequential
- Each agent has isolated context
- No context contamination between research areas
- Better token efficiency per agent

### Step 3: Aggregate Parallel Results

Combine findings from the 3 parallel research tasks:
- Workflows list from Task 1
- Frontmatter patterns from Task 2
- Implementation patterns from Task 3

Mark all 3 tasks complete in TodoWrite.

### Step 4: Analyze and Extract

From the aggregated results, extract:

1. **Available Workflows**
   - List all agents and commands
   - What each one does
   - When to use them

2. **Frontmatter Patterns**
   - What fields are used
   - Naming conventions
   - Tool specifications
   - Categories/tags

3. **Implementation Patterns**
   - Common structures
   - Reusable templates
   - Integration patterns

4. **Unique Features**
   - Novel approaches
   - Interesting combinations
   - Advanced techniques

### Step 5: Create Catalog Entry

Save research to `thoughts/shared/workflows/{repo-name}/analysis.md`:

```markdown
# Workflow Analysis: {Repo Name}

**Repository**: {org/repo}
**Analyzed**: {date}
**Focus**: {agents/commands/both}

## Summary

[1-2 sentence overview of what this repo offers]

## Available Workflows

### Commands

1. **{command-name}**
   - **Purpose**: [what it does]
   - **Use when**: [scenario]
   - **Frontmatter**:
     ```yaml
     [actual frontmatter from repo]
     ```

2. **{command-name}**
   [...]

### Agents

1. **{agent-name}**
   - **Purpose**: [what it does]
   - **Tools**: [tools it uses]
   - **Frontmatter**:
     ```yaml
     [actual frontmatter from repo]
     ```

## Frontmatter Patterns

### Standard Fields
- name: [how they define it]
- description: [format they use]
- tools: [how specified]
- [other fields observed]

### Naming Conventions
- [pattern 1]
- [pattern 2]

## Implementation Patterns

### Common Structures
[Patterns you notice across workflows]

### Reusable Templates
[Templates that could be adapted]

## Unique Features

[Novel or interesting approaches]

## Integration Notes

[How these could integrate with your workspace]

## Recommendations

### High-Value Imports
1. **{workflow-name}** - [why it's valuable]
2. **{workflow-name}** - [why it's valuable]

### Patterns to Adopt
- [Pattern 1]: [how to use it]
- [Pattern 2]: [how to use it]

## References

- DeepWiki searches: [links]
- Repository: {URL}
- Analyzed on: {date}
```

### Step 6: Update Master Catalog

Update `thoughts/shared/workflows/catalog.md`:

```markdown
# Workflow Catalog

Discovered workflows from the Claude Code community.

## Repositories Analyzed

### wshobson/commands
- **Analyzed**: 2025-01-08
- **Workflows**: 15 commands
- **Focus**: Production-ready automation
- **Details**: [See analysis](wshobson-commands/analysis.md)
- **Top Picks**:
  - code-review: Automated code review workflow
  - refactor: Safe refactoring patterns

[... more repos]

## By Category

### Code Review
- wshobson/commands: code-review
- OneRedOak/claude-code-workflows: review-pr

### Documentation
- qdhenry/Claude-Command-Suite: doc-generator
- hesreallyhim/awesome-claude-code: readme-generator

[... more categories]

## By Use Case

### "I want to automate code reviews"
1. wshobson/commands/code-review
2. OneRedOak/claude-code-workflows/review-pr
3. [Details in respective analyses]

### "I need project management workflows"
1. automazeio/ccpm - Full PM system
2. [...]
```

### Step 7: Present Summary

Show user what was found:

```markdown
# Discovery Results: {Repo Name}

## Summary
Discovered {N} workflows ({X} commands, {Y} agents)

## Highlights

### Top Workflows
1. **{name}** - {brief description}
2. **{name}** - {brief description}
3. **{name}** - {brief description}

### Interesting Patterns
- {Pattern 1}
- {Pattern 2}

### Recommended for Import
- **{workflow-name}**: {why}

## Next Steps

1. **Review the analysis**: `thoughts/shared/workflows/{repo}/analysis.md`
2. **Import a workflow**: `/import-workflow {repo} {workflow-name}`
3. **Discover another repo**: `/discover-workflows`

Catalog updated at: `thoughts/shared/workflows/catalog.md`
```

## Advanced Usage

### Discover All Repos (Maximum Parallelism)

```
/discover-workflows all
```

This will:
1. Spawn parallel research for ALL supported repos simultaneously
2. Each repo gets 3 sub-agents (structure, frontmatter, patterns)
3. Total: 11 repos × 3 agents = 33 parallel tasks
4. Aggregate all results
5. Create analysis for each repo
6. Update master catalog
7. Present summary comparison

**Performance**: ~10-15x faster than sequential research

**Context efficiency**: Each agent loads only its research area

### Discover Custom Repo

```
/discover-workflows org/repo
```

Works with any public GitHub repo with Claude Code workflows.

### Focus on Specific Type

```
/discover-workflows wshobson/agents --focus agents
```

Only analyzes agents, skips commands.

## Important Notes

- **Read-only**: This command only researches, doesn't import
- **Catalog persistence**: Saved in thoughts/ for future reference
- **Reusable**: Run anytime to update catalog
- **Combinable**: Use with `/import-workflow` to actually import

## Integration with Other Commands

- **Discover** → `/discover-workflows` (this command)
- **Import** → `/import-workflow` (imports discovered workflows)
- **Create** → `/create-workflow` (creates new using discovered patterns)
- **Validate** → `/validate-frontmatter` (ensures consistency)

This command is the first step in workflow discovery and reuse!
