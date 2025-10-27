# Plugin Cleanup & Worktree Workflow Research

**Date**: 2025-10-25 **Purpose**: Research how to clean up source directories and optimize worktree
workflow with plugins

## Current State Analysis

### Workflow Context System

**Location**: `.claude/.workflow-context.json` (gitignored)

**Purpose**: Tracks workflow documents across sessions:

```json
{
  "lastUpdated": "2025-10-13T23:21:52Z",
  "currentTicket": "COA-15",
  "mostRecentDocument": {
    "type": "handoffs",
    "path": "thoughts/shared/handoffs/test-handoff.md",
    "created": "2025-10-13T23:21:52Z",
    "ticket": "COA-15"
  },
  "workflow": {
    "research": [...],
    "plans": [...],
    "handoffs": [...],
    "prs": []
  }
}
```

**Management Script**: `hack/workflow-context.sh` (copied to `plugins/dev/scripts/`)

**Commands Using It**:

- `implement_plan` - Gets most recent plan if no arg provided
- `create_plan` - Adds plan to context
- `create_pr` - Adds PR to context
- `resume_handoff` - Gets most recent handoff
- `research_codebase` - Adds research to context
- `create_handoff` - Adds handoff to context

**Commands NOT Using It (but should)**:

- `validate_plan` - Could get most recent plan from context
- `create_pr` - Could read all context docs for better PR description
- Various commands could default to context when no args provided

### Directory Structure

**Source Directories** (in repo root):

```
commands/          # 7 namespace directories
agents/            # 11 agent files
hack/              # 16 utility scripts
```

**Plugin Directories**:

```
plugins/dev/commands/    # 18 commands
plugins/dev/agents/      # 11 agents
plugins/dev/scripts/     # 4 scripts
plugins/meta/commands/   # 5 commands
```

**Local .claude/ Installation**:

```
.claude/
├── agents/              # OLD installation (should delete)
├── commands/            # OLD installation (should delete)
├── config.json          # Keep (project-specific)
├── .workflow-context.json  # Keep (project state)
└── .gitignore          # Keep
```

### Claude Code Plugin Architecture (from docs)

**Per-Workspace**:

- `.claude/commands/` - Project-specific, committed to repo
- `.claude/agents/` - Project-specific, committed to repo
- `.claude/config.json` - Project config
- `.claude/.workflow-context.json` - Project state (gitignored)

**Global**:

- `~/.claude/commands/` - User-level commands
- `~/.claude/agents/` - User-level agents

**Plugins** (marketplace):

- Installed per-workspace
- Located in `.claude-plugins/` or similar
- Can be shared across workspaces via marketplace

## Worktree Plugin Workflow

### Problem

When creating a worktree for parallel work:

1. Plugin installation state is unclear
2. Config/context files don't transfer
3. Thoughts system needs init in new directory

### Current create_worktree.md Approach

Creates worktree but doesn't:

- ❌ Copy `.claude/config.json`
- ❌ Copy `.claude/.workflow-context.json`
- ❌ Init thoughts in new worktree
- ❌ Install plugins
- ❌ Set up any state

### Proposed Solution

**Option 1: Copy Everything**

```bash
# After creating worktree
cp -r .claude/config.json ../worktree-dir/.claude/
cp -r .claude/.workflow-context.json ../worktree-dir/.claude/
cd ../worktree-dir
humanlayer thoughts init
/plugin install catalyst-dev
```

**Option 2: Symlink State**

```bash
# Symlink shared state but keep separate workspace config
ln -s $(pwd)/.claude/.workflow-context.json ../worktree-dir/.claude/
ln -s $(pwd)/.claude/config.json ../worktree-dir/.claude/
```

**Option 3: Shared .claude/ (Recommended)** Since worktrees share `.git/`, they could share
`.claude/`:

```bash
# In worktree, symlink to main .claude
ln -s ../main-repo/.claude ../worktree-dir/.claude
```

This would give all worktrees:

- ✅ Same plugin installation
- ✅ Shared workflow context
- ✅ Shared config
- ✅ Single source of truth

### Thoughts System in Worktrees

**Current Issue**: thoughts/ is symlinked per-project

