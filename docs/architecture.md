# Architecture

## Three-Layer System

1. **Plugin Source** (`plugins/dev/`, `plugins/meta/`, `plugins/pm/`, etc.)
   - Canonical definitions of agents and skills
   - Edit these when making changes
   - Organized by plugin type

2. **Installation Layer** (`.claude/` + `.catalyst/`)
   - `.claude/`: Symlinks to local plugin directories, Claude Code reads plugins from here
   - `.catalyst/`: Catalyst workflow state (`config.json`, `.workflow-context.json`)

3. **Thoughts System** (external, `~/thoughts/`)
   - Git-backed context management
   - Shared across all worktrees
   - Initialized per-project via `init-project.sh`

## Workflow State Management

Skills track workflow state via `.catalyst/.workflow-context.json`:

- `/research-codebase` saves research -> `/create-plan` auto-references it
- `/create-plan` saves plan -> `/implement-plan` auto-finds it
- `/create-handoff` saves handoff -> `/resume-handoff` auto-finds it

Structure:

```json
{
  "lastUpdated": "2025-10-26T10:30:00Z",
  "currentTicket": "PROJ-123",
  "orchestration": null,
  "mostRecentDocument": {
    "type": "plans",
    "path": "thoughts/shared/plans/2025-10-26-PROJ-123-feature.md",
    "created": "2025-10-26T10:30:00Z",
    "ticket": "PROJ-123"
  },
  "workflow": {
    "research": [],
    "plans": [],
    "handoffs": [],
    "prs": []
  }
}
```

Management: Automatically updated by workflow skills. Tracked per-worktree (not committed to git).

## Global Orchestrator State

Cross-orchestrator visibility lives at `~/catalyst/state.json` — a single JSON file that all
orchestrators and workers write to via `catalyst-state.sh` (lock-protected).

```
~/catalyst/
├── state.json              # Active orchestrators (denormalized summary)
├── events/                 # Append-only JSONL event stream, rotated monthly
│   └── YYYY-MM.jsonl
├── history/                # Archived orchestrator snapshots
│   └── <id>--<timestamp>.json
└── wt/                     # Worktrees (existing)
```

- **state.json**: Registry of active orchestrators with progress, worker status, and attention
  items. Queryable with `jq`. Schema: `plugins/dev/templates/global-state.json`.
- **events/**: Every phase transition, PR creation, verification result, and attention item is
  logged as a JSONL entry. Schema: `plugins/dev/templates/global-event.json`.
- **history/**: Full orchestrator snapshots archived on completion, failure, or stale detection.
- **Heartbeat**: Orchestrators write `lastHeartbeat` every 2-3 min. Stale entries (>10 min) are
  garbage-collected as `abandoned`.

This is a denormalized summary layer — per-orchestrator local state in worktrees remains the
source of truth for crash recovery. See ADR-006 for the full design decision.

## Three-Layer Memory Architecture

Catalyst uses a three-layer memory architecture to manage context across multiple projects:

**1. Project Configuration** (`.catalyst/config.json`)

- Contains project-specific settings (ticket prefix, Linear team, etc.)
- HumanLayer automatically maps working directories to profiles via `repoMappings`

**2. Long-term Memory** (HumanLayer thoughts repository)

- Git-backed persistent storage shared across worktrees
- Contains: `shared/research/`, `shared/plans/`, `shared/prs/`, `shared/handoffs/`
- Synced via `humanlayer thoughts sync`

**3. Short-term Memory** (`.catalyst/.workflow-context.json`)

- Local to each worktree (not committed to git)
- Contains pointers to recent documents in long-term memory
- Enables skill chaining (e.g., `/create-plan` auto-finds recent research)

```
.catalyst/config.json          <- Project config (committable)
        |
        v
~/thoughts/repos/acme/       <- Long-term memory (git-backed)
  shared/research/
  shared/plans/
  shared/prs/
  shared/handoffs/
        |
        v
.catalyst/.workflow-context.json  <- Short-term memory (session pointers)
```

## Agent Teams vs Subagents

Claude Code provides two parallelization mechanisms:

**Subagents (Task tool)** — Default for most skills:

- Own context window; results return to caller
- Cannot spawn other subagents (no nesting)
- Lower token cost
- Best for: parallel research gathering, code analysis, file search

**Agent Teams (TeammateTool)** — For complex multi-domain work:

- Each teammate is a full Claude Code session
- Teammates CAN spawn their own subagents (two-level parallelism)
- Direct peer-to-peer messaging
- Higher token cost
- Best for: cross-layer features, complex implementations
- Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

| Scenario                                          | Use Subagents   | Use Agent Teams |
| ------------------------------------------------- | --------------- | --------------- |
| Parallel research gathering                       | YES             | Overkill        |
| Code analysis / file search                       | YES             | Overkill        |
| Complex multi-file implementation                 | NO (can't nest) | YES             |
| Cross-layer features (frontend + backend + tests) | NO              | YES             |
| Cost-sensitive operations                         | YES             | NO              |

Best practices:

- Lead on Opus, teammates on Sonnet
- Size tasks at 5-6 per teammate
- Each teammate owns distinct files (prevent conflicts)
- Use plan approval gates for risky work

## Context Management Principles

1. **Context is precious** — Use specialized agents, not monoliths
2. **Just-in-time loading** — Load context dynamically
3. **Sub-agent architecture** — Parallel research > sequential
4. **Structured persistence** — Save outside conversation (thoughts/)
5. **Read files fully** — No partial reads of key documents
6. **Wait for agents** — Don't proceed until research completes
