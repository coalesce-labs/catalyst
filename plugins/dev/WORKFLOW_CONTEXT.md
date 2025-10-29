# Workflow Context System

Complete guide to automatic document tracking and discovery in Catalyst.

## The Problem We Solved

**Before**: Users had to remember and paste file paths between commands
```bash
# User writes a research document
/research-codebase

# Later, user wants to create a plan...
/create-plan thoughts/shared/research/2025-10-28-long-filename-they-dont-remember.md
# ❌ User has to remember or find the exact path
```

**After**: System automatically tracks and suggests recent documents
```bash
# User writes a research document
/research-codebase
# ✅ Hook automatically tracks in .workflow-context.json

# Later, user wants to create a plan...
/create-plan
# ✅ System shows: "💡 Found recent research: [path]"
#     "Would you like me to use this as context?"
```

---

## How It Works: Complete Flow

### 1. Writing Documents (Automatic Tracking)

When Claude writes or edits a thoughts file:

```
You → /research-codebase → Creates: thoughts/shared/research/2025-10-28-PROJ-123-auth.md
      ↓
Claude Code Hook triggers PostToolUse event
      ↓
hooks/update-workflow-context.sh runs
      ↓
.workflow-context.json updated:
{
  "lastUpdated": "2025-10-28T22:30:00Z",
  "currentTicket": "PROJ-123",
  "mostRecentDocument": {
    "type": "research",
    "path": "thoughts/shared/research/2025-10-28-PROJ-123-auth.md",
    "ticket": "PROJ-123"
  },
  "workflow": {
    "research": [
      {
        "path": "thoughts/shared/research/2025-10-28-PROJ-123-auth.md",
        "ticket": "PROJ-123",
        "created": "2025-10-28T22:30:00Z"
      }
    ]
  }
}
```

**Key Components:**

1. **Hooks** (`hooks.toml`) - Watch for Write/Edit on thoughts files
2. **Hook Script** (`hooks/update-workflow-context.sh`) - Extract metadata and update context
3. **Workflow Context** (`.claude/.workflow-context.json`) - Stores recent documents

### 2. Reading Documents (Auto-Discovery)

When user invokes a workflow command:

```
You → /create-plan
      ↓
Command IMMEDIATELY runs:
```bash
RECENT_RESEARCH=$(workflow-context.sh recent research)
# Returns: thoughts/shared/research/2025-10-28-PROJ-123-auth.md
```
      ↓
Claude shows:
"💡 Found recent research: thoughts/shared/research/2025-10-28-PROJ-123-auth.md"
"Would you like me to use this as context for the plan?"
      ↓
You → "yes"
      ↓
Claude reads the research and creates plan
```

**Key Components:**

1. **Command Instructions** - Explicit STEP 1: Run auto-discovery
2. **Workflow Script** (`scripts/workflow-context.sh`) - Query recent documents
3. **User Confirmation** - Ask before proceeding with auto-discovered doc

---

## Complete Workflow Example

### Scenario: Research → Plan → Implement

```bash
# 1. Research the codebase
/research-codebase "How does authentication work?"
# → Creates: thoughts/shared/research/2025-10-28-PROJ-123-auth-research.md
# → Hook tracks it automatically ✅

# 2. Create implementation plan
/create-plan
# → STEP 1: Auto-discovers recent research
# → Shows: "💡 Found recent research: .../auth-research.md"
# → You confirm: "yes"
# → Claude reads research and creates plan
# → Creates: thoughts/shared/plans/2025-10-28-PROJ-123-oauth-support.md
# → Hook tracks it automatically ✅

# 3. Implement the plan
/implement-plan
# → STEP 1: Auto-discovers recent plan
# → Shows: "📋 Found recent plan: .../oauth-support.md"
# → You confirm: "yes"
# → Claude reads plan and implements
# → No file path needed! ✅
```

**Zero file paths needed after initial research!**

---

## Commands with Auto-Discovery

### ✅ Implemented

| Command | Auto-Discovers | Behavior |
|---------|---------------|----------|
| `/resume-handoff` | Recent handoff | Finds last handoff, asks to proceed |
| `/implement-plan` | Recent plan | Finds last plan, asks to proceed |
| `/create-plan` | Recent research | **Suggests** research as context |

### 🚧 Fallback if Not Found

All commands gracefully fall back to asking for input:

```bash
/resume-handoff
# No recent handoff found
→ "I'll help you resume work. Which handoff would you like to use?"
→ Lists available handoffs
→ Waits for user input
```

---

## Configuration Files

### 1. Workflow Context (`.claude/.workflow-context.json`)

**Purpose**: Track recent documents
**Location**: `.claude/.workflow-context.json` (per-worktree)
**Managed by**: Hooks + commands

**Structure**:
```json
{
  "lastUpdated": "ISO timestamp",
  "currentTicket": "PROJ-123",
  "mostRecentDocument": {
    "type": "plans|research|handoffs|prs",
    "path": "thoughts/shared/.../file.md",
    "created": "ISO timestamp",
    "ticket": "PROJ-123"
  },
  "workflow": {
    "research": [...recent docs...],
    "plans": [...recent docs...],
    "handoffs": [...recent docs...],
    "prs": [...recent docs...]
  }
}
```

### 2. Hooks Configuration (`hooks.toml`)

**Purpose**: Define which file operations trigger tracking
**Location**: `plugins/dev/hooks.toml`
**Loaded by**: Claude Code on plugin install

