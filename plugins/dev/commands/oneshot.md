---
description: End-to-end autonomous workflow - research, plan, and implement in one command
category: workflow
tools: Read, Write, Bash, Task, Grep, Glob
model: opus
version: 1.0.0
---

# Oneshot

End-to-end autonomous workflow that chains research → plan → implement with context isolation
between phases via `humanlayer launch`. Each phase runs in a fresh Claude Code session with
full capabilities.

## Prerequisites

```bash
# 1. Validate thoughts system (REQUIRED)
if [[ ! -d "thoughts/shared" ]]; then
  echo "❌ ERROR: Thoughts system not configured"
  echo "Run: ./scripts/humanlayer/init-project.sh . {project-name}"
  exit 1
fi

# 2. Validate humanlayer CLI (REQUIRED for session launching)
if ! command -v humanlayer &>/dev/null; then
  echo "❌ ERROR: HumanLayer CLI required for oneshot workflow"
  echo "Install: pip install humanlayer"
  exit 1
fi
```

## Input Modes

Supports two input modes:

**Ticket-based:**
```
/oneshot PROJ-123
```
Reads ticket from Linear, uses title/description as research query.

**Freeform:**
```
/oneshot "How does authentication work and can we add OAuth?"
```
Uses the provided text as the research query directly.

## Workflow Phases

### Phase 1: Research (Current Session)

This phase runs in the current session to allow user interaction during research.

1. **Parse input**: Determine if ticket ID or freeform query
2. **If ticket**: Read ticket details via Linearis CLI, move to `stateMap.research` (default: "In Progress")
3. **Conduct research**: Spawn parallel sub-agents (same as `/research-codebase`):
   - **codebase-locator**: Find relevant files
   - **codebase-analyzer**: Understand current implementation
   - **codebase-pattern-finder**: Find similar patterns
   - **thoughts-locator**: Find existing context (if relevant)
   - **external-research**: Research frameworks/libraries (if relevant)
4. **Synthesize findings**: Create research document at `thoughts/shared/research/YYYY-MM-DD-{ticket}-{description}.md`
5. **Sync**: `humanlayer thoughts sync`
6. **Track in workflow context (REQUIRED)** — substitute actual path and ticket:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add research "thoughts/shared/research/YYYY-MM-DD-description.md" "TICKET-ID"
   ```
7. **Verify**: `"${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent research` must print the path

### Phase 2: Plan (New Session via `humanlayer launch`)

Launches a fresh Claude Code session with full context isolation.

```bash
humanlayer launch \
  --model opus \
  --title "plan ${TICKET_ID:-oneshot}" \
  "/create-plan thoughts/shared/research/$RESEARCH_DOC"
```

**What happens in the launched session:**
- Fresh context window (no research tokens consumed)
- Reads research document from thoughts/
- Runs `/create-plan` interactively with the user
- Creates plan at `thoughts/shared/plans/YYYY-MM-DD-{ticket}-{description}.md`
- Syncs thoughts automatically

**User interaction**: The user interacts with the planning session normally. The plan
is refined iteratively until approved.

### Phase 3: Implement (New Session via `humanlayer launch`)

After the plan is approved, launches another fresh session:

```bash
humanlayer launch \
  --model opus \
  --title "implement ${TICKET_ID:-oneshot}" \
  "/implement-plan thoughts/shared/plans/$PLAN_DOC"
```

**What happens in the launched session:**
- Fresh context window (no planning tokens consumed)
- Reads plan document from thoughts/
- Runs `/implement-plan` with full capabilities
- Can spawn agent teams for complex multi-file implementations (see --team mode)
- Creates commit(s) and optionally PR

### Team Mode (Optional)

For complex implementations spanning multiple files/layers:

```
/oneshot --team PROJ-123
```

In team mode, Phase 3 uses agent teams for parallel implementation:
- Lead agent (Opus) coordinates the implementation
- Teammates (Sonnet) each own distinct file groups
- Each teammate can spawn their own research sub-agents
- Lead reviews teammate work via plan approval gates

**When to use `--team`:**
- Implementation spans 3+ files across different domains (frontend + backend + tests)
- Multiple independent components can be implemented in parallel
- Complex cross-cutting features

**When NOT to use `--team`:**
- Simple sequential changes
- Changes to a single file or closely related files
- Quick bug fixes

## Context Isolation Strategy

The key benefit of oneshot is **context isolation between phases**:

```
Phase 1: Research (current session)
  - Spawns parallel sub-agents for research
  - Saves research document to thoughts/
  - Context consumed: ~60-80% (research is token-heavy)

Phase 2: Plan (NEW session via humanlayer launch)
  - Starts with 0% context used
  - Reads only research document (~5-10% context)
  - Full context available for interactive planning
  - Saves plan to thoughts/

Phase 3: Implement (NEW session via humanlayer launch)
  - Starts with 0% context used
  - Reads only plan document (~5-10% context)
  - Full context available for implementation
  - Can spawn agent teams (each with fresh context)
```

## Linear Integration

If a ticket ID is provided:

| Phase | State (from stateMap) | Config Key | Default |
|-------|----------------------|------------|---------|
| Research starts | stateMap.research | `research` | "In Progress" |
| Research complete | — | — | Comment with research doc link |
| Plan starts | stateMap.planning | `planning` | "In Progress" |
| Plan approved | stateMap.inProgress | `inProgress` | "In Progress" |
| Implementation starts | stateMap.inProgress | `inProgress` | "In Progress" |
| PR created | stateMap.inReview | `inReview` | "In Review" |

## Error Handling

**If research phase fails:**
- Save partial findings to thoughts/
- Present error to user
- Suggest running `/research-codebase` manually

**If humanlayer launch fails:**
- Fall back to manual workflow:
  ```
  Could not launch new session automatically.

  Please start a new session and run:
    /create-plan thoughts/shared/research/$RESEARCH_DOC
  ```

**If implementation fails:**
- Partial work is committed
- Handoff document created automatically
- User can resume with `/resume-handoff`

## Important

- **Phase 1 (research) is interactive** — user can guide the research
- **Phases 2-3 launch separate sessions** — user interacts with each independently
- **thoughts/ is the handoff mechanism** — all documents persist between sessions
- **`humanlayer launch` is required** — no fallback for context isolation
- **NEVER add Claude attribution** to any generated artifacts

**IMPORTANT: Document Storage Rules**
- ALWAYS write to `thoughts/shared/` (research, plans, prs subdirectories)
- NEVER write to `thoughts/searchable/` — this is a read-only search index
