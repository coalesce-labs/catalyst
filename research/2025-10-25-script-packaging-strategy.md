---
date: 2025-10-25T18:45:00+0000
author: Claude
repository: ryan-claude-workspace → catalyst
topic: "Script Packaging Strategy for Catalyst Plugins"
tags: [research, scripts, packaging, plugins, utilities]
status: complete
---

# Script Packaging Strategy for Catalyst Plugins

## Research Question

How should bash scripts in the `hack/` directory be packaged and referenced within the Catalyst plugin structure? Which scripts should be included with plugins vs kept as workspace-only utilities?

## Summary

Your `hack/` directory contains 14 scripts serving three primary functions: **installation/migration tools**, **runtime utilities** (called by commands), and **prerequisite validators**. The analysis reveals a clear split:

1. **Runtime scripts** (called by commands/agents) → Package in plugin `scripts/` directories
2. **Installation scripts** → Keep at workspace root for backward compatibility
3. **Prerequisite validators** → Package in plugin `scripts/` with `${CLAUDE_PLUGIN_ROOT}` resolution

The recommended approach uses **plugin-level `scripts/` directories** with the `${CLAUDE_PLUGIN_ROOT}` environment variable for path resolution. This ensures scripts work regardless of installation location while maintaining the current relative path patterns your commands use.

## Current Script Inventory

### Category 1: Runtime Utilities (Called by Commands/Agents)

These scripts are **invoked during command execution** and should be packaged with plugins:

#### **check-prerequisites.sh** ⭐ Most Important
- **Called by**: 6 commands (research_codebase, create_plan, implement_plan, create_pr, create_handoff, resume_handoff)
- **Purpose**: Validates HumanLayer CLI, jq, and thoughts system setup
- **Current pattern**: `./hack/check-prerequisites.sh || exit 1`
- **Must be**: Included in multiple plugins (workflow, pm, handoff)

#### **frontmatter-utils.sh**
- **Sourced by**: install-project.sh, update-project.sh
- **Purpose**: Parse YAML frontmatter, check workspace_only/install_once flags
- **Functions**: `should_skip_on_install()`, `should_skip_on_update()`, `get_frontmatter_bool()`
- **Must be**: Available to installation/update scripts

#### **update-project.sh**
- **Called by**: `/update-project` command
- **Purpose**: Smart project updates with conflict resolution
- **Must be**: Available in pm plugin

#### **create-worktree.sh**
- **Called by**: `/create-worktree` command
- **Purpose**: Git worktree creation with automatic setup
- **Must be**: Available in pm plugin

### Category 2: Installation & Setup (Workspace-Only)

These scripts are **used during initial setup** and should remain at workspace root:

- **install-user.sh** - Global installation to ~/.claude/
- **install-project.sh** - Project installation with filtering
- **setup-thoughts.sh** - Initialize ~/thoughts/ repository
- **init-project.sh** - Project-level thoughts initialization
- **setup-multi-config.sh** - Multi-client configuration
- **add-client-config** - Add new client config
- **setup-linear-workflow** - Linear status configuration

**Rationale**: These are migration/setup tools, not runtime utilities. Users run them manually during initial setup or when migrating from script-based to plugin-based installation.

### Category 3: Development Utilities (Workspace-Only)

- **hl-switch** - Switch between HumanLayer configs (installed to ~/bin/)
- **validate-frontmatter.sh** - Trunk linter integration
- **workflow-context.sh** - Purpose unclear, needs investigation

## Claude Code Plugin Script Patterns

### Official Pattern: scripts/ Directory

**Structure**:
```
plugin-root/
├── .claude-plugin/plugin.json
├── commands/
├── agents/
└── scripts/                    # All supporting scripts here
    ├── check-prerequisites.sh
    ├── worktree-helper.sh
    └── utils/
        └── frontmatter.sh
```

### Path Resolution: ${CLAUDE_PLUGIN_ROOT}

**From commands/agents, reference scripts using**:
```bash
# Instead of: ./hack/check-prerequisites.sh
# Use: ${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh

if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" || exit 1
fi
```

