# Catalyst Tooling Integration Plan

**Date**: 2025-10-25 **Purpose**: Comprehensive plan for integrating external tooling into Catalyst
v1.0.0

## Executive Summary

This document outlines the integration of 7 external tools/services into the Catalyst plugin system:

- **Exa** (web search MCP)
- **Linearis** (Linear CLI with cycles support)
- **Railway CLI** (deployment platform)
- **Sentry CLI** (error tracking)
- **GitHub CLI** (gh)
- **PostHog MCP** (analytics)
- **Context7** (library documentation)

## Tool Categories

### 1. MCP Servers (Claude Code plugins)

- **Exa** - Web search and research
- **PostHog** - Product analytics
- **Context7** - Library documentation (already available)
- **DeepWiki** - GitHub repo research (already available)

### 2. CLI Tools (system prerequisites)

- **humanlayer** - Context management and thoughts system (CRITICAL)
- **linearis** - Linear ticket management
- **railway** - Deployment and infrastructure
- **sentry-cli** - Error tracking and releases
- **gh** - GitHub operations
- **jq** - JSON processing (already required)

## Detailed Tool Specifications

### Exa MCP Server

**Purpose**: Real-time web search for research agents

**Installation**:

```bash
/plugin marketplace add exa-labs/exa-mcp-server
# or
claude mcp add-json "exa" '{"command":"npx","args":["exa-mcp-server"],"env":{"EXA_API_KEY":"your-api-key-here"}}'
```

**Tools Available**:

- `mcp__exa__search` - Web search
- `mcp__exa__search_code` - Code search
- `mcp__exa__company_research` - Company research
- `mcp__exa__crawl_url` - Content extraction
- `mcp__exa__linkedin_search` - LinkedIn search

**Config Required**:

```json
{
  "exa": {
    "apiKey": "[NEEDS_SETUP]"
  }
}
```

### Linearis CLI

**Purpose**: Linear ticket management optimized for LLMs (~1k tokens vs 13k for MCP)

**Installation**:

```bash
npm install -g --install-links ryanrozich/linearis#feat/cycles-cli
```

**Key Commands**:

- `linearis issues list --team TEAM`
- `linearis issues read TICKET-123`
- `linearis issues create --team TEAM --title "..." --description "..."`
- `linearis issues update TICKET-123 --status "In Progress"`
- `linearis cycles list --team TEAM --active`
- `linearis cycles read "Sprint 2025-10" --team TEAM`
- `linearis projects list --team TEAM`
- `linearis labels list --team TEAM`
- `linearis usage` - Full command reference

**Authentication**:

- Environment variable: `LINEAR_API_TOKEN`
- Or file: `~/.linear_api_token`

**Config Required**:

```json
{
  "linear": {
    "teamKey": "ENG",
    "defaultTeam": "Backend",
    "apiToken": "[NEEDS_SETUP]"
  }
}
```

### Railway CLI

**Purpose**: Deployment management and runtime debugging

**Installation**:

```bash
# via npm
npm install -g @railway/cli
# or via homebrew
brew install railway
```

**Key Commands**:

- `railway login`
- `railway link` - Link to project
- `railway up` - Deploy
- `railway redeploy` - Redeploy latest
- `railway logs` - View logs
- `railway status` - Check deployment status
- `railway vars` - Manage environment variables

**Authentication**:

- `railway login` for interactive
- `RAILWAY_TOKEN` environment variable for CI/CD

**Config Required**:

```json
{
  "railway": {
    "projectId": "[NEEDS_SETUP]",
    "defaultService": "[NEEDS_SETUP]"
  }
}
```

### Sentry CLI

**Purpose**: Error tracking, release management, source maps

**Installation**:

```bash
curl -sL https://sentry.io/get-cli/ | sh
# or pinned version
SENTRY_CLI_VERSION="2.56.1" curl -sL https://sentry.io/get-cli/ | sh
```

**Key Commands**:

- `sentry-cli releases new VERSION`
- `sentry-cli releases set-commits VERSION --auto`
- `sentry-cli sourcemaps upload`
- `sentry-cli logs list`
- `sentry-cli repos list`

**Authentication**:

- `~/.sentryclirc` config file
- Or `SENTRY_AUTH_TOKEN` environment variable

**Config Required**:

```json
{
  "sentry": {
    "org": "[NEEDS_SETUP]",
    "project": "[NEEDS_SETUP]",
    "authToken": "[NEEDS_SETUP]"
  }
}
```

### GitHub CLI (gh)

**Purpose**: PR management, issue tracking, repository operations

**Installation**:

```bash
brew install gh
# or other package managers
```

**Key Commands**:

- `gh pr create --title "..." --body "..."`
- `gh pr view NUMBER`
- `gh pr merge NUMBER`
- `gh issue list`
- `gh repo view`

**Authentication**:

- `gh auth login`

**Config Required**: None (already authenticated)

### PostHog MCP

**Purpose**: Product analytics, feature flags, A/B testing

**Installation**:

```bash
# Use PostHog Wizard or manual:
claude mcp add-json "posthog" '{"command":"uv","args":["--directory","/path/to/posthog-mcp","run","posthog_mcp"]}'
```

**Tools Available**:

- `mcp__posthog__list_projects`
- `mcp__posthog__create_annotation`
- `mcp__posthog__get_feature_flags`
- `mcp__posthog__get_funnel_data`
- `mcp__posthog__get_experiments`

**Config Required**:

```json
{
  "posthog": {
    "apiKey": "[NEEDS_SETUP]",
    "projectId": "[NEEDS_SETUP]"
  }
}
```

### HumanLayer CLI

**Purpose**: Context management, thoughts system, workflow persistence (CRITICAL DEPENDENCY)

**Installation**:

```bash
# Install HumanLayer CLI
pip install humanlayer
# or with pipx
pipx install humanlayer
```

**Key Commands**:

- `humanlayer thoughts init --directory <repo_name>`
- `humanlayer thoughts sync`
- `humanlayer thoughts status`
- `humanlayer thoughts add <file>`

**Usage in Catalyst**:

- **CRITICAL DEPENDENCY** - Core to entire workflow system
- `/research-codebase` - Saves research to `thoughts/shared/research/`
- `/create-plan` - Saves plans to `thoughts/shared/plans/`
- `/create-handoff` - Saves handoffs to `thoughts/shared/handoffs/`
- `/create-worktree` - Initializes thoughts in new worktrees
- Enables shared context across team and worktrees
- Git-backed persistence outside conversation context

**Authentication**:

- Configured via `humanlayer login`

**Config Required**: None (CLI handles auth)

## Prerequisites Check Script

Update `scripts/check-prerequisites.sh`:

```bash
#!/usr/bin/env bash
# Check all required tools are installed

set -euo pipefail

REQUIRED_TOOLS=(
  "humanlayer:HumanLayer CLI:pip install humanlayer"
  "jq:JSON processor:brew install jq"
  "gh:GitHub CLI:brew install gh"
  "linearis:Linear CLI:npm install -g --install-links ryanrozich/linearis#feat/cycles-cli"
  "railway:Railway CLI:npm install -g @railway/cli"
  "sentry-cli:Sentry CLI:curl -sL https://sentry.io/get-cli/ | sh"
)

OPTIONAL_MCPS=(
  "exa:Web search:/plugin marketplace add exa-labs/exa-mcp-server"
  "posthog:Analytics:/plugin marketplace add posthog-mcp"
)

missing=()

for tool_spec in "${REQUIRED_TOOLS[@]}"; do
  IFS=: read -r cmd name install <<< "$tool_spec"
  if ! command -v "$cmd" &> /dev/null; then
    missing+=("$name ($install)")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ Missing required tools:"
  for tool in "${missing[@]}"; do
    echo "  - $tool"
  done
  exit 1
fi

echo "✅ All required tools installed"
```

## Agent Updates

### Research Agents - Tool References

**Update all research agents to use**:

- `mcp__deepwiki__ask_question` - For GitHub repos (KEEP)
- `mcp__deepwiki__read_wiki_structure` - For GitHub repos (KEEP)
- `mcp__context7__resolve_library_id` - For libraries (KEEP)
- `mcp__context7__get_library_docs` - For libraries (KEEP)
- `mcp__exa__search` - For web search (ADD)
- `mcp__exa__search_code` - For code examples (ADD)

### New Infrastructure Research Agents

#### 1. `linear-research` Agent

**Purpose**: Research Linear tickets, cycles, projects **Tools**: Bash(linearis \*), Read, Grep
**Key Operations**:

- List and search tickets
- Get cycle information
- Project and label lookups
- Milestone tracking

