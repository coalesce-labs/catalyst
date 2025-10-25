---
date: 2025-10-25T19:00:00+0000
author: Claude
repository: catalyst (formerly ryan-claude-workspace)
topic: "Catalyst Plugin Organization Proposal"
tags: [proposal, plugins, architecture, organization]
status: draft-for-review
---

# Catalyst Plugin Organization Proposal

## Overview

This document proposes a specific organization of the 37 components (7 agents, 25 commands, 5 scripts) into focused Catalyst plugins. The goal is to create **composable, independently installable plugins** that serve distinct user personas and workflow stages.

## Proposed Plugin Structure

### Plugin 1: `catalyst-research` ⭐ **THE DIFFERENTIATOR**

**Tagline**: "Deep codebase understanding with specialized AI agents"

**What it contains**:
- **6 agents**: codebase-locator, codebase-analyzer, codebase-pattern-finder, thoughts-locator, thoughts-analyzer, external-research
- **1 command**: `/research-codebase`
- **1 script**: `check-prerequisites.sh`

**Who uses it**: Any developer needing to understand existing code

**When**: Before making changes, learning codebase, onboarding

**Value proposition**: "Most plugins provide commands. We provide comprehensive research agents that actually understand your codebase."

**Why independent**: Research is universally valuable, even without the full workflow

**Dependencies**: None (fully self-contained)

---

### Plugin 2: `catalyst-workflow`

**Tagline**: "Research-driven implementation workflow"

**What it contains**:
- **4 commands**: `/create-plan`, `/implement-plan`, `/validate-plan`, `/workflow-help`
- **1 script**: `check-prerequisites.sh`

**Who uses it**: Developers following structured planning workflow

**When**: After research, through implementation and validation

**Value proposition**: "Transform research into action with guided planning, implementation, and validation"

**Why independent**: Can work without research plugin (user provides own research), can work without Linear

**Dependencies**: Optional - works better with catalyst-research

**Note**: Includes `/workflow-help` as it guides through the entire workflow system

---

### Plugin 3: `catalyst-dev`

**Tagline**: "Smart development workflows"

**What it contains**:
- **3 commands**: `/commit`, `/describe-pr`, `/debug`
- **0 scripts**: (commit and describe-pr use only git, debug uses Task)

**Who uses it**: All developers, daily operations

**When**: During and after implementation

**Value proposition**: "Smart commits, PR descriptions, and debugging for daily development"

**Why independent**: Universal dev tools, no special dependencies

**Dependencies**: None

---

### Plugin 4: `catalyst-pm`

**Tagline**: "Project management and parallel work"

**What it contains**:
- **2 commands**: `/create-worktree`, `/update-project`
- **3 scripts**: `create-worktree.sh`, `update-project.sh`, `frontmatter-utils.sh`

**Who uses it**: Tech leads, developers managing multiple features

**When**: Starting features, distributing workspace updates

**Value proposition**: "Manage parallel work with git worktrees and distribute improvements across projects"

**Why independent**: Worktrees are useful independent of other workflows

**Dependencies**: None

**Note**: `/update-project` is for workspace maintainers distributing improvements

---

### Plugin 5: `catalyst-linear` ⚠️ **NEEDS DISCUSSION**

**Tagline**: "Linear integration for the complete development workflow"

**What it contains** (Option A - All Linear):
- **4 commands**: `/linear`, `/linear-setup-workflow`, `/create-pr`, `/merge-pr`
- **1 script**: `check-prerequisites.sh`

**Who uses it**: Teams using Linear for project management

**When**: Throughout development lifecycle

**Value proposition**: "Seamless Linear integration from ticket creation to PR merge"

**Why independent**: Linear is optional, teams without it don't need these commands

**Dependencies**: Requires Linear MCP server