**Key benefits**:
- Works regardless of where plugin is installed
- No assumptions about current working directory
- Portable across different installation contexts

### Executable Permissions

**Critical**: All scripts must have executable permissions before distribution:
```bash
chmod +x scripts/*.sh
```

**In git**: Track permissions with:
```bash
git add --chmod=+x scripts/*.sh
git commit -m "Make scripts executable"
```

## Recommended Plugin Structure with Scripts

### Plugin: catalyst-workflow

```
plugins/workflow/
├── .claude-plugin/plugin.json
├── commands/
│   ├── research_codebase.md
│   ├── create_plan.md
│   ├── implement_plan.md
│   └── validate_plan.md
└── scripts/
    ├── check-prerequisites.sh      # Runtime: validates tools
    └── README.md                    # Documents script usage
```

**Usage in commands/research_codebase.md**:
```bash
# Check prerequisites before starting research
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" || exit 1
fi
```

### Plugin: catalyst-pm

```
plugins/pm/
├── .claude-plugin/plugin.json
├── commands/
│   ├── create_worktree.md
│   ├── update_project.md
│   ├── linear.md
│   ├── create_pr.md
│   └── merge_pr.md
└── scripts/
    ├── check-prerequisites.sh      # Runtime: validates tools
    ├── create-worktree.sh          # Core: worktree creation
    ├── update-project.sh           # Core: smart updates
    ├── frontmatter-utils.sh        # Utility: YAML parsing
    └── README.md
```

**Usage in commands/create_worktree.md**:
```bash
# Execute worktree creation script
"${CLAUDE_PLUGIN_ROOT}/scripts/create-worktree.sh" "$WORKTREE_NAME" "$BASE_BRANCH"
```

**Usage in commands/update_project.md**:
```bash
# Execute project update script
"${CLAUDE_PLUGIN_ROOT}/scripts/update-project.sh" "$PROJECT_PATH"
```

### Plugin: catalyst-handoff

```
plugins/handoff/
├── .claude-plugin/plugin.json
├── commands/
│   ├── create_handoff.md
│   └── resume_handoff.md
└── scripts/
    ├── check-prerequisites.sh      # Runtime: validates tools
    └── README.md
```

### Plugin: catalyst-research

```
plugins/research/
├── .claude-plugin/plugin.json
├── agents/
│   ├── codebase-locator.md
│   ├── codebase-analyzer.md
│   ├── codebase-pattern-finder.md
│   ├── thoughts-locator.md
│   ├── thoughts-analyzer.md
│   └── external-research.md
├── commands/
│   └── research_codebase.md
└── scripts/
    ├── check-prerequisites.sh      # Runtime: validates tools
    └── README.md
```

**Note**: Research agents don't currently call scripts directly, but the research_codebase command does.

## Script Sharing Strategy

### Problem: Multiple Plugins Need Same Scripts

**Scripts used by multiple plugins**:
- `check-prerequisites.sh` - Used by workflow, pm, handoff, research plugins
- `frontmatter-utils.sh` - Used by pm plugin (update-project.sh needs it)

### Solution 1: Duplicate Scripts (Recommended)

**Copy check-prerequisites.sh to each plugin that needs it**:

```
plugins/workflow/scripts/check-prerequisites.sh
plugins/pm/scripts/check-prerequisites.sh
plugins/handoff/scripts/check-prerequisites.sh
plugins/research/scripts/check-prerequisites.sh
```

**Pros**:
- Each plugin is self-contained
- No cross-plugin dependencies
- Users can install any plugin independently
- Simple to maintain

**Cons**:
- Slight duplication (but file is small ~100 lines)
- Updates require changing multiple copies

**Recommendation**: This is the standard plugin pattern. Duplication is acceptable for small utilities.

### Solution 2: Shared Scripts Plugin (Alternative)

**Create catalyst-utils plugin**:

```
plugins/utils/
├── .claude-plugin/plugin.json
└── scripts/
    ├── check-prerequisites.sh
    └── frontmatter-utils.sh
```

