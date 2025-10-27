---
date: 2025-10-25T18:31:12+0000
researcher: Claude
git_commit: 7afffa27e23e674d7075a476c3d51c65a6c011e6
branch: COA-20-fix-markdown-linting-issues
repository: ryan-claude-workspace
topic: "Claude Code Plugin Packaging Strategy and Agent Skills Integration"
tags: [research, claude-code, plugins, skills, packaging, distribution]
status: complete
last_updated: 2025-10-25
last_updated_by: Claude
---

# Research: Claude Code Plugin Packaging Strategy and Agent Skills Integration

**Date**: 2025-10-25T18:31:12+0000 **Researcher**: Claude **Git Commit**:
7afffa27e23e674d7075a476c3d51c65a6c011e6 **Branch**: COA-20-fix-markdown-linting-issues
**Repository**: ryan-claude-workspace

## Research Question

How should the ryan-claude-workspace be packaged for distribution with Claude Code? What are the
differences between plugins, agent skills, and the current .claude/ directory approach? What are the
best practices for creating Claude Code plugins and agent skills, and what is the optimal packaging
strategy for this workspace?

## Summary

Claude Code offers three extensibility mechanisms: the traditional `.claude/` directory structure,
the new plugin system, and agent Skills. Your ryan-claude-workspace is currently using the
`.claude/` directory approach with custom installation scripts. The research reveals that **these
mechanisms are complementary, not mutually exclusive**, and the optimal strategy is a **hybrid
approach** that leverages all three:

1. **Plugin system** for distributable, versioned workflows (agents and commands)
2. **Agent Skills** for autonomous, model-invoked capabilities (where appropriate)
3. **`.claude/` directory** for project-specific configuration and customization

Your workspace is excellently positioned for plugin conversion with minimal changes required. The
core structure (agents/ and commands/ directories) works as-is with the plugin system. The migration
is **additive**—you add plugin capabilities without breaking existing functionality.

Key finding: **Plugins CAN include agent Skills**, making it possible to package everything
together. Skills within plugins are automatically available when the plugin is installed, providing
both explicit commands (user-invoked) and autonomous capabilities (model-invoked).

## Detailed Findings

### Current Workspace Structure and Packaging Approach

**What exists**: The workspace uses a custom file-copying distribution system with three tiers:

**Source layer** (agents/, commands/):

- 6 specialized research agents in `agents/` directory
- 22 commands organized into 7 namespaces in `commands/` directory:
  - `workflow/` - Research, planning, implementation, validation (4 commands)
  - `linear/` - Linear integration (4 commands)
  - `dev/` - Development workflows (3 commands)
  - `handoff/` - Context persistence (2 commands)
  - `meta/` - Workspace management (5 commands, workspace-only)
  - `project/` - Project management (2 commands)

**Installation layer** (.claude/):

- Flattened structure: all agents and commands in single directories
- `config.json` template with generic values
- Metadata tracking via `.workspace-metadata.json`

**Distribution mechanism**:

- Three bash scripts: `install-user.sh`, `install-project.sh`, `update-project.sh`
- File copying with namespace flattening (e.g., `commands/workflow/research_codebase.md` →
  `.claude/commands/research_codebase.md`)
- Smart filtering: workspace-only commands excluded from project installations
- Intelligent updates: conflict detection, checksum tracking, customization preservation

**Key files**:

- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/hack/install-project.sh:45-120` -
  Core installation logic with filtering
- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/hack/update-project.sh:78-195` -
  Smart update with conflict resolution
- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/.claude/config.json` -
  Configuration template

**Connections**:

- Agents are pure, never customized, always overwritten on update
- Commands read configuration from `.claude/config.json` for portability
- Frontmatter flags control installation behavior (`workspace_only`, `install_once`)

### Claude Code Plugin System

**What exists**: Official plugin system introduced in 2024 for distributing extensions via
marketplaces.

**Core architecture**:

- Plugins are directories with `.claude-plugin/plugin.json` manifest
- Component directories at plugin root: `agents/`, `commands/`, `skills/`, `hooks/`
- Marketplace distribution via `marketplace.json` catalog files
- Installation via `/plugin marketplace add` and `/plugin install` commands

**Plugin structure**:

```
plugin-root/
├── .claude-plugin/
│   ├── plugin.json          # Manifest (metadata, paths, config)
│   └── marketplace.json     # Optional: marketplace catalog
├── agents/                  # Default: agent markdown files
├── commands/                # Default: command markdown files
├── skills/                  # Default: agent Skills
├── hooks/                   # Optional: event handlers
└── .mcp.json               # Optional: MCP server config
```

**plugin.json schema** (key fields):

```json
{
  "name": "plugin-name", // REQUIRED: kebab-case identifier
  "version": "1.0.0", // Semantic versioning
  "description": "Brief description",
  "author": { "name": "...", "email": "...", "url": "..." },
  "homepage": "https://docs.url",
  "repository": "https://github.com/owner/repo",
  "license": "MIT",
  "keywords": ["tag1", "tag2"],
  "commands": "./custom/path", // Optional: override default
  "agents": "./custom/path", // Optional: override default
  "hooks": "./hooks.json", // Optional: hooks config
  "mcpServers": "./mcp.json" // Optional: MCP servers
}
```

**Critical rules**:

1. All paths must be relative and start with `./`
2. Custom paths SUPPLEMENT defaults, don't replace them
3. Manifest must be at `.claude-plugin/plugin.json`
4. Component directories must be at plugin root, NOT inside `.claude-plugin/`
5. Environment variable `${CLAUDE_PLUGIN_ROOT}` available for absolute path resolution

**Distribution via marketplaces**:

- Marketplace = catalog of plugins (marketplace.json)
- Hosted on GitHub, GitLab, or any git service
- Can reference plugins in same repo or external repos
- Users add marketplace: `/plugin marketplace add owner/repo`
- Users install plugin: `/plugin install plugin-name@marketplace-name`

**Example marketplace.json**:

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "marketplace-name",
  "version": "1.0.0",
  "plugins": [
    {
      "name": "plugin-name",
      "source": "./path", // Or GitHub repo reference
      "description": "Plugin description",
      "version": "1.0.0",
      "category": "development"
    }
  ]
}
```

**Official documentation links**:

- Plugin overview: https://docs.claude.com/en/docs/claude-code/plugins
- Plugin reference: https://docs.claude.com/en/docs/claude-code/plugins-reference
- Marketplaces: https://docs.claude.com/en/docs/claude-code/plugin-marketplaces
- Settings: https://docs.claude.com/en/docs/claude-code/settings

**Example plugins**:

- Official examples: https://github.com/anthropics/claude-code/tree/main/plugins
- Superpowers by Jesse Vincent: https://github.com/obra/superpowers (v3.2.3)
- Multi-agent system: https://github.com/wshobson/agents (85 agents, 63 plugins)
- Community hub: https://github.com/jeremylongshore/claude-code-plugins-plus (227+ plugins)

**Key capabilities**:

- Versioned distribution with semantic versioning
- Automatic updates via `/plugin update`
- Dependency management (plugins can depend on other plugins)
- Namespace collision resolution (`/plugin-name:command`)
- Team configuration via `.claude/settings.json` for auto-installation

**Limitations**:

- No nested plugin directories (flat structure)
- Paths must be relative
- Cannot override Claude Code core commands
- Plugin names must be globally unique in marketplace

**File references**:

- Plugin manifest location: `.claude-plugin/plugin.json`
- Marketplace catalog: `.claude-plugin/marketplace.json`
- Team settings: `.claude/settings.json`

### Agent Skills System

**What exists**: Model-invoked capabilities that Claude autonomously uses based on task context.

**Core difference from commands**:

- **Commands**: User-invoked with `/command-name` (explicit)
- **Skills**: Model-invoked based on context and Skill description (autonomous)

**How it works**:

1. User makes request: "Help me debug this authentication issue"
2. Claude reads Skill descriptions
3. Claude decides: "The 'debug-auth' Skill is relevant"
4. Claude invokes Skill autonomously without user typing `/debug-auth`

**Skill structure**:

```
skill-name/
├── SKILL.md                 # Required: frontmatter + instructions
├── templates/               # Optional: supporting files
├── examples/                # Optional: usage examples
└── scripts/                 # Optional: helper scripts
```

**SKILL.md format**:

```yaml
---
name: skill-name
description: Clear explanation of what this does and WHEN to use it
allowed-tools: [Read, Write, Grep] # Optional: restrict tool access
---
# Skill instructions

Detailed instructions for Claude on how to use this Skill...
```

**Critical**: The `description` field must include:

1. WHAT the Skill does
2. WHEN to use it (context triggers)
3. WHY it's useful

Example:

```yaml
description:
  "Analyzes authentication failures in web applications. Use when user reports login issues, 401/403
  errors, or token problems. Traces request flow through auth middleware."
```

**Storage locations**:

- Personal Skills: `~/.claude/skills/`
- Project Skills: `<project>/.claude/skills/`
- Plugin Skills: `<plugin-root>/skills/`

**Distribution via plugins**: Yes! Skills can be bundled in plugins. From documentation: "Skills can
also come from Claude Code plugins" and "plugins may bundle Skills that are automatically available
when the plugin is installed."

**Plugin integration**:

```
plugin-root/
├── .claude-plugin/plugin.json
├── commands/                    # User-invoked
├── agents/                      # User-invoked
└── skills/                      # Model-invoked (autonomous)
    ├── research-automation/
    │   └── SKILL.md
    └── plan-validation/
        └── SKILL.md
```

**Tool access control**: Skills can restrict Claude's capabilities via `allowed-tools`:

```yaml
---
name: read-only-research
description: Research codebase without modifications
allowed-tools: [Read, Grep, Glob] # No Write, Edit, Bash
---
```

**Best practices**:

1. Keep each Skill focused on one capability
2. Write descriptions including functionality AND usage triggers
3. Test with team before deployment
4. Document version changes within SKILL.md
5. Maintain clear YAML syntax

**Documentation**:

- Official guide: https://docs.claude.com/en/docs/claude-code/skills
- Examples: https://github.com/anthropics/skills

**When to use Skills vs Commands**:

- **Skill**: "Claude should automatically help with X when it recognizes context"
- **Command**: "User explicitly wants to invoke X workflow"

**Example scenarios**:

Commands (explicit):

- `/research-codebase` - User deliberately starts research phase
- `/create-plan` - User explicitly wants to plan implementation
- `/commit` - User wants to commit changes

Skills (autonomous):

- Skill "debug-workflow" - Claude recognizes debugging context and offers to use systematic
  debugging Skill
- Skill "security-check" - Claude sees security-sensitive code and autonomously applies security
  review Skill
- Skill "test-generation" - Claude recognizes new function and offers to generate tests

**Applicability to your workspace**:

Your current agents and commands are **primarily command-like** (explicit invocation):

- Research workflow is deliberate: user decides "I want to research now"
- Planning is explicit: user says "create a plan"
- Implementation follows plan: user invokes `/implement-plan`

**Potential Skill candidates**: Some capabilities could be Skills for autonomous invocation:

- **Codebase analysis**: When user asks about code, Claude could autonomously use codebase-analyzer
  Skill
- **Pattern recognition**: When user asks "how do we handle X", Claude could autonomously use
  pattern-finder Skill
- **Context handoff**: When context gets full, Claude could autonomously suggest handoff Skill

But most of your workflow is inherently explicit and sequential, making commands the right choice.

### Comparison: Plugins vs Skills vs Current Approach

**Three mechanisms compared**:

| Aspect            | .claude/ Directory                   | Plugins                    | Agent Skills               |
| ----------------- | ------------------------------------ | -------------------------- | -------------------------- |
| **Purpose**       | Project config, direct commands      | Distributable packages     | Autonomous capabilities    |
| **Invocation**    | User explicit (`/command`)           | User explicit (`/command`) | Model autonomous (context) |
| **Location**      | `<project>/.claude/` or `~/.claude/` | `<plugin-root>/`           | `<anywhere>/skills/`       |
| **Discovery**     | Manual (file scanning)               | Marketplace                | Description matching       |
| **Distribution**  | Git clone, file copy                 | Marketplace, versioned     | Via plugins or .claude/    |
| **Versioning**    | None (manual tracking)               | Semantic versioning        | Via plugin versioning      |
| **Updates**       | Manual (scripts)                     | `/plugin update`           | Via plugin update          |
| **Visibility**    | "(project)" or "(user)"              | Plugin name                | Invisible (autonomous)     |
| **Configuration** | `config.json`, `settings.json`       | `plugin.json`              | SKILL.md frontmatter       |
| **Namespace**     | No namespace                         | Optional `/plugin:command` | N/A (not invoked)          |
| **Team sharing**  | Commit to repo                       | Auto-install via settings  | Via plugin or .claude/     |
| **Tool control**  | Via frontmatter                      | Via frontmatter            | `allowed-tools` field      |
| **Packaging**     | Ad-hoc scripts                       | Structured manifest        | SKILL.md format            |

**Compatibility matrix**:

| Can it contain... | .claude/ | Plugin          | Skill |
| ----------------- | -------- | --------------- | ----- |
| Commands          | ✅ Yes   | ✅ Yes          | ❌ No |
| Agents            | ✅ Yes   | ✅ Yes          | ❌ No |
| Skills            | ✅ Yes   | ✅ Yes          | N/A   |
| Hooks             | ✅ Yes   | ✅ Yes          | ❌ No |
| MCP servers       | ✅ Yes   | ✅ Yes          | ❌ No |
| Project config    | ✅ Yes   | ❌ No           | ❌ No |
| Other plugins     | ❌ No    | ⚠️ Dependencies | ❌ No |

**Key insight**: Plugins and .claude/ are **complementary**:

- Plugin: Reusable, versioned workflows
- .claude/: Project-specific configuration and overrides
- Skills: Autonomous capabilities (can be in either)

**Your workspace today**:

```
ryan-claude-workspace/
├── agents/              # Source: reusable agents
├── commands/            # Source: reusable commands
├── .claude/             # Installation layer
│   ├── agents/          # Flattened agents
│   ├── commands/        # Flattened commands
│   └── config.json      # Project config template
└── hack/                # Installation scripts
```

**As plugin**:

```
ryan-claude-workspace/
├── .claude-plugin/
│   ├── plugin.json      # NEW: Plugin manifest
│   └── marketplace.json # NEW: Distribution catalog
├── agents/              # Same: plugin agents/
├── commands/            # Same: plugin commands/
├── skills/              # NEW: Autonomous capabilities
├── .claude/             # Keep: local config
│   ├── settings.json    # Configure plugins
│   └── config.json      # Project-specific values
└── hack/                # Keep: migration scripts
```

### Recommended Packaging Strategy

**Optimal approach: Hybrid multi-mechanism strategy**

**Recommendation**: Use all three mechanisms strategically:

1. **Plugin for distribution** (versioned, reusable workflows)
   - All agents
   - All commands except workspace-only ones
   - Skills (if any)
   - Documentation

2. **Skills for autonomy** (select candidates only)
   - Codebase analysis (autonomous when user asks about code)
   - Pattern finding (autonomous for "how do we..." questions)
   - NOT for sequential workflows (research → plan → implement stays as commands)

3. **.claude/ for configuration** (project-specific values)
   - `settings.json` - Plugin enablement
   - `config.json` - Project values (ticket prefix, Linear config)
   - Project-specific command overrides

**Why hybrid works**:

- Plugin: Solves distribution, versioning, discoverability
- Skills: Adds autonomous intelligence where appropriate
- .claude/: Preserves project customization

**Migration path (additive, non-breaking)**:

Phase 1: Add plugin structure (no changes to existing files)