**Solution**: Thoughts are already centralized at `~/thoughts/repos/{project}/`

- Each worktree can `humanlayer thoughts init` pointing to same project
- OR symlink thoughts/ from main worktree
- Shared memory works across all worktrees automatically!

## Cleanup Plan

### Files to DELETE

**Source directories** (duplicated in plugins/):

```bash
rm -rf commands/      # 7 namespaces → plugins/dev/commands/
rm -rf agents/        # 11 agents → plugins/dev/agents/
```

**Keep hack/** because:

- Development/setup scripts
- install-user.sh, install-project.sh
- setup-thoughts.sh
- Not runtime, used for workspace maintenance

**Local .claude/ cleanup**:

```bash
rm -rf .claude/agents/
rm -rf .claude/commands/
# Keep: config.json, .workflow-context.json, .gitignore
```

Then install our own plugin:

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
```

### Documentation to UPDATE

**QUICKSTART.md**: ❌ Currently shows clone & install scripts

- Should show plugin installation
- Should explain thoughts setup (still needed)
- Should show first workflow use

**All docs mentioning installation**: Need audit

## Missing Context Integrations

### Commands that should use workflow-context.json

**validate_plan**:

```bash
# If no plan file argument
PLAN_FILE=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent plans)
```

**create_pr**:

```bash
# Read all context for comprehensive PR description
PLAN=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent plans)
RESEARCH=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent research)
HANDOFFS=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ticket "$TICKET")
```

**implement_plan** (already has it):

```bash
# Already uses context for default plan
PLAN_FILE=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent plans)
```

**resume_handoff** (already checks, but could be smarter):

```bash
# Could use ticket from branch name to find right handoff
TICKET=$(git branch --show-current | grep -oE '[A-Z]+-[0-9]+')
HANDOFF=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ticket "$TICKET")
```

## Implementation Priority

### Phase 1: Research Complete ✅

- Understand current state
- Document findings
- Create plan

### Phase 2: Enhance Context Integration

1. Update `validate_plan` to use context
2. Update `create_pr` to read all context
3. Update `resume_handoff` to use ticket-based lookup
4. Test context integration

### Phase 3: Update Documentation

1. Rewrite QUICKSTART.md for plugin installation
2. Update all docs mentioning clone/install
3. Add worktree workflow guide

### Phase 4: Update create_worktree

1. Add .claude/ symlinking option
2. Add thoughts init
3. Add plugin install instructions
4. Test worktree workflow

### Phase 5: Cleanup

1. Delete commands/ and agents/ source directories
2. Clean local .claude/
3. Install our own plugin
4. Verify everything works

## Open Questions

1. **Plugin installation in worktrees**: Can we symlink .claude-plugins/?
2. **.workflow-context.json scope**: Should it be per-worktree or shared?
   - **Shared**: All worktrees see same workflow state
   - **Separate**: Each worktree has isolated workflow
   - **Recommendation**: SHARED - worktrees are for parallel work on same project

3. **hack/ scripts**: Do we still need install-user.sh if using plugins?
   - **Answer**: Maybe for thoughts setup, but could be replaced with plugin init script

4. **Migration path**: How do existing users migrate from installed to plugin?
   - Clean .claude/
   - Install plugin
   - Keep config.json and .workflow-context.json

## Recommendations

### Immediate Actions

1. ✅ **Keep workflow-context.json system** - It works well
2. **Enhance it**: Add more commands that use it for defaults
3. **Document it**: Make it clear this is how context flows between commands

### Worktree Workflow

1. **Symlink .claude/ from main worktree**
   - Simplest approach
   - Shared state and plugins
   - Single source of truth

2. **Thoughts already work** via HumanLayer's centralized ~/thoughts/

3. **Update create_worktree command** to set up symlinks automatically

### Cleanup Strategy

1. **Delete source commands/ and agents/** - They're in plugins/ now
2. **Keep hack/** - Still useful for setup/maintenance
3. **Clean local .claude/** - Install our own plugin
4. **Update all docs** - Plugin installation only

## Next Steps

1. Present findings to user
2. Get confirmation on approach
3. Create detailed implementation plan
4. Execute in phases