**Questions for you**:
1. Should `/create-pr` and `/merge-pr` be in `catalyst-dev` instead? (They're git operations that happen to integrate Linear)
2. Should we split into `catalyst-linear-basic` (linear, linear-setup-workflow) and `catalyst-linear-git` (create-pr, merge-pr)?
3. Are there dev-only Linear operations (like commenting on issues) vs PM operations (creating tickets)?

---

### Plugin 6: `catalyst-handoff`

**Tagline**: "Context persistence across sessions"

**What it contains**:
- **2 commands**: `/create-handoff`, `/resume-handoff`
- **1 script**: `check-prerequisites.sh`

**Who uses it**: Developers with context limits, switching contexts frequently

**When**: When pausing work, when resuming

**Value proposition**: "Save and restore context seamlessly across sessions"

**Why independent**: Useful for anyone hitting context limits

**Dependencies**: None (works with or without thoughts system)

---

### Plugin 7: `catalyst-meta` ⭐ **YOUR IDEA**

**Tagline**: "Tools for creating and managing Catalyst workflows"

**What it contains**:
- **5 commands**: `/discover-workflows`, `/import-workflow`, `/create-workflow`, `/validate-frontmatter`, `/workflow-help`
- **1 script**: `validate-frontmatter.sh` (for Trunk integration)

**Who uses it**: Workspace architects, advanced developers extending Catalyst

**When**: Creating new workflows, discovering patterns, maintaining quality

**Value proposition**: "Meta-plugin for creating plugins - discover, import, and create workflows"

**Why independent**: For power users and workspace maintainers only

**Dependencies**: None

**Note**: This is workspace-only in current design (these commands marked `workspace_only: true`)

**Questions for you**:
1. Should `/workflow-help` be here or in `catalyst-workflow`? (It guides users through workflows but is also a meta tool)
2. Should this be installable by end users, or truly workspace-only?

---

## Alternative Organization: Linear Split

### Option B: Split Linear by Function

**catalyst-linear-pm**: Project management operations
- `/linear` - Ticket CRUD, status updates
- `/linear-setup-workflow` - Workflow configuration

**catalyst-linear-git**: Git operations with Linear integration
- `/create-pr` - PR creation with Linear update
- `/merge-pr` - PR merge with Linear completion

**Rationale**: Separates "working with tickets" from "working with PRs"

**Question**: Is this over-engineered, or does it serve different personas?

---

### Option C: Merge Linear into Existing Plugins

**catalyst-pm**:
- Current: create-worktree, update-project
- Add: linear, linear-setup-workflow

**catalyst-dev**:
- Current: commit, describe-pr, debug
- Add: create-pr, merge-pr

**Rationale**: Commands live with what they primarily do (PM = tickets, Dev = PRs)

**Question**: Does this hide the Linear integration, making it less discoverable?

---

## Scripts Organization

### Scripts in Plugins

**Duplicated across multiple plugins**:
- `check-prerequisites.sh` → In research, workflow, linear, handoff (4 copies)
  - Small file (~100 lines)
  - Self-contained plugins
  - Standard plugin pattern

**PM plugin only**:
- `create-worktree.sh` → Called by `/create-worktree`
- `update-project.sh` → Called by `/update-project`
- `frontmatter-utils.sh` → Sourced by `update-project.sh`

**Meta plugin**:
- `validate-frontmatter.sh` → Used by Trunk linter

### Scripts Staying at Workspace Root (hack/)

**Installation & setup** (not packaged in plugins):
- `install-user.sh`
- `install-project.sh`
- `setup-thoughts.sh`
- `init-project.sh`
- `setup-multi-config.sh`
- `add-client-config`
- `setup-linear-workflow`
- `hl-switch`

**Rationale**: These are migration/setup tools for workspace maintainers, not runtime utilities

---

## User Personas & Plugin Mapping

### Persona 1: **Junior/Mid Developer** (Learning codebase, implementing features)
**Installs**:
- `catalyst-research` (understand code)
- `catalyst-dev` (daily work)
- `catalyst-handoff` (when context fills)

**Workflow**: Research → implement → commit → handoff when needed

---

### Persona 2: **Senior Developer / Tech Lead** (Planning, architecting, mentoring)
**Installs**:
- `catalyst-research` (deep analysis)
- `catalyst-workflow` (structured planning)
- `catalyst-dev` (implementation)
- `catalyst-pm` (worktrees for parallel work)
- `catalyst-linear` (ticket management)
- `catalyst-handoff` (context management)

**Workflow**: Full workflow - research → plan → implement in worktree → validate → PR → merge

---

### Persona 3: **Project Manager** (Ticket management, status tracking)
**Installs**:
- `catalyst-research` (understand capacity/complexity)
- `catalyst-linear` (ticket management)

**Workflow**: Create tickets, track progress, understand blockers

---

### Persona 4: **Workspace Architect** (Maintaining workspace, creating tools)
**Installs**:
- `catalyst-meta` (discover, create, validate workflows)
- Plus any plugins they're working on

**Workflow**: Discover patterns → import → adapt → validate → distribute

---

### Persona 5: **QA / Validation Engineer** (Testing, verification)
**Installs**:
- `catalyst-research` (understand what should happen)
- `catalyst-workflow` (validation commands)
- `catalyst-dev` (debug issues)

**Workflow**: Read research/plan → validate → debug issues

---

## Plugin Dependency Graph

```
catalyst-research (standalone)
    ↓ (optional)
catalyst-workflow (can use research for context)
    ↓ (optional)
catalyst-dev (commit, describe-pr used after implementation)
    ↓ (optional)
catalyst-linear (PR commands build on dev commands)

catalyst-pm (standalone - worktrees, project updates)

catalyst-handoff (standalone - context management)

catalyst-meta (standalone - for workspace maintenance)
```

**Key insight**: Most plugins are independent. Optional dependencies make the system more powerful but aren't required.

---

## Installation Scenarios

### Scenario 1: "I just want to understand codebases"
```bash
/plugin install catalyst-research@catalyst
```
Gets: 6 research agents + /research-codebase command

---

### Scenario 2: "I want the full workflow"
```bash
/plugin install catalyst-research@catalyst
/plugin install catalyst-workflow@catalyst
/plugin install catalyst-dev@catalyst
```
Gets: Research → Plan → Implement → Validate → Commit → PR

---

### Scenario 3: "I'm using Linear and want automation"
```bash
/plugin install catalyst-research@catalyst
/plugin install catalyst-workflow@catalyst
/plugin install catalyst-dev@catalyst
/plugin install catalyst-linear@catalyst
```
Gets: Full workflow + Linear ticket automation

---

### Scenario 4: "I manage parallel features"
```bash
/plugin install catalyst-pm@catalyst
```
Gets: Worktree creation and project updates

---

### Scenario 5: "I want to extend the workspace"
```bash
/plugin install catalyst-meta@catalyst
```
Gets: Workflow discovery, creation, validation tools

---

## Bundle Recommendations

### "Starter Pack" (Recommended for most developers)
```bash
catalyst-research + catalyst-dev
```
**Why**: Universal value - understand code, make commits, write PRs

---

### "Full Workflow" (Structured development)
```bash
catalyst-research + catalyst-workflow + catalyst-dev
```
**Why**: Complete research → plan → implement → validate flow

---

### "Linear Team" (Teams using Linear)
```bash
catalyst-research + catalyst-workflow + catalyst-dev + catalyst-linear
```
**Why**: Full workflow + ticket automation

---

### "Power User" (Tech leads, architects)
```bash
ALL PLUGINS
```
**Why**: Access to everything

---

## Key Questions for Alignment Interview

### Question 1: Linear Plugin Organization

**Current proposal**: Single `catalyst-linear` plugin with all 4 commands

**Alternatives**:
- A) Keep as-is (all Linear in one plugin)
- B) Split: `catalyst-linear-pm` (tickets) + `catalyst-linear-git` (PRs)
- C) Merge: Linear tickets → catalyst-pm, Linear PRs → catalyst-dev