```bash
mkdir -p .claude-plugin
# Create plugin.json
# Create marketplace.json
```

Phase 2: Test locally

```bash
/plugin marketplace add .
/plugin install ryan-claude-workspace@local
# Verify all commands work
```

Phase 3: Add Skills (optional)

```bash
mkdir -p skills
# Convert select agents to Skills
# Keep command versions too
```

Phase 4: Update documentation

```bash
# Add plugin installation to README
# Keep script installation as alternative
# Document both approaches
```

Phase 5: Publish

```bash
git add .claude-plugin/
git commit -m "Add plugin support"
git tag v1.0.0
git push origin main --tags
```

**Backward compatibility**:

- Existing users continue using `hack/install-project.sh`
- New users use `/plugin install`
- Both work simultaneously
- No breaking changes

**Suggested plugin.json**:

```json
{
  "name": "ryan-claude-workspace",
  "description": "Research-Plan-Implement-Validate workflow system with specialized agents and thoughts system integration",
  "version": "1.0.0",
  "author": {
    "name": "Ryan",
    "url": "https://github.com/coalesce-labs"
  },
  "homepage": "https://github.com/coalesce-labs/ryan-claude-workspace",
  "repository": "https://github.com/coalesce-labs/ryan-claude-workspace",
  "license": "MIT",
  "keywords": [
    "research",
    "planning",
    "implementation",
    "validation",
    "agents",
    "workflows",
    "thoughts-system",
    "linear-integration",
    "worktree"
  ]
}
```

**Note**: No need to specify `commands` or `agents` fields—defaults to `./commands/` and
`./agents/`.

**Suggested marketplace.json**:

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "ryan-claude",
  "version": "1.0.0",
  "description": "Complete AI-assisted development workflow system",
  "owner": {
    "name": "Ryan / Coalesce Labs",
    "url": "https://github.com/coalesce-labs"
  },
  "plugins": [
    {
      "name": "ryan-claude-workspace",
      "source": ".",
      "description": "Research-Plan-Implement-Validate workflow system with specialized agents and thoughts integration",
      "version": "1.0.0",
      "category": "development",
      "keywords": ["research", "planning", "agents", "workflows"]
    }
  ]
}
```

**Installation for users**:

Via plugin (new):

```bash
/plugin marketplace add coalesce-labs/ryan-claude-workspace
/plugin install ryan-claude-workspace@coalesce-labs/ryan-claude-workspace
```

Via script (existing):

```bash
./hack/install-project.sh /path/to/project
```

Both approaches work. Plugin offers:

- Automatic updates via `/plugin update`
- Version management
- Marketplace discoverability
- Team auto-install via settings

Script offers:

- Direct control
- Custom filtering
- Smart conflict resolution
- Metadata tracking

### Skills Conversion Candidates

**Analysis**: Which agents/commands should become Skills?

**Good Skill candidates** (autonomous context matching):

1. **codebase-analyzer** → `analyze-code` Skill
   - Trigger: User asks "how does X work" or "what does this code do"
   - Autonomous: Claude recognizes code understanding request
   - Description: "Analyzes code to explain functionality, data flow, and integration points. Use
     when user asks how code works, what a component does, or needs technical explanation of
     existing implementation."

2. **codebase-pattern-finder** → `find-patterns` Skill
   - Trigger: User asks "how do we handle X" or "show me examples of Y"
   - Autonomous: Claude recognizes pattern search request
   - Description: "Finds existing code patterns and examples in the codebase. Use when user asks
     'how do we...', 'show me examples of...', or seeks consistency with existing patterns."

3. **thoughts-locator** → `search-context` Skill
   - Trigger: User references past work or asks "what did we decide about X"
   - Autonomous: Claude recognizes need for historical context
   - Description: "Searches thoughts system for previous research, decisions, and plans. Use when
     user references past work, asks about previous decisions, or needs historical context."

**NOT good Skill candidates** (explicit workflow invocation):

1. **research_codebase** - Sequential workflow, explicit start
2. **create_plan** - Deliberate planning phase
3. **implement_plan** - Explicit implementation execution
4. **validate_plan** - Explicit validation step
5. **linear** - Explicit ticket management
6. **commit** - Explicit git operation

**Hybrid approach example**:

Keep both command AND Skill:

```
commands/
└── workflow/
    └── research_codebase.md      # Explicit: /research-codebase

