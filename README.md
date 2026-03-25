# Catalyst - Claude Code Workspace

A portable development workflow for Claude Code, packaged as a Claude Code plugin marketplace.

This is the workspace I use daily for AI-assisted development. It's battle-tested on real projects
and optimized for efficient, context-aware AI collaboration. I'm sharing it so others can use it,
fork it, and contribute ideas back.

## Tech Stack & Integrations

Catalyst integrates with your development tools through both **CLI-based** (token-efficient) and **MCP-based** (richer features) approaches:

### Project Management & Issue Tracking
- **Linear** - Issue tracking, sprint planning, ticket lifecycle (CLI via [Linearis](https://www.npmjs.com/package/linearis))
  - `catalyst-dev`: Core research agents and workflow commands
  - `catalyst-pm`: Advanced PM workflows (cycle analysis, milestone tracking, backlog grooming)

### Version Control & Code Hosting
- **GitHub** - Pull requests, code review, repository management (CLI via `gh`)
  - `catalyst-dev`: PR creation, branch management, worktree workflows

### Error Monitoring & Debugging
- **Sentry** - Production error monitoring, stack traces, root cause analysis (MCP + CLI)
  - `catalyst-debugging`: Sentry MCP integration (~20k tokens when enabled)
  - Supports single-project and multi-project configurations

### Product Analytics
- **PostHog** - User behavior, conversion funnels, feature analytics (MCP)
  - `catalyst-analytics`: PostHog MCP integration (~40k tokens when enabled)

### Documentation & Code Search
- **Context7** - Library documentation lookup (MCP, ~2k tokens)
  - `catalyst-dev`: Built-in, always available
- **DeepWiki** - GitHub repository documentation (MCP, ~1.5k tokens)
  - `catalyst-dev`: Built-in, always available
- **Exa** - Web research and external documentation (API)
  - `catalyst-dev`: External research agent

### Thoughts & Memory System
- **HumanLayer** - Persistent memory, shared context, team collaboration (CLI via `humanlayer`)
  - All plugins: Foundation for research, plans, handoffs, and reports

### Token Efficiency Strategy

**Why CLI + lightweight MCP?** Most development sessions don't need heavy integrations:

- Start with `catalyst-dev` (~3.5k tokens): Core workflow + Linear + GitHub
- Enable `catalyst-analytics` when analyzing user behavior (~+40k tokens)
- Enable `catalyst-debugging` when investigating production errors (~+20k tokens)
- Disable when done to free context for code and conversation

This keeps your typical session lean while having powerful tools available when needed.

## What's Inside

**Catalyst** is a 5-plugin system for Claude Code focused on **token efficiency**, **session-aware
MCP management**, and **persistent context** through parallel agent research, structured handoffs,
and shared memory systems.

**catalyst-dev** (Core - Always enabled)

- 9 research agents (codebase + infrastructure)
- 21 skills covering full dev lifecycle
- Three-tier model strategy (Opus for planning/implementation, Sonnet for CI/automation, Haiku for data collection)
- Linear integration via Linearis CLI
- CI/automation commands for non-interactive workflows
- Handoff system for context persistence
- ~3.5k context (lightweight MCPs: DeepWiki, Context7)

**catalyst-pm** (Optional - Enable for project management)

- 6 skills for PM workflows (cycle analysis, milestone tracking, backlog grooming)
- 12 specialized agents for data collection and analysis
- 39 skills for product management (PRDs, user research, metrics, interviews, strategy)
- 7 sub-agents forming a review panel (engineering, design, executive, legal, UX, customer voice)
- Research-first architecture (Haiku for data collection, Sonnet/Opus for analysis)
- Cycle management and milestone tracking with target date feasibility
- Actionable insights and recommendations (not just data dumps)

**catalyst-analytics** (Optional - Enable when needed)

- PostHog MCP integration (~40k context)
- Product analytics and user behavior analysis
- Conversion funnels and cohort analysis
- 3 specialized analytics skills

**catalyst-debugging** (Optional - Enable when needed)

- Sentry MCP integration (~20k context)
- Production error monitoring and debugging
- Stack trace analysis and root cause detection
- 3 specialized debugging skills

**catalyst-meta** (Optional - For advanced users)

- 6 skills for workflow management
- Discover workflows from community repos
- Import and adapt patterns
- Create new workflows
- Plugin health auditing and directory reorganization

## Quick Setup (5 Minutes)

Get started in 5 minutes with the unified setup script:

```bash
# Download the setup script
curl -O https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh
chmod +x setup-catalyst.sh

# Run it (requires interactive input)
./setup-catalyst.sh
```

This script will guide you through:
- ✅ Prerequisites check and installation (HumanLayer CLI, jq, etc.)
- ✅ Thoughts repository setup (one per org, backed up to GitHub)
- ✅ Project configuration (ticket prefix, project name)
- ✅ Integration setup (Linear, Sentry, PostHog, Exa)
- ✅ Worktree directory creation
- ✅ HumanLayer thoughts initialization and syncing

**Then install the plugins:**

```bash
# In Claude Code:
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev

# Restart Claude Code
```

You're ready! Try `/research-codebase` in your next session.

See the [documentation site](https://catalyst.coalescelabs.ai) for detailed setup instructions.

## Installation

Alternatively, install plugins manually via Claude Code plugin system:

```bash
# Add the marketplace repository
/plugin marketplace add coalesce-labs/catalyst

# Install core workflow (required)
/plugin install catalyst-dev

# Optional: Install PM plugin (Linear project management)
/plugin install catalyst-pm

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
# Enable PM tools for sprint planning and cycle reviews
/plugin enable catalyst-pm  # Lightweight CLI-based, minimal context

# Enable analytics when analyzing user behavior
/plugin enable catalyst-analytics  # Loads PostHog MCP (+40k context)

# Disable when done to free context
/plugin disable catalyst-analytics  # Unloads PostHog MCP (-40k context)

# Enable debugging for incident response
/plugin enable catalyst-debugging  # Loads Sentry MCP (+20k context)

# Can enable multiple plugins simultaneously
/plugin enable catalyst-pm catalyst-analytics catalyst-debugging
```

**Why this matters**: Most development sessions don't need analytics or debugging MCPs. Starting
with just `catalyst-dev` keeps your context at ~3.5k tokens instead of ~65k, leaving more room for
code and conversation.

### Updating Plugins

Keep your Catalyst plugins up to date with bug fixes and new features:

```bash
# Update the marketplace to fetch latest from GitHub
claude plugin marketplace update catalyst

# Restart Claude Code to load updated plugins
# (Exit and reopen, or start a new session)
```

**When to update:**
- 🐛 **Bug fixes**: Patch versions (e.g., 3.0.0 → 3.0.1) - Fix issues like incorrect CLI syntax
- ✨ **New features**: Minor versions (e.g., 3.0.0 → 3.1.0) - New commands or capabilities
- 🔄 **Breaking changes**: Major versions (e.g., 3.0.0 → 4.0.0) - May require configuration updates

**Important:** A restart is required for plugin updates to take effect. Active sessions use the old version until you restart Claude Code.

**Check your versions:**
```bash
# List installed plugins and their versions
/plugin list
```

**Need help?**

- [Documentation Site](https://catalyst.coalescelabs.ai) - Complete setup, installation, and configuration
- [Claude Code Plugin Guide](https://docs.claude.com/en/docs/claude-code/plugins.md) - Official plugin documentation

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

- [Architecture](docs/architecture.md) - Three-layer system, memory model, agent teams
- [Documentation Site](https://catalyst.coalescelabs.ai) - Complete guides and reference

### Agent Teams

For complex implementations spanning multiple domains, Catalyst supports
[Claude Code agent teams](https://www.anthropic.com/news/claude-opus-4-6) — multiple Claude
instances working in parallel on a shared codebase:

```
/implement-plan --team thoughts/shared/plans/my-plan.md
/oneshot --team PROJ-123
```

A lead agent (Opus) coordinates the work, spawning teammates (Sonnet) that each own distinct files.
Each teammate can spawn its own research sub-agents, enabling two-level parallelism. See
[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
for the patterns behind this approach.

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
- Infrastructure research via CLIs (Sentry, GitHub)

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

- `linearis` - Linear integration (`npm install -g linearis`)
- `gh` - GitHub CLI
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

## Recurring Workflows with /loop

The built-in `/loop` command runs a skill or prompt on a recurring interval. Use it for
monitoring and periodic tasks during active development sessions.

### CI Check Monitoring (after pushing a PR)

```
/loop 2m gh pr checks <PR_NUMBER>
```

Polls every 2 minutes until checks pass or fail.

### Post-Merge Deployment Monitoring

```
/loop 3m gh run list --branch main --limit 3 --json workflowName,status,conclusion
```

Monitors GitHub Actions workflow runs triggered by your merge.

### Daily Context Engineering Dashboard

```
/loop 1d /context-daily
```

Refreshes the context engineering adoption dashboard once per day. Alternative to the
GitHub Actions cron — useful in long-running sessions.

### Cycle Health Monitoring

```
/loop 4h /analyze-cycle
```

Generates a fresh cycle health report every 4 hours during a sprint.

### PR/Linear Sync

```
/loop 2h /sync-prs
```

Checks for orphaned PRs and out-of-sync Linear issues every 2 hours.

**Note**: `/loop` is session-scoped (max ~3 days). For persistent scheduling, use
GitHub Actions cron. `/loop` is best for active monitoring during development sessions.

## Credits

Built on patterns from:

- [HumanLayer](https://github.com/humanlayer/humanlayer) - Thoughts system for shared persistent
  memory and research/plan/implement/validate workflow

Personal refinement over hundreds of hours on real projects.

## Contributing

**This is my personal workflow workspace**, primarily built for my own development style and
preferences. That said, I'm happy to:

- **Discuss ideas** - Open issues with workflow suggestions or improvements
- **See your forks** - Adapt it to your needs and share what you built
- **Fix bugs** - If something's broken, let me know
- **Learn together** - Share your workflow patterns and approaches

**Important**: I may not accept PRs that change core workflows or add features I don't personally
use, since this is the workspace I rely on daily. But I **love** seeing how others adapt these
patterns to their own needs!

**Best approach**: Fork it, make it yours, and share what you learned. That's how we all get
better!

## Documentation

- [Documentation Site](https://catalyst.coalescelabs.ai) - Comprehensive guides, reference, and tutorials
- [Architecture](docs/architecture.md) - Three-layer system and memory model
- [ADRs](docs/adrs.md) - Architecture decision records
- [Releases](docs/releases.md) - Release Please workflow

## License

MIT - Use it however you want!

## Note on Personal Use

This is my personal workflow shared for learning and inspiration. You're welcome to use it as-is, fork it, or adapt the patterns to your own needs. Just keep in mind that it's optimized for my development style, so your mileage may vary. Some decisions are opinionated based on my preferences, and I may not accept PRs that don't align with how I work. Think of it as a starting point rather than a one-size-fits-all solution—take what works, adapt what doesn't!

---

Built by [Coalesce Labs](https://github.com/coalesce-labs)

Want to chat about workflows, contribute ideas, or share your fork? Open an issue or discussion!