**Pattern**:
```toml
[[hooks]]
name = "Track Research Documents"
event = "PostToolUse"

[hooks.matcher]
tool_name = "Write"
file_paths = ["*thoughts/shared/research/*"]

[hooks.command]
command = "bash"
args = ["${CLAUDE_PLUGIN_ROOT}/hooks/update-workflow-context.sh"]
```

---

## Scripts

### 1. `workflow-context.sh` (Query Script)

**Purpose**: Read from workflow context
**Location**: `plugins/dev/scripts/workflow-context.sh`
**Used by**: Commands

**API**:
```bash
# Get most recent document of type
workflow-context.sh recent <type>
# → Returns: path/to/recent/doc.md

# Get all documents for ticket
workflow-context.sh ticket PROJ-123
# → Returns: all docs with ticket PROJ-123

# Initialize context file
workflow-context.sh init
```

### 2. `update-workflow-context.sh` (Hook Handler)

**Purpose**: Update workflow context when files are written
**Location**: `plugins/dev/hooks/update-workflow-context.sh`
**Triggered by**: Claude Code hooks

**How it works**:
1. Gets file path from `$CLAUDE_FILE_PATHS` (or JSON fallback)
2. Determines document type from path
3. Extracts ticket from filename (`PROJ-123`)
4. Calls `workflow-context.sh add` to update context

---

## Ticket Extraction

The system automatically extracts ticket numbers from filenames:

### Patterns Recognized
- `2025-10-28-PROJ-123-description.md` → `PROJ-123`
- `ABC-456_feature.md` → `ABC-456`
- `thoughts/shared/handoffs/PROJ-123/handoff.md` → `PROJ-123` (from directory)
- Any `[A-Z]+-[0-9]+` pattern

### Regex
```bash
if [[ "$FILENAME" =~ ([A-Z]+-[0-9]+) ]]; then
  TICKET="${BASH_REMATCH[1]}"
fi
```

---

## Command Pattern: Auto-Discovery

All workflow commands follow this explicit pattern:

```markdown
## Initial Response

**STEP 1: Auto-discover recent document (REQUIRED)**

IMMEDIATELY run this bash script BEFORE any other response:

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  RECENT_DOC=$("${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent <type>)
  if [[ -n "$RECENT_DOC" ]]; then
    echo "📋 Auto-discovered recent <type>: $RECENT_DOC"
  fi
fi
```

**STEP 2: Determine which document to use**

1. If user provided path → use it (override)
2. If RECENT_DOC found → ask to proceed
3. If nothing found → ask for path
```

**Why this works:**
- **IMMEDIATELY** and **REQUIRED** are explicit
- **STEP 1** makes it clear this happens first
- Bash script is shown inline (not just referenced)
- Logic flow is numbered and clear

---

## Activation

### Automatic (On Install)

When you install `catalyst-dev`:
1. Claude Code discovers `hooks.toml`
2. Registers all 8 hooks (Write + Edit × 4 types)
3. Hooks activate immediately

### Manual (After Updates)

If you update hook scripts:
1. Restart Claude Code
2. Hooks reload with new behavior

### Verification

Check if hooks are working:
```bash
# Write a test thoughts file
echo "test" > thoughts/shared/research/test.md

# Check workflow context
cat .claude/.workflow-context.json | jq '.workflow.research[0]'
# Should show: {..., "path": "thoughts/shared/research/test.md", ...}
```

---

## Benefits

### 1. Zero Memory Required
Users don't need to remember file paths between commands

### 2. Natural Workflow
Commands chain together seamlessly:
```bash
/research-codebase → /create-plan → /implement-plan
```

### 3. Context Awareness
System knows what you're working on (ticket, recent docs)

### 4. Graceful Degradation
Falls back to asking if auto-discovery doesn't find anything

### 5. User Override
Can always provide explicit path to override auto-discovery

---

## Troubleshooting

### Hooks Not Firing

**Symptom**: Workflow context not updating when writing files

**Solutions**:
1. Restart Claude Code (hooks load on startup)
2. Check plugin installed: `/plugin list`
3. Manually test: `CLAUDE_FILE_PATHS="thoughts/shared/plans/test.md" bash plugins/dev/hooks/update-workflow-context.sh`

### Auto-Discovery Not Working

**Symptom**: Commands don't show "📋 Auto-discovered..."

**Cause**: Claude not executing the bash script

**Solution**: Commands now have explicit STEP 1 with IMMEDIATELY and REQUIRED keywords

### Workflow Context Empty

**Symptom**: `.workflow-context.json` exists but has no documents

**Solutions**:
1. Write a thoughts file to trigger hooks
2. Manually add: `workflow-context.sh add research "path/to/doc.md" "PROJ-123"`
3. Check hooks are registered in Claude Code settings

### Wrong Document Suggested

**Symptom**: Auto-discovery finds wrong document

**Cause**: Most recent document isn't what you want

**Solution**: Provide explicit path to override:
```bash
/implement-plan thoughts/shared/plans/specific-plan.md
```

---

## Future Enhancements

Potential improvements:

1. **Ticket-Based Discovery**: Auto-find all docs for current ticket
2. **Relationship Tracking**: Track which plan came from which research
3. **Smart Suggestions**: Suggest related documents beyond just "most recent"
4. **Metadata Extraction**: Read YAML frontmatter for richer context
5. **Cross-Reference Validation**: Warn if implementing plan without reading research

---

## See Also

- [Hooks Documentation](./HOOKS.md) - Claude Code hooks system
- [Auto-Discovery Pattern](./.auto-discover-pattern.md) - Standard pattern for commands
- [Commands](./commands/) - Individual command documentation
- [Scripts](./scripts/) - Utility scripts