agents/
└── codebase-analyzer.md          # Explicit: @agent-codebase-analyzer

skills/
└── analyze-code/
    └── SKILL.md                   # Autonomous: triggered by context
```

User experience:

- User types `/research-codebase` → Explicit workflow
- User asks "how does auth work?" → Skill triggers autonomously
- User invokes `@agent-codebase-analyzer` → Explicit agent

**Conversion example**:

From agent (explicit):

```yaml
---
name: codebase-analyzer
description: Analyzes code to document functionality
tools: Read, Grep, Glob
model: inherit
---
You analyze code to understand how it works...
```

To Skill (autonomous):

```yaml
---
name: analyze-code
description:
  "Analyzes code to explain functionality, data flow, and integration points. Use when user asks how
  code works, what a component does, or needs technical explanation of existing implementation.
  Particularly useful for questions like 'how does X work', 'what does this function do', or
  'explain this code'."
allowed-tools: [Read, Grep, Glob]
---
# Code Analysis Skill

You analyze code to understand how it works...
```

**Key difference**: Description includes WHEN to trigger autonomously.

**Recommendation**: Start without Skills, add later based on usage patterns. Keep commands as
primary interface, add Skills for autonomous assistance.

## Architecture Documentation

### Current File Copying Architecture

**Pattern**: Script-based installation with smart filtering and conflict resolution.

**How it works**:

1. **Source organization**: Namespaced structure for developer clarity
   - `commands/workflow/`, `commands/linear/`, etc.
   - Human-readable organization

2. **Installation flattening**: All files moved to `.claude/commands/`
   - `commands/workflow/research_codebase.md` → `.claude/commands/research_codebase.md`
   - Claude Code requires flat structure for discovery

3. **Smart filtering**: Frontmatter-driven installation logic
   - `workspace_only: true` → Skip in project installations
   - `install_once: true` → Skip on updates if already exists
   - Category-based filtering (meta commands stay in workspace)

4. **Conflict resolution**: Three-way merge on updates
   - Compare workspace version vs project version vs checksums
   - Prompt user: keep local, take workspace, or view diff
   - Preserve customizations by default (safe)

**Key files**:

- `hack/install-project.sh:45-120` - Installation logic with filtering
- `hack/update-project.sh:78-195` - Update logic with conflict detection
- `hack/frontmatter-utils.sh:15-87` - YAML parsing and filtering

### Plugin Architecture

**Pattern**: Manifest-driven package management with marketplace distribution.

**How it works**:

1. **Plugin definition**: Single manifest declares all components
   - `plugin.json` at `.claude-plugin/plugin.json`
   - Metadata, paths, versioning

2. **Component discovery**: Convention over configuration
   - Default paths: `agents/`, `commands/`, `skills/`
   - Optional custom paths via manifest

3. **Marketplace distribution**: Catalog references plugins
   - `marketplace.json` lists available plugins
   - Hosted on any git service (GitHub, GitLab, etc.)

4. **Installation**: Built-in commands manage lifecycle
   - `/plugin marketplace add` - Add marketplace
   - `/plugin install` - Install plugin
   - `/plugin update` - Update to latest version
   - `/plugin uninstall` - Remove plugin

**Data flow**:

```
User → /plugin install → Claude Code
  ↓
Read marketplace.json → Find plugin source
  ↓
Clone/download plugin → Validate plugin.json
  ↓
Scan components (agents/, commands/, skills/)
  ↓
