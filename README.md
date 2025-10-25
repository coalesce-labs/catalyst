# Catalyst - Ryan's Claude Code Workspace

**My personal development workflow for Claude Code, now open-sourced for the community.**

This is the workspace I use daily for AI-assisted development. It's battle-tested on real projects and optimized for how I work. I'm sharing it so others can use it, fork it, and contribute ideas back.

## What's Inside

**Catalyst** is a 2-plugin system for Claude Code that provides:

- 🔬 **11 Research Agents** - Specialized agents for codebase and infrastructure research
- ⚡ **23 Commands** - Complete development workflow from research to deployment
- 🔧 **Token-Efficient CLIs** - Linearis (13x faster than MCP), Railway, Sentry, GitHub
- 🔒 **Secure Config** - Template system prevents committing secrets
- 📊 **PM Tools** - Cycle planning and review with GitHub PR tracking

### Two Plugins

**catalyst-dev** - Main development workflow
- Research → Plan → Implement → Validate
- Linear integration with Linearis CLI
- Handoff system for context persistence
- Git worktree management

**catalyst-meta** - Workflow discovery
- Discover workflows from community repos
- Import and adapt patterns
- Create new workflows

## Installation

Coming soon to Claude Code marketplace. For now, clone and explore:

```bash
git clone https://github.com/ryanisaacg/catalyst.git
cd catalyst

# Check what's required
./hack/check-prerequisites.sh

# Explore the plugins
ls plugins/dev/
ls plugins/meta/
```

## Philosophy

Built on Anthropic's context engineering principles:

- **Context is precious** - Use specialized agents, not monoliths
- **Just-in-time loading** - Load context dynamically
- **CLI over MCP** - When possible (13x token reduction for Linear)
- **Sub-agent architecture** - Parallel research, focused tasks
- **Structured persistence** - Save context outside conversations

## Key Features

### Token Efficiency
- Linear MCP (13k tokens) → Linearis CLI (1k tokens)
- CLI-based infrastructure research agents
- Minimal context footprint

### Security First
- Config template system
- `.gitignore` prevents committing secrets
- No hardcoded credentials

### Real-World PM
- Track work via Linear tickets AND GitHub PRs
- Find untracked work (PRs without tickets)
- Team contribution breakdown
- Velocity insights from actual merged PRs

### Complete Workflow
```
/research_codebase → /create_plan → /implement_plan → /create_pr → /merge_pr
```

With handoffs for context persistence:
```
/create_handoff → /resume_handoff
```

## Contributing

This is my personal workspace, but I'm open to:

✅ **Ideas** - Open issues with workflow suggestions
✅ **Forks** - Adapt it to your needs
✅ **Bug reports** - If something's broken
✅ **Patterns** - Share your own workflow patterns

I may not accept all PRs (since this is my daily driver), but I love seeing how others adapt these patterns!

## Documentation

- 📖 **[Full Documentation](docs/)** - Comprehensive guides
- 🚀 **[Quick Start](QUICKSTART.md)** - 5-minute setup
- 🎯 **[Usage Guide](docs/USAGE.md)** - How to use all features
- 📋 **[Commands](COMMANDS_ANALYSIS.md)** - Complete command reference
- 🏗️ **[Architecture](CLAUDE.md)** - How it's built

## What Makes This Different

**Personal workspace**, not enterprise software:
- Optimized for how I work
- No unnecessary abstraction
- Battle-tested on real projects
- Constantly evolving

**Open source philosophy**:
- Use it as-is
- Fork and customize
- Share your improvements
- Contribute ideas

**Token-efficient**:
- CLI-first approach where possible
- Specialized, focused agents
- Minimal context overhead

## Requirements

**Required**:
- Claude Code
- Git
- jq

**For full features**:
- `linearis` - Linear integration (install: `npm install -g --install-links ryanrozich/linearis#feat/cycles-cli`)
- `gh` - GitHub CLI
- `railway` - Railway deployments
- `sentry-cli` - Error monitoring
- `humanlayer` - Thoughts system (optional)

Run `./hack/check-prerequisites.sh` to check what you have.

## License

MIT - Use it however you want!

## About

Built by [@ryanisaacg](https://github.com/ryanisaacg) using Claude Code.

This represents hundreds of hours of refinement on real projects. I'm sharing it because I believe in open source and want to see what the community builds with these patterns.

---

**Want to chat about workflows, contribute ideas, or share your fork?**
Open an issue or discussion - I'd love to hear from you!
