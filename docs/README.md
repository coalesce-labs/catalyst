# Documentation Index

Catalyst is a Claude Code workspace system built on a three-layer memory architecture. This index
helps you find the documentation you need.

## Core Concepts

**Three-Layer Memory System**: Catalyst separates context into three layers:

1. **Short-term Memory** (`.claude/.workflow-context.json`) - Session state, command chaining
2. **Long-term Memory** (HumanLayer thoughts repo) - Git-backed persistence, shared knowledge
3. **Project Configuration** (`.claude/config.json`) - Which thoughts repo to use, project settings

**Structured Development Workflow**:

```
research → plan → branch/worktree → implement → validate → merge_pr
```

**Multiple Projects**: Work on separate projects (work/personal, different clients) with isolated
contexts via different HumanLayer configs.

See [CLAUDE.md](../CLAUDE.md) for complete architecture details.

---

## Quick Start

**New to Catalyst?**

1. [USAGE.md](USAGE.md) - Installation and workflow commands
2. [CONFIGURATION.md](CONFIGURATION.md) - Configure your project
3. [BEST_PRACTICES.md](BEST_PRACTICES.md) - Effective patterns

---

## Documentation by Category

### Setup & Configuration

#### [CONFIGURATION.md](CONFIGURATION.md)

Configuration file structure, ticket prefixes, Linear integration, thoughts system, per-project
HumanLayer config.

**Read this when**: Setting up a new project or configuring integrations.

---

#### [MULTI_CONFIG_GUIDE.md](MULTI_CONFIG_GUIDE.md)

Managing multiple client configurations, switching configs, separate thoughts repositories per
client.

**Read this when**: Working across multiple clients/projects simultaneously.

---

### Workflow & Usage

#### [USAGE.md](USAGE.md)

Core workflow commands, installation, thoughts system, Linear integration, common workflows.

**Read this when**: Learning the system or looking up command usage.

---

#### [AGENTIC_WORKFLOW_GUIDE.md](AGENTIC_WORKFLOW_GUIDE.md)

Agent patterns, documentarian philosophy, spawning parallel agents, creating custom agents.

**Read this when**: Using agents effectively or creating new ones.

---

#### [BEST_PRACTICES.md](BEST_PRACTICES.md)

Research → Plan → Implement → Validate workflow, context management, handoffs, ticket management.

**Read this when**: Learning effective workflow patterns.

---

#### [PATTERNS.md](PATTERNS.md)

Parallel development, feature branches, worktrees, documentation patterns, testing workflows.

**Read this when**: Looking for concrete usage examples.

---

#### [WORKFLOW_DISCOVERY_SYSTEM.md](WORKFLOW_DISCOVERY_SYSTEM.md)

Discovering and importing workflows from external repositories using `/discover-workflows`,
`/import-workflow`, `/create-workflow`.

**Read this when**: Extending Catalyst with new workflows.

---

### Integrations

#### [LINEAR_WORKFLOW_AUTOMATION.md](LINEAR_WORKFLOW_AUTOMATION.md)

Linear integration setup, workflow status automation, ticket creation, status progression.

**Read this when**: Integrating with Linear or automating ticket workflows.

---

#### [DEEPWIKI_INTEGRATION.md](DEEPWIKI_INTEGRATION.md)

External research using DeepWiki, researching external repositories, learning from open-source
patterns.

**Read this when**: Researching how external projects implement features.

---

#### [HUMANLAYER_COMMANDS_ANALYSIS.md](HUMANLAYER_COMMANDS_ANALYSIS.md)

Analysis of HumanLayer command patterns, adaptation patterns, command structure comparison.

**Read this when**: Understanding origins of workspace commands.

---

### Technical

#### [CONTEXT_ENGINEERING.md](CONTEXT_ENGINEERING.md)

Context budgets, just-in-time loading, sub-agent architecture, handoff strategies.

**Read this when**: Optimizing context usage or understanding architectural decisions.

---

#### [FRONTMATTER_STANDARD.md](FRONTMATTER_STANDARD.md)

YAML frontmatter validation, required fields, valid categories/tools, validation rules.

**Read this when**: Creating new agents/commands or debugging frontmatter issues.

---

## By User Type

**First-Time Users**: [USAGE.md](USAGE.md) → [CONFIGURATION.md](CONFIGURATION.md) →
[BEST_PRACTICES.md](BEST_PRACTICES.md)

**Plugin Developers**: [AGENTIC_WORKFLOW_GUIDE.md](AGENTIC_WORKFLOW_GUIDE.md) →
[FRONTMATTER_STANDARD.md](FRONTMATTER_STANDARD.md) →
[WORKFLOW_DISCOVERY_SYSTEM.md](WORKFLOW_DISCOVERY_SYSTEM.md)

**Multiple Clients**: [MULTI_CONFIG_GUIDE.md](MULTI_CONFIG_GUIDE.md) →
[CONFIGURATION.md](CONFIGURATION.md)

**Integration Specialists**: [LINEAR_WORKFLOW_AUTOMATION.md](LINEAR_WORKFLOW_AUTOMATION.md) →
[DEEPWIKI_INTEGRATION.md](DEEPWIKI_INTEGRATION.md)

---

## By Task

**Setting Up**: [USAGE.md](USAGE.md) → [CONFIGURATION.md](CONFIGURATION.md)

**Daily Development**: [BEST_PRACTICES.md](BEST_PRACTICES.md) → [PATTERNS.md](PATTERNS.md)

**Creating Workflows**: [AGENTIC_WORKFLOW_GUIDE.md](AGENTIC_WORKFLOW_GUIDE.md) →
[WORKFLOW_DISCOVERY_SYSTEM.md](WORKFLOW_DISCOVERY_SYSTEM.md)

**Troubleshooting**: [USAGE.md](USAGE.md) → [CONFIGURATION.md](CONFIGURATION.md)

---

## Additional Resources

**Parent Directory**:

- [../README.md](../README.md) - Overview
- [../QUICKSTART.md](../QUICKSTART.md) - 5-minute setup
- [../CLAUDE.md](../CLAUDE.md) - Full architecture (read this!)
- [../COMMANDS_ANALYSIS.md](../COMMANDS_ANALYSIS.md) - Command catalog

**Plugin Documentation**:

- [../plugins/dev/README.md](../plugins/dev/README.md) - Development plugin
- [../plugins/meta/README.md](../plugins/meta/README.md) - Meta plugin

**Setup Scripts**:

- [../scripts/README.md](../scripts/README.md) - One-time setup utilities

**External**:

- [Claude Code Documentation](https://docs.claude.com/en/docs/claude-code)
- [Linear API](https://developers.linear.app/)
- [HumanLayer](https://github.com/humanlayer/humanlayer)

---

## Need Help?

**Can't find what you need?**

- Check [../README.md](../README.md) for overview
- Check [../CLAUDE.md](../CLAUDE.md) for architecture
- Review [USAGE.md](USAGE.md) troubleshooting section
- Search: `grep -r "search term" docs/`

**Found an issue?**

- Update the relevant document
- Run `/validate-frontmatter` for agent/command changes
- Create Linear ticket with `/linear` for larger tasks