**Other plugins declare dependency**:
```json
{
  "name": "catalyst-workflow",
  "dependencies": ["catalyst-utils"]
}
```

**Pros**:
- Single source of truth
- Updates propagate automatically

**Cons**:
- Adds complexity
- Forces users to install utils plugin
- Cross-plugin dependencies can break independent installation

**Recommendation**: Only if scripts become very large (>500 lines) or change frequently.

### Decision: Use Duplication

For catalyst, **duplicate check-prerequisites.sh** across plugins. It's small (~100 lines), rarely changes, and ensures plugins work independently.

## Migration Path: hack/ → scripts/

### Step 1: Identify Which Scripts Go Where

**Keep in workspace root (hack/)**:
- install-user.sh
- install-project.sh
- setup-thoughts.sh
- init-project.sh
- setup-multi-config.sh
- add-client-config
- setup-linear-workflow
- hl-switch
- validate-frontmatter.sh (Trunk integration)

**Move to plugins/*/scripts/**:
- check-prerequisites.sh → workflow/, pm/, handoff/, research/
- frontmatter-utils.sh → pm/
- create-worktree.sh → pm/
- update-project.sh → pm/

### Step 2: Update Command References

**Before** (current):
```bash
# In commands/workflow/research_codebase.md
if [[ -f "./hack/check-prerequisites.sh" ]]; then
  ./hack/check-prerequisites.sh || exit 1
fi
```

**After** (plugin):
```bash
# In plugins/workflow/commands/research_codebase.md
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" || exit 1
fi
```

### Step 3: Update Scripts That Source Other Scripts

**Before** (update-project.sh):
```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/frontmatter-utils.sh"
```

**After** (plugin pm/):
```bash
# Both scripts now in same plugin's scripts/ directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/frontmatter-utils.sh"

# OR if using CLAUDE_PLUGIN_ROOT:
source "${CLAUDE_PLUGIN_ROOT}/scripts/frontmatter-utils.sh"
```

**No change needed** - sourcing pattern works the same way.

### Step 4: Preserve Backward Compatibility

**For scripts that remain in hack/** (install-project.sh, update-project.sh), update them to check both locations:

```bash
# Try plugin location first, fall back to hack/
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/frontmatter-utils.sh" ]]; then
  source "${CLAUDE_PLUGIN_ROOT}/scripts/frontmatter-utils.sh"
elif [[ -f "./hack/frontmatter-utils.sh" ]]; then
  source "./hack/frontmatter-utils.sh"
else
  echo "Error: frontmatter-utils.sh not found"
  exit 1
fi
```

This allows scripts to work in both plugin and workspace contexts.

## Script Documentation Pattern

### Add README.md to Each scripts/ Directory

**Example: plugins/workflow/scripts/README.md**

```markdown
# Workflow Plugin Scripts

Supporting scripts for catalyst-workflow plugin.

## check-prerequisites.sh

Validates required tools before executing workflow commands.

**Checks**:
- HumanLayer CLI (`humanlayer` command)
- jq (JSON processor)
- Thoughts system initialization

**Called by**:
- /research-codebase
- /create-plan
- /implement-plan
- /validate-plan

**Usage**:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" || exit 1
```

**Exit codes**:
- 0: All prerequisites met
- 1: Missing prerequisites (prints installation instructions)

## Installation

Scripts are automatically installed with the plugin. No manual setup required.

## Permissions

All scripts have execute permissions. If you clone this repo directly:
```bash
chmod +x scripts/*.sh
```
```

## Testing Strategy

### Test Scripts in Plugin Context

**Create test plugin structure**:
```bash
# In catalyst workspace
mkdir -p test-plugin/{.claude-plugin,commands,scripts}

# Copy script
cp plugins/workflow/scripts/check-prerequisites.sh test-plugin/scripts/

# Create test command
cat > test-plugin/commands/test.md << 'EOF'
```bash
#!/bin/bash
echo "Testing script execution..."
"${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh"
```
EOF

# Create plugin.json
cat > test-plugin/.claude-plugin/plugin.json << 'EOF'
{
  "name": "test-plugin",
  "version": "0.0.1"
}
EOF

# Make executable
chmod +x test-plugin/scripts/*.sh

# Test locally
/plugin marketplace add ./test-plugin
/plugin install test-plugin@local
```

**Verify**:
- Command finds script at `${CLAUDE_PLUGIN_ROOT}/scripts/`
- Script executes correctly
- Exit codes work as expected

## Special Case: Scripts Called by Other Scripts

### update-project.sh Sources frontmatter-utils.sh

**Both must be in same plugin** (pm):

```
plugins/pm/scripts/
├── update-project.sh          # Sources frontmatter-utils.sh
└── frontmatter-utils.sh       # Provides utility functions
```

**Sourcing works normally**:
```bash
# In update-project.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/frontmatter-utils.sh"
```

**Reason**: Both scripts are in same directory, relative sourcing works.

### create-worktree.sh Conditionally Calls humanlayer

**No script dependency** - calls external CLI:

```bash
if command -v humanlayer >/dev/null 2>&1; then
  humanlayer thoughts init --directory "$REPO_BASE_NAME"
fi
```

**No changes needed** - external command execution works the same in plugins.

## Workspace Root Scripts (hack/ Directory)

### These Scripts Stay at Workspace Root

**Reason**: They're used for **installation and migration**, not runtime execution.

**Structure**:
```
catalyst/
├── hack/                           # Workspace-only scripts
│   ├── install-user.sh             # Install to ~/.claude/
│   ├── install-project.sh          # Install to project
│   ├── setup-thoughts.sh           # Initialize thoughts
│   ├── init-project.sh             # Project thoughts
│   ├── setup-multi-config.sh       # Multi-client setup
│   ├── add-client-config           # Add client
│   ├── setup-linear-workflow       # Linear setup
│   ├── hl-switch                   # Config switcher
│   ├── validate-frontmatter.sh     # Linter integration
│   └── README.md
└── plugins/
    └── ...
```

**Usage**: Direct execution by users during setup:
```bash
# User runs these manually
./hack/install-project.sh /path/to/project
./hack/setup-thoughts.sh
./hack/setup-multi-config.sh my-client
```

**Not packaged in plugins** - these are development/migration tools.

### Update install-project.sh for Plugin Structure

**Current behavior**: Copies from `agents/` and `commands/` to `.claude/`

**New behavior**: Recognize plugin structure and copy from `plugins/*/`:

```bash
# Check if using plugin structure
if [[ -d "${WORKSPACE_DIR}/plugins" ]]; then
  # Plugin-based installation
  echo "Installing from plugin structure..."

  # Copy each plugin's agents
  for plugin_dir in "${WORKSPACE_DIR}/plugins/"*/; do
    if [[ -d "${plugin_dir}/agents" ]]; then
      cp -r "${plugin_dir}/agents/"*.md "${PROJECT_DIR}/.claude/agents/" 2>/dev/null || true
    fi
  done

  # Copy each plugin's commands
  for plugin_dir in "${WORKSPACE_DIR}/plugins/"*/; do
    if [[ -d "${plugin_dir}/commands" ]]; then
      cp -r "${plugin_dir}/commands/"*.md "${PROJECT_DIR}/.claude/commands/" 2>/dev/null || true
    fi
  done
