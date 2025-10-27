# Catalyst - Claude Code Workspace

[Ryan Rozich's](https://ryanrozich.bio/) personal development workflow for Claude Code, now open
sourced and packaged as a Claude Code plugin marketplace.

This is the workspace I use daily for AI-assisted development. It's battle-tested on real projects
and optimized for efficient, context-aware AI collaboration. I'm sharing it so others can use it,
fork it, and contribute ideas back.

## What's Inside

**Catalyst** is a 4-plugin system for Claude Code focused on **token efficiency**, **session-aware
MCP management**, and **persistent context** through parallel agent research, structured handoffs,
and shared memory systems.

**catalyst-dev** (Core - Always enabled)

- 11 research agents (codebase + infrastructure)
- 18 commands covering full dev lifecycle
- Linear integration via Linearis CLI
- Handoff system for context persistence
- ~3.5k context (lightweight MCPs: DeepWiki, Context7)

**catalyst-analytics** (Optional - Enable when needed)

- PostHog MCP integration (~40k context)
- Product analytics and user behavior analysis
- Conversion funnels and cohort analysis
- 3 specialized analytics commands

**catalyst-debugging** (Optional - Enable when needed)

- Sentry MCP integration (~20k context)
- Production error monitoring and debugging
- Stack trace analysis and root cause detection
- 3 specialized debugging commands

**catalyst-meta** (Optional - For advanced users)

- Discover workflows from community repos
- Import and adapt patterns
- Create new workflows

## Installation

Install via Claude Code plugin system:

```bash
# Add the marketplace repository
/plugin marketplace add coalesce-labs/catalyst

# Install core workflow (required)
/plugin install catalyst-dev

# Optional: Install analytics plugin (if you use PostHog)
/plugin install catalyst-analytics

# Optional: Install debugging plugin (if you use Sentry)
/plugin install catalyst-debugging

# Optional: Install meta plugin (workflow discovery)
/plugin install catalyst-meta
```

### Session-Based MCP Management

Plugins automatically load/unload MCPs when enabled/disabled:

```bash
# Enable analytics when analyzing user behavior
/plugin enable catalyst-analytics  # Loads PostHog MCP (+40k context)

# Disable when done to free context
/plugin disable catalyst-analytics  # Unloads PostHog MCP (-40k context)

# Enable debugging for incident response
/plugin enable catalyst-debugging  # Loads Sentry MCP (+20k context)

# Can enable both simultaneously
/plugin enable catalyst-analytics catalyst-debugging  # Both MCPs loaded
```

**Why this matters**: Most development sessions don't need analytics or debugging MCPs. Starting
with just `catalyst-dev` keeps your context at ~3.5k tokens instead of ~65k, leaving more room for
code and conversation.

**Need help?**

- [Quick Start Guide](QUICKSTART.md) - 5-minute setup walkthrough
- [Configuration Guide](docs/CONFIGURATION.md) - Complete setup and configuration details
- [Claude Code Plugin Guide](https://docs.claude.com/plugins) - Official plugin documentation

## Complete Workflow

```
/research-codebase → /create-plan → /implement-plan → /validate-plan → /create-pr → /merge-pr
```

With handoffs for context persistence:

```
/create-handoff → /resume-handoff
```

Agents proactively monitor context during implementation and will prompt you to create handoffs
before running out of context, creating structured handoff documents that add to persistent memory.

**Learn More:**

- [Agentic Workflow Guide](docs/AGENTIC_WORKFLOW_GUIDE.md) - Complete guide showing research,
  planning, handoff, worktree, implementation, verify, and PR workflows
- [Context Engineering](docs/CONTEXT_ENGINEERING.md) - Token efficiency strategies and context
  management patterns
- [Linear Workflow Automation](docs/LINEAR_WORKFLOW_AUTOMATION.md) - Linearis integration for ticket
  → branch → PR → merge lifecycle ([Linearis GitHub](https://github.com/ryanrozich/linearis))

## Core Philosophy

### Token Efficiency Through Structured Context

1. **Parallel Agent Research** - Multiple specialized agents research concurrently
2. **Context Compression** - Research compressed into structured summaries
3. **Focused Planning** - Planning agents work with compressed context
4. **Persistent Memory** - Handoffs and thoughts system preserve context across sessions

### Reusability and Shared Memory

Uses the [HumanLayer thoughts system](https://github.com/humanlayer/humanlayer) for shared
persistent memory across teams and projects. The research → plan → implement → validate workflow is
adapted from HumanLayer's approach.

### CLI-First Integration

When possible, uses CLIs instead of MCPs for token efficiency:

- Linear: Linearis CLI (1k tokens) vs Linear MCP (13k tokens) = **13x reduction**
- Infrastructure research via CLIs (Railway, Sentry, GitHub)

## Key Features

**Large Long-Term Memory and Context**

- Thoughts system for persistent memory across projects
- Structured handoff documents for context preservation
- Research artifacts saved and referenceable
- Plan documents that persist implementation context

**Token Efficiency**

- Parallel agents compress research before synthesis
- CLI-based tools minimize token overhead
- Focused agents for specific tasks
- Context-aware handoff prompts

**Secure Configuration**

- Template system prevents committing secrets
- `.gitignore` protection for sensitive files
- No hardcoded credentials

## Requirements

**Core Tools**:

- Claude Code
- Git
- jq

**CLI Integrations** (optional but recommended):

- `linearis` - Linear integration ([install](https://github.com/ryanrozich/linearis))
- `gh` - GitHub CLI
- `railway` - Railway deployments
- `sentry-cli` - Error monitoring
- `humanlayer` - Thoughts system ([install](https://github.com/humanlayer/humanlayer))

**MCP Tools** (bundled with plugins):

- Context7 & DeepWiki - Built into `catalyst-dev` (~3.5k tokens)
- PostHog - Built into `catalyst-analytics` (~40k tokens when enabled)
- Sentry - Built into `catalyst-debugging` (~20k tokens when enabled)

Run the prerequisite check:

```bash
/check_prerequisites
```

## Credits

Built on patterns from:

- [HumanLayer](https://github.com/humanlayer/humanlayer) - Thoughts system for shared persistent
  memory and research/plan/implement/validate workflow

Personal refinement over hundreds of hours on real projects.

## Contributing

This is my personal workspace, but I'm open to:

- **Ideas** - Open issues with workflow suggestions
- **Forks** - Adapt it to your needs
- **Bug reports** - If something's broken
- **Patterns** - Share your own workflow patterns

I may not accept all PRs (since this is my daily driver), but I love seeing how others adapt these
patterns!

## Documentation

- [Full Documentation](docs/) - Comprehensive guides
- [Quick Start](QUICKSTART.md) - 5-minute setup
- [Usage Guide](docs/USAGE.md) - How to use all features
- [Commands](COMMANDS_ANALYSIS.md) - Complete command reference
- [Architecture](CLAUDE.md) - How it's built

## License

MIT - Use it however you want!

---

Built by [Ryan Rozich](https://github.com/ryanrozich)

Want to chat about workflows, contribute ideas, or share your fork? Open an issue or discussion!
