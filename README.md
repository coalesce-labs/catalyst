# Catalyst - Claude Code Workspace

My personal development workflow for Claude Code, now open-sourced for the community.

This is the workspace I use daily for AI-assisted development. It's battle-tested on real projects and optimized for efficient, context-aware AI collaboration. I'm sharing it so others can use it, fork it, and contribute ideas back.

## What's Inside

**Catalyst** is a 2-plugin system for Claude Code focused on **token efficiency**, **reusability**, and **persistent context** through parallel agent research, structured handoffs, and shared memory systems.

**catalyst-dev** - Complete development workflow
- 11 research agents (codebase + infrastructure)
- 18 commands covering full dev lifecycle
- Linear integration via Linearis CLI
- Handoff system for context persistence

**catalyst-meta** - Workflow discovery
- Discover workflows from community repos
- Import and adapt patterns
- Create new workflows

## Installation

Install via Claude Code plugin system:

```bash
# Add the marketplace repository
/plugin marketplace add ryanisaacg/catalyst

# Install catalyst-dev (main workflow)
/plugin install catalyst-dev

# Optionally install catalyst-meta (workflow discovery)
/plugin install catalyst-meta
```

For plugin documentation, see [Claude Code Plugin Guide](https://docs.claude.com/plugins).

## Complete Workflow

```
/research_codebase → /create_plan → /implement_plan → /validate_plan → /create_pr → /merge_pr
```

With handoffs for context persistence:
```
/create_handoff → /resume_handoff
```

Agents proactively monitor context during implementation and will prompt you to create handoffs before running out of context, creating structured handoff documents that add to persistent memory.

## Core Philosophy

### Token Efficiency Through Structured Context

1. **Parallel Agent Research** - Multiple specialized agents research concurrently
2. **Context Compression** - Research compressed into structured summaries
3. **Focused Planning** - Planning agents work with compressed context
4. **Persistent Memory** - Handoffs and thoughts system preserve context across sessions

### Reusability and Shared Memory

Uses the [HumanLayer thoughts system](https://github.com/humanlayer/humanlayer) for shared persistent memory across teams and projects. The research → plan → implement → validate workflow is adapted from HumanLayer's approach.

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

**MCP Tools** (auto-configured by Claude Code):
- Context7 - Library documentation
- Exa - Web search
- PostHog - Product analytics
- Sentry - Error monitoring (can use CLI or MCP)

Run the prerequisite check:
```bash
/check_prerequisites
```

## Credits

Built on patterns from:
- [HumanLayer](https://github.com/humanlayer/humanlayer) - Thoughts system for shared persistent memory and research/plan/implement/validate workflow

Personal refinement over hundreds of hours on real projects.

## Contributing

This is my personal workspace, but I'm open to:

- **Ideas** - Open issues with workflow suggestions
- **Forks** - Adapt it to your needs
- **Bug reports** - If something's broken
- **Patterns** - Share your own workflow patterns

I may not accept all PRs (since this is my daily driver), but I love seeing how others adapt these patterns!

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
