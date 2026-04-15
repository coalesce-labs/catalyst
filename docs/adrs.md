# Architecture Decision Records

Brief records of key architectural decisions made in this project.

## ADR-001: Plugin-Based Distribution

**Decision**: Distribute Catalyst as Claude Code plugins instead of git clone/install.

**Rationale**:

- Users get updates via `/plugin update catalyst-dev`
- No manual git pulls or symlink setup
- Plugin marketplace provides discoverability
- Local customizations (`.catalyst/config.json`) are preserved

**Consequences**:

- Plugin structure must be maintained in `plugins/*/`
- Breaking changes require version management
- Users can install only what they need (dev, meta, pm, etc.)

---

## ADR-002: HumanLayer Profile-Based Configuration

**Decision**: Use HumanLayer's native profile and repoMappings system for automatic thoughts
repository selection.

**Rationale**:

- Users work on multiple separate projects (work/personal, different clients)
- Each project needs its own thoughts repository
- HumanLayer supports `repoMappings` that automatically map working directories to profiles
- No manual `configName` tracking needed

**Consequences**:

- Use `humanlayer thoughts init --profile <name>` to initialize projects
- HumanLayer automatically detects correct profile based on working directory
- Scripts use `humanlayer thoughts status` to discover current thoughts repo
- Projects remain isolated with separate long-term memory

---

## ADR-003: Three-Layer Memory Architecture

**Decision**: Separate project configuration, long-term memory (thoughts), and short-term memory
(workflow-context).

**Rationale**:

- Config: Project-specific settings, portable, committable
- Long-term: Git-backed persistence, team collaboration, survives sessions
- Short-term: Session state, command chaining, not committed

**Consequences**:

- Skills must update workflow-context.json when creating documents
- Thoughts must be synced via `humanlayer thoughts sync`
- Workflow-context must be in `.gitignore`
- System supports multiple projects and worktrees seamlessly

---

## ADR-004: Workflow-Context for Session State

**Decision**: Store recent document references in `.catalyst/.workflow-context.json` for skill
chaining.

**Rationale**:

- Users shouldn't remember file paths between skills
- `/research-codebase` -> `/create-plan` -> `/implement-plan` should flow naturally
- Context must be local to each worktree
- Must not contain secrets or be committed to git

**Consequences**:

- All workflow skills must update workflow-context.json
- Helper script `scripts/workflow-context.sh` provides consistent interface
- Context is lost when worktree is deleted (by design)
- Skills can auto-discover recent documents without user input

---

## ADR-005: Configurable Worktree Convention

**Decision**: Use `GITHUB_SOURCE_ROOT` environment variable to organize repositories and worktrees
by org/repo.

**Rationale**:

- Developers have different preferences for where code lives
- Hardcoded paths don't work for everyone
- Main branches and worktrees should be organized together

**Convention**:

- Main repository: `${GITHUB_SOURCE_ROOT}/<org>/<repo>`
- Worktrees: `${GITHUB_SOURCE_ROOT}/<org>/<repo>-worktrees/<feature>`

**Consequences**:

- `create-worktree.sh` detects GitHub org from git remote
- Falls back to `~/wt/<repo>` if `GITHUB_SOURCE_ROOT` not set
- No hardcoded paths in scripts or documentation
- Clean organization by org and repo

---

## ADR-006: Global Orchestrator State

**Decision**: Maintain a single `~/catalyst/state.json` file as a global registry of all active
orchestrators, with an append-only event log at `~/catalyst/events/YYYY-MM.jsonl` and completed
orchestrator snapshots archived to `~/catalyst/history/`.

**Rationale**:

- Multiple orchestrators can run concurrently across different projects
- Per-orchestrator local state (`state.json` in each worktree) serves crash recovery but provides no
  cross-orchestrator visibility
- Users and agents need a single place to answer "what is Catalyst doing right now?"
- The file must be queryable via `jq` and consumable by dashboards (terminal, web)
- A heartbeat pattern detects orchestrators that died without clean shutdown

**Design**:

```
~/catalyst/
├── state.json              # Global registry (active orchestrators only)
├── catalyst.db             # SQLite session store (WAL mode)
├── events/                 # Append-only event stream, rotated monthly
│   ├── 2026-03.jsonl
│   └── 2026-04.jsonl
├── history/                # Archived orchestrator snapshots
│   └── <id>--<timestamp>.json
└── wt/                     # Worktrees (existing, unchanged)
```

- **Global state** is a denormalized summary optimized for queries — not a replacement for local
  state. Per-orchestrator `state.json` in worktrees continues to serve crash recovery.
- **Writes** go through `catalyst-state.sh` which uses `mkdir`-based locking (portable, no `flock`
  dependency) for atomic read-modify-write.
- **Events** are appended without locking (POSIX atomic append for small writes). Monthly rotation
  keeps files small. All event files are JSONL, so `cat *.jsonl | jq` queries across them.
- **History** holds full orchestrator snapshots at completion/failure/abandonment. Keyed by
  `<id>--<startedAt>` for uniqueness across reruns.
- **Heartbeat**: Orchestrators write `lastHeartbeat` during each monitoring poll (every 2-3 min).
  `catalyst-state.sh gc` detects entries with heartbeats older than 10 minutes and archives them as
  `abandoned`.

**Consequences**:

- Orchestrators must register at startup and heartbeat during monitoring
- Workers update both their signal file (local) and the global state (via `catalyst-state.sh`)
- Agents can answer status questions by reading `~/catalyst/state.json` directly
- Dashboards (terminal, web) have a stable JSON contract to build against
- The schemas at `plugins/dev/templates/global-state.json` and `global-event.json` define the
  contract for forward compatibility

---

## ADR-008: SQLite Session Store

**Decision**: Replace JSONL event streams with a SQLite database (`~/catalyst/catalyst.db`) as the
durable source of truth for agent session data, managed by `catalyst-db.sh` and `catalyst-session.sh`.

**Rationale**:

- JSONL event files grow unbounded and require full scans for queries
- Cross-session analytics (cost rollups, tool histograms, duration trends) are expensive over flat files
- SQLite provides ACID transactions, indexed queries, and WAL-mode concurrent readers — all with zero
  server dependencies
- A CLI wrapper (`catalyst-session.sh`) gives skills a sub-50ms write interface without importing
  library code

**Schema** (`plugins/dev/scripts/db-migrations/001_initial_schema.sql`):

- `sessions` — One row per agent run (skill, ticket, workflow, status, timestamps)
- `session_events` — Phase transitions, PR opens, heartbeats (typed, append-only)
- `session_metrics` — Cost and token counters (upserted per session)
- `session_tools` — Tool usage histograms (tool name → call count, total duration)
- `session_prs` — PRs created during a session (number, URL, CI status)
- `schema_migrations` — Applied migration versions

**Consequences**:

- Skills call `catalyst-session.sh start|phase|metric|tool|pr|end` instead of writing JSON directly
- `catalyst-db.sh` handles schema init, migration, and low-level CRUD
- Dual-write to `~/catalyst/events/YYYY-MM.jsonl` continues during the migration period for backward
  compatibility with tools that still consume the JSONL stream
- `orch-monitor` reads the SQLite store directly (WAL mode allows concurrent readers)
- `sqlite3` is now listed as an optional dependency
