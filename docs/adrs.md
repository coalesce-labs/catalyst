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

---

## ADR-009: Daily Release Cadence with Deferred Intraday Channel

**Decision**: Cut one release per day via a scheduled-merge workflow at 05:00 UTC instead of
auto-merging the release-please Release PR on every push to `main`. Defer the intraday
pre-release channel (for users who want merged-but-unreleased commits) to a follow-up ticket
with a documented design.

**Rationale**:

- Every PR merge currently produces a point release, cluttering tag history and CHANGELOGs with
  commits that don't represent meaningful user-facing checkpoints.
- During multi-PR orchestration waves, every merge triggers a release-please chore commit to
  `main`, forcing `update-branch` rebases on every other open PR. Observed during `ctl-lifecycle`
  orchestration on 2026-04-16. Daily cadence collapses this to one cascade per day, in the
  evening, when no other PRs should be in-flight.
- Release Please already aggregates commits via a single `separate-pull-requests: false` Release
  PR. We simply stop auto-merging it on every push.

**Design**:

- `.github/workflows/release-please.yml` opens/updates the Release PR on every push to `main`
  and runs `enhance-release-notes.sh` to keep the AI-enhanced summary and CHANGELOGs fresh.
- `.github/workflows/release-please-scheduled-merge.yml` runs at 05:00 UTC (22:00 PT / 01:00 ET).
  It finds the open Release PR (label `autorelease: pending`), verifies mergeability, and merges
  it. If no Release PR is open (empty day) it exits 0.
- `workflow_dispatch` on the scheduled workflow provides a manual "cut now" escape hatch for
  hotfixes.