Register with Claude → Available for use
```

**Key insight**: No flattening required—plugin structure preserved.

### Skills Architecture

**Pattern**: Description-based autonomous invocation.

**How it works**:

1. **Skill registration**: Claude scans `skills/` directories
   - Personal: `~/.claude/skills/`
   - Project: `<project>/.claude/skills/`
   - Plugin: `<plugin-root>/skills/`

2. **Context matching**: On each user request
   - Claude reads all Skill descriptions
   - Matches user intent to Skill triggers
   - Decides: invoke Skill or use base capabilities

3. **Tool restriction**: `allowed-tools` field limits permissions
   - Example: Read-only Skill = `[Read, Grep, Glob]`
   - No Write, Edit, Bash access

4. **Execution**: Transparent to user
   - No `/skill-name` invocation
   - Claude applies Skill automatically
   - May mention Skill usage in response

**Data flow**:

```
User request → Claude analyzes intent
  ↓
Read all SKILL.md descriptions
  ↓
Match intent to Skill triggers
  ↓
If match: Apply Skill instructions + tool restrictions
If no match: Use base capabilities
```

### Hybrid Architecture Recommendation

**Pattern**: Plugin for distribution + .claude/ for configuration + Skills for autonomy.

**Structure**:

```
ryan-claude-workspace/
├── .claude-plugin/          # Plugin distribution
│   ├── plugin.json          # Manifest
│   └── marketplace.json     # Catalog
├── .claude/                 # Project configuration
│   ├── settings.json        # Plugin settings
│   └── config.json          # Project values
├── agents/                  # Plugin agents (explicit)
├── commands/                # Plugin commands (explicit)
├── skills/                  # Plugin Skills (autonomous)
└── hack/                    # Migration scripts
```

**Integration points**:

1. Plugin provides reusable capabilities
2. .claude/config.json provides project-specific values
3. Commands read config at runtime for portability
4. Skills provide autonomous assistance
5. Both plugin and scripts work simultaneously

**Backward compatibility**:

- Existing script-based installations continue working
- Plugin installation adds discoverability and versioning
- No breaking changes to command behavior
- Config system works identically in both approaches

## Code References

Quick reference of key files and their roles:

**Current workspace**:

- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/agents/` - 6 agent source files
- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/commands/` - Commands in 7
  namespaces
- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/.claude/config.json` -
  Configuration template
- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/hack/install-project.sh` -
  Project installation script
- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/hack/update-project.sh` - Smart
  update script

**Plugin structure (to be created)**:

- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/.claude-plugin/plugin.json` -
  Plugin manifest
- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/.claude-plugin/marketplace.json` -
  Marketplace catalog
- `/Users/ryan/code-repos/github/coalesce-labs/ryan-claude-workspace/skills/` - Agent Skills (if
  added)

**Official resources**:

- Plugin docs: https://docs.claude.com/en/docs/claude-code/plugins
- Plugin reference: https://docs.claude.com/en/docs/claude-code/plugins-reference
- Marketplaces: https://docs.claude.com/en/docs/claude-code/plugin-marketplaces
- Skills docs: https://docs.claude.com/en/docs/claude-code/skills
- Example plugins: https://github.com/anthropics/claude-code/tree/main/plugins

**Community examples**:

- Superpowers plugin: https://github.com/obra/superpowers
- Multi-agent system: https://github.com/wshobson/agents
- Plugin hub: https://github.com/jeremylongshore/claude-code-plugins-plus

## Open Questions

Areas that would benefit from further investigation:

1. **Skills conversion impact**: Would converting some agents to Skills improve user experience, or
   add confusion with multiple invocation methods?

2. **Namespace organization**: Should commands remain flattened in plugin distribution, or preserve
   namespace structure if plugin system supports it?

3. **Multi-plugin split**: Would splitting into focused plugins (research, planning, linear) improve
   modularity, or add installation friction?

4. **Version management**: How should plugin versioning align with workspace git tags? One-to-one
   mapping or independent?

5. **Marketplace hosting**: Should the workspace host its own marketplace, or integrate into
   existing community marketplaces?

6. **Migration timing**: Should plugin conversion happen now, or wait for more plugin system
   maturity and community best practices?

