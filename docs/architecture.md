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
├── catalyst.db             # Durable session store (SQLite, WAL mode)
├── events/                 # Append-only JSONL event stream, rotated monthly
│   └── YYYY-MM.jsonl
├── history/                # Archived orchestrator snapshots
│   └── <id>--<timestamp>.json
└── wt/                     # Worktrees (existing)
```

- **catalyst.db**: SQLite-backed session store — durable source of truth for agent activity
  (solo and orchestrated). Managed by `catalyst-db.sh` (low-level CRUD, migrations) and
  `catalyst-session.sh` (high-level lifecycle CLI used by instrumented skills). Tables:
  `sessions`, `session_events`, `session_metrics`, `session_tools`, `session_prs`,
  `schema_migrations`. Writers run in WAL mode so monitor-style readers (including
  `orch-monitor`) can operate concurrently. `catalyst-state.sh` continues to write JSON/JSONL
  during the migration period for backward compatibility. Schema lives at
  `plugins/dev/scripts/db-migrations/`. See ADR-008.

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

## Agent Communication (catalyst-comms)

Agents coordinate across worktrees via `catalyst-comms`, a file-based JSONL messaging system at
`~/catalyst/comms/channels/<name>.jsonl`. Orchestrators create a shared channel
`orch-<orchId>` at startup and export `CATALYST_COMMS_CHANNEL` to every dispatched worker's
environment. Workers auto-join on startup and post `info` messages at each lifecycle boundary
(start, phase transitions, PR opened), `attention` when blocked, and `done` on settle.

```bash
# Orchestrator side (Phase 1 init)
catalyst-comms join "orch-${ORCH_NAME}" --as orchestrator --capabilities "coordinates workers"

# Worker dispatch env
CATALYST_COMMS_CHANNEL="orch-${ORCH_NAME}" exec claude -p "/oneshot ${TICKET_ID}"

# Worker side (oneshot startup)
catalyst-comms join "$CATALYST_COMMS_CHANNEL" --as "$TICKET_ID" --parent orchestrator

# Live tailing (human auditor)
catalyst-comms watch "orch-${ORCH_NAME}"
```

The contract: every worker produces ≥4 messages per run. Signal files remain the authoritative
state — comms is observability and cross-worker coordination. See
`plugins/dev/skills/catalyst-comms/SKILL.md` for the full protocol.

## Context Management Principles

1. **Context is precious** — Use specialized agents, not monoliths
2. **Just-in-time loading** — Load context dynamically
3. **Sub-agent architecture** — Parallel research > sequential
4. **Structured persistence** — Save outside conversation (thoughts/)
5. **Read files fully** — No partial reads of key documents
6. **Wait for agents** — Don't proceed until research completes

## Artifact Persistence

Orchestrator runs produce artifacts that must survive worktree and runtime-directory cleanup:
SUMMARY.md, wave briefings, per-worker signal files and phase logs, rollup fragments, comms
channels, and state.json. These are persisted into a **hybrid SQLite + filesystem archive**
keyed by orchestrator id.

### Layout

- **Index (SQLite)** — `~/catalyst/catalyst.db`, three tables added by migration `003_archives.sql`:
  - `orchestrators` — one row per archived orchestrator (status, counts, tickets, archive_path).
  - `archived_workers` — one row per worker, composite PK (`orch_id`, `worker_id`).
  - `archived_artifacts` — one row per blob, UNIQUE (`orch_id`, `path`) for idempotent upserts.
- **Blobs (filesystem)** — `~/catalyst/archives/<orchId>/`:
  - `metadata.json`, `SUMMARY.md`, `rollup-briefing.md` at the root
  - `briefings/wave-*.md`
  - `workers/<ticket>/{signal-final.json, phase-log.jsonl, SUMMARY.md, rollup-fragment.md}`
  - `comms/<channel>.jsonl`

### Write order (filesystem-first invariant)

Every archive write follows the same rule: **blobs land on disk before SQLite rows exist**. Each
file is written via `atomicWrite()` (tmp path + `rename`) and the SQLite INSERTs are wrapped in a
transaction that runs *after* all filesystem writes succeed. The practical consequence:

- If SQLite write fails, files remain on disk and can be picked up by `catalyst-archive sync`.
- If the process crashes mid-sweep, partial `.tmp` files can be deleted; no row ever points at a
  file that doesn't exist.
- Re-running the sweep is safe: all inserts are `ON CONFLICT … DO UPDATE` upserts.

### CLI (`plugins/dev/scripts/orch-monitor/catalyst-archive.ts`)

```
bun catalyst-archive.ts sweep <orchId>         # archive a single orchestrator
bun catalyst-archive.ts sync                   # reconcile FS ↔ SQLite (orphans, missing rows)
bun catalyst-archive.ts prune --older-than 30d # delete archives older than N days
bun catalyst-archive.ts list [--json]          # list archived orchestrators
bun catalyst-archive.ts show <orchId>          # show detail (workers + artifacts)
```

All subcommands accept `--dry-run`. Configuration comes from `.catalyst/config.json` (project
layer) merged with `~/.config/catalyst/config.json` (user layer) via `archive.*` keys.

### Monitor + UI

The orch-monitor server exposes read-only endpoints:

- `GET /api/archive/orchestrators` — paginated list with since/until/ticket/status filters.
- `GET /api/archive/orchestrators/:id` — detail including workers + artifacts.
- `GET /api/archive/orchestrators/:id/files/:relPath+` — streams an archived file. Paths are
  validated with `isSafeArchivePart` / `isSafeArchiveFileRel` and a `realpathSync` check against
  `archive_path` prevents symlink escapes (403 on violation, 400 on bad input, 404 on missing).

The `/history` page includes an "Archived Orchestrators" section rendering these endpoints with
expandable per-orch detail panels.

### Lifecycle integration

- **Orchestrate Phase 7** runs the sweep after the final SUMMARY.md is written and before any
  worktree cleanup. Re-running is idempotent, so a retry is always safe.
- **Teardown skill** (`/catalyst-dev:teardown <orchId>`) deletes runtime + worktree state but
  refuses unless the archive exists and the SQLite row is present (bypass with `--force`).