else
  # Legacy flat structure
  echo "Installing from flat structure..."
  # Existing logic...
fi
```

**Benefit**: install-project.sh continues working as migration path for users who want script-based installation.

## Recommendations

### 1. Duplicate check-prerequisites.sh Across Plugins ⭐

**Action**: Copy to workflow/, pm/, handoff/, research/ plugins

**Rationale**:
- Small script (~100 lines)
- Independent plugin operation
- Standard plugin pattern

### 2. Move Runtime Scripts to Plugin scripts/ Directories

**Workflow plugin**:
- check-prerequisites.sh

**PM plugin**:
- check-prerequisites.sh
- create-worktree.sh
- update-project.sh
- frontmatter-utils.sh (sourced by update-project.sh)

**Handoff plugin**:
- check-prerequisites.sh

**Research plugin**:
- check-prerequisites.sh

### 3. Update All Command References to Use ${CLAUDE_PLUGIN_ROOT}

**Pattern**:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/script-name.sh"
```

**Apply to**:
- commands/workflow/research_codebase.md
- commands/workflow/create_plan.md
- commands/workflow/implement_plan.md
- commands/project/create_worktree.md
- commands/project/update_project.md
- commands/linear/create_pr.md
- commands/handoff/create_handoff.md
- commands/handoff/resume_handoff.md