**Your preference**:
- [ ] A - Single plugin
- [ ] B - Split by function
- [ ] C - Merge into existing
- [ ] Other: _________________

**Why**: _________________

---

### Question 2: workflow-help Placement

**Current proposal**: In `catalyst-meta` (it's a meta tool for guidance)

**Alternative**: In `catalyst-workflow` (it guides through workflow)

**Your preference**:
- [ ] catalyst-meta (with other meta tools)
- [ ] catalyst-workflow (guides the workflow)
- [ ] Standalone plugin `catalyst-help`
- [ ] Duplicate in both (acceptable for small command)

**Why**: _________________

---

### Question 3: Meta Plugin Accessibility

**Current proposal**: `catalyst-meta` is installable like any plugin

**Current behavior**: Commands marked `workspace_only: true` (excluded from project installations)

**Question**: Should this remain workspace-only, or be generally available?

**Options**:
- A) Workspace-only (only maintainers use these tools)
- B) Generally available (anyone can create workflows)
- C) Hybrid (some commands workspace-only, others available)

**Your preference**:
- [ ] A - Workspace-only
- [ ] B - Publicly available
- [ ] C - Hybrid

**If hybrid, which commands should be public**: _________________

---

### Question 4: Plugin Naming Conventions

**Current proposal**: All plugins prefixed with `catalyst-`

**Alternatives**:
- A) `catalyst-research`, `catalyst-workflow`, etc. (current)
- B) `research`, `workflow`, etc. (simpler, relies on marketplace name)
- C) `catalyst/research`, `catalyst/workflow` (namespace-style)