#### 2. `railway-research` Agent

**Purpose**: Research deployments, logs, runtime issues **Tools**: Bash(railway \*), Read **Key
Operations**:

- Deployment status checks
- Log analysis
- Environment variable review
- Service health checks

#### 3. `sentry-research` Agent

**Purpose**: Research errors, releases, performance **Tools**: Bash(sentry-cli _), mcp**sentry**_
(if MCP installed) **Key Operations**:

- Error investigation
- Release tracking
- Source map validation
- Performance monitoring

#### 4. `github-research` Agent (OPTIONAL)

**Purpose**: Research PRs, issues, repository structure **Tools**: Bash(gh \*), Read **Key
Operations**:

- PR and issue lookups
- Repository information
- Workflow run status

## New PM Commands

### 1. `/cycle-plan` Command

**Plugin**: catalyst-pm **Purpose**: Plan work for current or next cycle **Process**:

1. Get current and next cycle info via `linearis cycles`
2. List backlog tickets
3. Interactive planning session
4. Update ticket cycles and milestones

### 2. `/cycle-review` Command

**Plugin**: catalyst-pm **Purpose**: Review cycle progress **Process**:

1. Get active cycle info
2. List tickets by status
3. Calculate completion percentage
4. Identify blockers
5. Generate cycle summary

### 3. `/roadmap-review` Command

**Plugin**: catalyst-pm **Purpose**: Review project roadmap and milestones **Process**:

1. List projects and their status
2. Show milestone progress
3. Identify dependencies
4. Generate roadmap summary

## Plugin Structure (2 Plugins)

### catalyst-dev Plugin

**Complete development workflow from research to production**

- **Agents**:
  - 6 core research agents (codebase-locator, codebase-analyzer, codebase-pattern-finder,
    thoughts-locator, thoughts-analyzer, external-research)
  - 4 infrastructure research agents (linear-research, railway-research, sentry-research,
    github-research)

- **Commands**:
  - **Workflow**: research_codebase, create_plan, implement_plan, validate_plan
  - **Handoff**: create_handoff, resume_handoff
  - **Dev**: commit, describe_pr, debug
  - **Linear/PM**: linear, linear_setup_workflow, create_pr, merge_pr, cycle-plan, cycle-review,
    roadmap-review
  - **Project**: create_worktree
  - **Meta**: workflow_help

- **Scripts**:
  - check-prerequisites.sh (validates all CLI tools)
  - create-worktree.sh
  - workflow-context.sh
  - frontmatter-utils.sh

### catalyst-meta Plugin

**Workflow discovery and creation tools**

- **Commands**:
  - discover_workflows
  - import_workflow
  - create_workflow
  - validate_frontmatter
  - workflow_help (duplicate from dev)

- **Scripts**:
  - check-prerequisites.sh (shared validation)

## Configuration Schema Update

`.claude/config.json` template:

```json
{
  "project": {
    "ticketPrefix": "PROJ",
    "defaultTicketPrefix": "PROJ"
  },
  "linear": {
    "teamKey": "[NEEDS_SETUP]",
    "defaultTeam": "[NEEDS_SETUP]",
    "apiToken": "[NEEDS_SETUP]"
  },
  "railway": {
    "projectId": "[NEEDS_SETUP]",
    "defaultService": "[NEEDS_SETUP]"
  },
  "sentry": {
    "org": "[NEEDS_SETUP]",
    "project": "[NEEDS_SETUP]",
    "authToken": "[NEEDS_SETUP]"
  },
  "exa": {
    "apiKey": "[NEEDS_SETUP]"
  },
  "posthog": {
    "apiKey": "[NEEDS_SETUP]",
    "projectId": "[NEEDS_SETUP]"
  },
  "thoughts": {
    "user": null
  }
}
```

## Implementation Order

1. ✅ Update prerequisite check script
2. ✅ Update research agents with Exa tool references
3. ✅ Create 4 new infrastructure research agents
4. ✅ Rewrite Linear commands for Linearis CLI
5. ✅ Create 3 PM commands (placeholders first)
6. ✅ Update config.json template
7. ✅ Create plugin structures

## Next Steps

1. Update `agents/external-research.md` to include Exa tools
2. Create new infrastructure agents
3. Rewrite Linear commands
4. Create PM command placeholders
5. Update prerequisite script
6. Update config template