### 4. Keep Workspace Scripts at Root

**No changes** to:
- hack/install-user.sh
- hack/install-project.sh
- hack/setup-thoughts.sh
- hack/init-project.sh
- hack/setup-multi-config.sh
- hack/add-client-config
- hack/setup-linear-workflow
- hack/hl-switch
- hack/validate-frontmatter.sh

**These remain as migration/setup utilities**.

### 5. Add scripts/README.md to Each Plugin

**Document**:
- What each script does
- Which commands call it
- How to test it
- Exit codes and behavior

### 6. Make All Scripts Executable

**Before committing**:
```bash
find plugins/*/scripts -name "*.sh" -exec chmod +x {} \;
git add --chmod=+x plugins/*/scripts/*.sh
```

### 7. Test Each Plugin Independently

**Verify**:
- Scripts resolve correctly with ${CLAUDE_PLUGIN_ROOT}
- Commands can execute scripts
- Permissions are correct
- Sourcing works (for frontmatter-utils.sh)

## Example: Complete Migration for /create-worktree

### Before (Monolithic)

**File**: commands/project/create_worktree.md

```markdown
---
description: Create git worktree for parallel development
---

```bash
#!/bin/bash

# Execute worktree creation
./hack/create-worktree.sh "$WORKTREE_NAME" "$BASE_BRANCH"
```
```

**Script**: hack/create-worktree.sh (230 lines)

### After (Plugin)

**File**: plugins/pm/commands/create_worktree.md

```markdown
---
description: Create git worktree for parallel development
---

```bash
#!/bin/bash

# Execute worktree creation
"${CLAUDE_PLUGIN_ROOT}/scripts/create-worktree.sh" "$WORKTREE_NAME" "$BASE_BRANCH"
```
```

**Script**: plugins/pm/scripts/create-worktree.sh (same 230 lines, no changes)

**Result**:
- Script packaged with plugin
- Path resolves via ${CLAUDE_PLUGIN_ROOT}
- Works regardless of installation location
- Plugin is self-contained

## Implementation Checklist

- [ ] Create scripts/ directory in each plugin
- [ ] Copy check-prerequisites.sh to workflow, pm, handoff, research plugins
- [ ] Move create-worktree.sh to pm/scripts/
- [ ] Move update-project.sh to pm/scripts/
- [ ] Copy frontmatter-utils.sh to pm/scripts/
- [ ] Update all command files to use ${CLAUDE_PLUGIN_ROOT}
- [ ] Make all scripts executable (chmod +x)
- [ ] Add README.md to each scripts/ directory
- [ ] Test each plugin independently
- [ ] Update workspace hack/ scripts to support both structures
- [ ] Document script usage in plugin README
- [ ] Verify sourcing works (update-project.sh → frontmatter-utils.sh)

## Summary

**Key decisions**:

1. ✅ **Runtime scripts go in plugin scripts/ directories**
2. ✅ **Use ${CLAUDE_PLUGIN_ROOT} for path resolution**
3. ✅ **Duplicate check-prerequisites.sh across plugins**
4. ✅ **Keep installation scripts at workspace root (hack/)**
5. ✅ **Make all scripts executable before distribution**
6. ✅ **Test plugins independently to verify script execution**

**Benefits**:
- Plugins are self-contained
- Scripts work regardless of installation location
- No cross-plugin dependencies
- Backward compatibility with workspace scripts
- Standard plugin pattern

**Next steps**: Implement the checklist above to complete the script packaging for the Catalyst plugin structure.