- A blocked or conflicted Release PR causes the scheduled workflow to open a `release-health`
  labeled issue (dedup'd against any existing open one).

**Intraday channel (deferred)**:

Catalyst is distributed as a Claude Code plugin marketplace, not an npm package. Claude Code's
plugin auto-update is gated on the `version` field in each plugin's `plugin.json`. Under daily
cadence, `plugin.json.version` only changes once per day, so users on the marketplace see at most
one update per day.

For early-access / intraday users, the options are:

| Option | Status |
|---|---|
| Pre-release npm dist-tag (`@next`) | Not applicable — no npm distribution |
| Floating `next` branch + separate marketplace entry, with pre-release version bumps | Designed; deferred |
| Nightly build artifact | Not applicable — no binaries |
| Install from a specific commit SHA on `main` | Works today with zero plumbing — documented as the MVP |

Recommended path forward for the deferred work: maintain a `next` branch that fast-forwards
`main` on every push and appends a commit bumping each plugin's `plugin.json.version` to
`<next-version>-rc.<commits-since-last-release>`. Publish a second marketplace entry that sources
plugins from the `next` branch. Users who want intraday updates install the `-next` marketplace.
Plumbing cost: version calculation, branch bookkeeping, marketplace duplication, user-facing
docs. Defer until someone explicitly needs it.

**Consequences**:

- Changelog and tag history compress from per-merge to per-day granularity.
- Orchestration waves no longer cascade through release-please chore commits mid-wave.
- Users who relied on per-merge auto-updates see updates at most once per day via the
  marketplace; they can install from a commit SHA for intraday access.
- `scripts/check-release-health.sh` check #2 continues to work unchanged — it fires only when
  releasable commits exist with no open Release PR, which still means release-please itself is
  broken.
- Rollback is mechanical: revert the two workflow changes to restore the previous `auto-merge`
  job.

---

## ADR-010: Catalyst CLI Install via `~/.catalyst/bin/`

**Decision**: Install the `catalyst-*` CLIs as symlinks in `~/.catalyst/bin/` with a single `$PATH`
entry, rather than writing shell-rc alias blocks or relying on a plugin post-install hook.

**Rationale**:

- A single `export PATH="$HOME/.catalyst/bin:$PATH"` line works for `zsh`, `bash`, and `fish` —
  alias blocks need shell-specific detection and rewriting.
- `ls ~/.catalyst/bin/` is a discoverable inventory of every Catalyst CLI — new tools appear
  there automatically when `setup-catalyst` re-runs.
- Easy uninstall: `install-cli.sh --uninstall` (or `rm -rf ~/.catalyst/bin/`).
- Symlinks strip the `.sh` suffix so users type `catalyst-session`, not `catalyst-session.sh`.
- The Claude Code plugin system does not (yet) expose a post-install hook, so the explicit
  `install-cli.sh` pathway avoids depending on a future plugin-system feature.

**Consequences**:

- `plugins/dev/scripts/install-cli.sh` is authoritative for the list of exposed CLIs — the
  allowlist there must be updated when a new `catalyst-*` CLI is introduced.
- When the plugin is updated, its scripts directory moves to a new version-stamped path
  (`~/.claude/plugins/cache/catalyst/catalyst-dev/<version>/scripts/`). The existing symlinks
  become stale. Re-running `setup-catalyst` (or `install-cli.sh`) re-points them — this is the
  intentional repair path. The health check in `check-setup.sh` surfaces broken symlinks so
  staleness is visible and fixable.
- No plugin-uninstall hook exists, so users who `rm` the plugin will have broken symlinks until
  they run `install-cli.sh --uninstall`. The reference docs page for `catalyst-comms` documents
  the clean-removal command.
---

## ADR-011: Hybrid SQLite + Filesystem Archive for Orchestrator Artifacts

**Decision**: Persist orchestrator artifacts (summaries, briefings, worker signals, phase logs, comms,
metadata) out of the runs directory and worktrees into a durable, two-layer store:

- **Blob layer** — Filesystem tree at `~/catalyst/archives/{orchId}/` (summaries, briefings,
  signals, phase logs, comms channels, metadata.json).
- **Index layer** — Three SQLite tables in `~/catalyst/catalyst.db` (`orchestrators`,
  `archived_workers`, `archived_artifacts`) for fast querying, filtering, and pagination.

The archive is written by `plugins/dev/scripts/orch-monitor/catalyst-archive.ts sweep` and served
read-only via `/api/archive/*` endpoints in `orch-monitor`.

**Rationale**:

- Orchestrator artifacts currently live inside worktrees and `~/catalyst/runs/{orchId}/`. Both
  are reaped during teardown, which loses the post-mortem artifacts users need.
- A pure-SQLite design would balloon the DB with large text blobs (summaries, JSONL phase logs).
- A pure-filesystem design loses query performance ("show me all archived orchs that touched
  CTL-110" becomes an O(n) scan of metadata.json files).
- Hybrid gives both: small, indexed, queryable metadata + unbounded blob storage on disk.

**Schema** (`plugins/dev/scripts/db-migrations/003_archives.sql`):

- `orchestrators` — one row per archived orchestrator (id, name, started/completed timestamps,
  waves/workers/PRs counts, tickets_touched JSON, archive_path, has_rollup, archived_at)
- `archived_workers` — composite PK `(orch_id, worker_id)` — per-worker summary (ticket, PR,
  final status, duration, cost, flags for has_summary / has_rollup_fragment)
- `archived_artifacts` — one row per blob, UNIQUE `(orch_id, path)` for idempotent upserts
  (kind, relative path, bytes, optional sha256)

**Write order (filesystem-first invariant)**: blobs are written via atomic `tmp + rename`
BEFORE the SQLite rows are inserted. If SQLite insertion fails, the blobs remain on disk and
are recoverable via `catalyst-archive sync`, which re-scans the filesystem and rebuilds the
index.

**Consequences**:

- Teardown becomes safe: `/catalyst-dev:teardown <orchId>` refuses to delete runs/worktrees
  unless the archive sweep succeeded (or `--force` is passed).
- `orchestrate` Phase 7 runs `catalyst-archive sweep` before worktree cleanup.
- The monitor gains a "History" view backed by `/api/archive/orchestrators`,
  `/api/archive/orchestrators/:id`, and `/api/archive/orchestrators/:id/files/:rel+`.
- File serving is path-traversal safe: `realpathSync()` must resolve within the recorded
  `archive_path`, and relative paths are regex-validated to `[A-Za-z0-9._-]+` segments.
- `catalyst-archive` exposes `sweep`, `sync`, `prune`, `list`, and `show` subcommands for
  ops (prune respects `archive.retentionDays`).