**Your preference**:
- [ ] A - catalyst- prefix
- [ ] B - No prefix
- [ ] C - Namespace style
- [ ] Other: _________________

---

### Question 5: Starter Bundle

**Should we create documentation recommending a "starter pack"?**

**Current thinking**: Recommend `catalyst-research + catalyst-dev` for most users

**Question**: Should we make this explicit in README?

**Your preference**:
- [ ] Yes - clear starter recommendations
- [ ] No - let users choose
- [ ] Yes, but multiple tiers (basic, advanced, power user)

**If yes, what tiers**: _________________

---

### Question 6: Script Duplication

**Current proposal**: Duplicate `check-prerequisites.sh` in 4 plugins

**Alternative**: Create shared `catalyst-utils` plugin

**Your preference**:
- [ ] Duplicate (self-contained plugins, standard pattern)
- [ ] Shared plugin (single source of truth, adds dependency)

**Why**: _________________

---

### Question 7: describe-pr Placement

**Current proposal**: In `catalyst-dev` (it's a daily dev operation)

**Context**: Also called automatically by `/create-pr` in `catalyst-linear`

**Question**: Should it be:
- A) In catalyst-dev (current)
- B) In catalyst-linear (with other PR commands)
- C) Standalone plugin
- D) Duplicated in both

**Your preference**:
- [ ] A - catalyst-dev
- [ ] B - catalyst-linear
- [ ] C - Standalone
- [ ] D - Duplicate

**Why**: _________________

---

### Question 8: create-pr and merge-pr Placement

**Current proposal**: In `catalyst-linear` (they update Linear tickets)

**Context**: They're primarily git operations that happen to integrate Linear

**Question**: Should they be:
- A) In catalyst-linear (current - emphasizes Linear integration)
- B) In catalyst-dev (git operations)
- C) In catalyst-pm (project management)
- D) New plugin catalyst-git-workflow

**Your preference**:
- [ ] A - catalyst-linear
- [ ] B - catalyst-dev
- [ ] C - catalyst-pm
- [ ] D - catalyst-git-workflow

**Why**: _________________

---

### Question 9: Thoughts System Integration

**Context**: Many commands use thoughts system (research, plans, handoffs, PRs)

**Question**: Should thoughts be:
- A) Optional (current - commands work without it)
- B) Required (enforce thoughts system usage)
- C) Separate plugin `catalyst-thoughts` with thoughts-specific features

**Your preference**:
- [ ] A - Optional
- [ ] B - Required
- [ ] C - Separate plugin

**Why**: _________________

---

### Question 10: Plugin Versioning Strategy

**Context**: 7 plugins, all starting at v1.0.0

**Question**: Should plugins:
- A) Version independently (catalyst-research v1.2.0, catalyst-dev v1.0.1, etc.)
- B) Version together (all plugins always same version)
- C) Major versions together, minor independent

**Your preference**:
- [ ] A - Fully independent
- [ ] B - Always synchronized
- [ ] C - Major sync, minor independent

**Why**: _________________

---

## Next Steps After Alignment

Once we align on these questions, we'll:

1. **Finalize plugin structure** - Lock in what goes where
2. **Create detailed migration plan** - Step-by-step restructure
3. **Generate plugin.json files** - All 7 manifests
4. **Update command references** - Script paths, documentation
5. **Create marketplace.json** - Distribution catalog
6. **Update documentation** - README, migration guides
7. **Test locally** - Verify each plugin works
8. **Release v1.0.0** - Tag and publish

## Summary of Proposal

**7 Plugins**:
1. `catalyst-research` (6 agents, 1 command) ⭐
2. `catalyst-workflow` (4 commands)
3. `catalyst-dev` (3 commands)
4. `catalyst-pm` (2 commands, 3 scripts)
5. `catalyst-linear` (4 commands) ⚠️ needs discussion
6. `catalyst-handoff` (2 commands)
7. `catalyst-meta` (5 commands) ⭐ your idea

**Key characteristics**:
- Independent installation
- Clear user personas
- Composable (work together, work apart)
- Self-contained (duplicate scripts where needed)
- Focused purpose (each plugin does one thing well)

**Open questions**: 10 alignment questions above

---

## Your Turn

Please review this proposal and:

1. **Answer the 10 alignment questions** (or discuss them)
2. **Identify anything you disagree with**
3. **Suggest alternative organizations** if you have better ideas
4. **Clarify any confusion** about current functionality

After alignment, we'll move to the `/create-plan` phase with a locked-in structure!