7. **Skills discoverability**: How do users discover available Skills if they're autonomous? Need
   documentation strategy.

8. **Configuration migration**: Should plugin include config template, or delegate entirely to
   project .claude/ directory?

## Recommendations

Based on comprehensive research of the plugin system, Skills architecture, and your workspace
structure, here are actionable recommendations:

### Phase 1: Add Plugin Support (Immediate, Low Risk)

**Action**: Create minimal plugin structure without changing existing functionality.

**Steps**:

1. Create `.claude-plugin/` directory
2. Write `plugin.json` with metadata (use template from research)
3. Write `marketplace.json` for distribution
4. Test locally: `/plugin marketplace add .`
5. Verify all commands and agents work via plugin
6. Update README with both installation methods
7. Keep existing scripts functional

**Benefits**:

- Versioned distribution
- Marketplace discoverability
- Team auto-install capability
- Zero risk (additive only)

**Effort**: 1-2 hours

### Phase 2: Documentation and Examples (Short Term)

**Action**: Document plugin installation and usage patterns.

**Steps**:

1. Add "Installation" section to README with both methods
2. Create migration guide for existing users
3. Document configuration in plugin context
4. Add examples of project-level .claude/ setup
5. Update CLAUDE.md with plugin architecture

**Benefits**:

- Clear user onboarding
- Reduced support questions
- Better adoption

**Effort**: 2-3 hours

### Phase 3: Evaluate Skills (Medium Term)

**Action**: Test Skills conversion for select capabilities.

**Steps**:

1. Create `skills/` directory
2. Convert `codebase-analyzer` to `analyze-code` Skill
3. Keep command version too (hybrid approach)
4. Test autonomous invocation patterns
5. Gather feedback from usage
6. Decide: expand Skills or keep as commands

**Benefits**:

- Autonomous intelligence
- Better user experience (no explicit invocation)
- Differentiation from command-only plugins

**Effort**: 4-6 hours (experimental)

### Phase 4: Community Distribution (Long Term)

**Action**: Publish to community marketplaces and gather feedback.

**Steps**:

1. Tag v1.0.0 release
2. Submit to community plugin hubs
3. Monitor adoption and issues
4. Iterate based on feedback
5. Establish release cadence

**Benefits**:

- Wider adoption
- Community contributions
- Validation of approach

**Effort**: Ongoing

### Key Principles for Migration

1. **Additive, not destructive**: Keep existing functionality working
2. **Test thoroughly**: Both plugin and script installations
3. **Document both paths**: Users choose what works for them
4. **Preserve configuration**: .claude/ directory remains important
5. **Version properly**: Use semantic versioning from start
6. **Community first**: Engage with plugin ecosystem early

### Decision Framework

**When to use plugins**: If you want wider distribution, versioning, and team auto-install.

**When to use scripts**: If you need custom logic, filtering, or migration from older systems.

**When to use Skills**: If capabilities should be autonomous based on context.

**When to use commands**: If workflows are deliberate, sequential, or explicit.

**Your case**: Use all four—plugins for distribution, scripts for migration, commands for workflows,
Skills (selectively) for autonomy.

### Success Metrics

Track these to evaluate plugin conversion:

1. **Installation adoption**: Plugin vs script usage ratio
2. **User feedback**: Ease of setup and usage
3. **Update frequency**: How often users update via `/plugin update`
4. **Skills usage**: If Skills added, track autonomous invocation frequency
5. **Contribution**: External contributions to plugin

### Next Steps

Immediate actions to take:

1. ✅ **Complete this research** - Document findings (done)
2. ⏭️ **Create plugin.json** - Use template from this research
3. ⏭️ **Create marketplace.json** - Self-referencing catalog
4. ⏭️ **Test locally** - Verify plugin installation works
5. ⏭️ **Update README** - Add plugin installation instructions
6. ⏭️ **Tag v1.0.0** - First plugin release
7. ⏭️ **Gather feedback** - Test with real users

You are in an excellent position to adopt the plugin system—your structure is already compatible,
and the migration is purely additive.
