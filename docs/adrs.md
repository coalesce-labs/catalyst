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

---

## ADR-012: Webhook-Driven orch-monitor with smee.io Tunnel

**Decision**: Migrate orch-monitor from 30-second poll-everything to webhook-driven
event ingestion via a smee.io tunnel, with polling kept as a 10-minute fallback.

**Rationale**:

- The 30s polling loop ran ~26,640 GraphQL `gh pr view` calls per hour for 222 tracked
  PRs (only ~3 active at any time), draining the 5,000 calls/hr GitHub bucket in
  ~11 minutes and keeping it drained 24/7. CTL-209 root-cause research confirmed the
  recurrence pattern.
- Webhooks deliver state changes within seconds (vs. 30s worst-case for polling) and
  cost zero API budget at delivery time.
- smee.io is the path of least resistance for local-only delivery: no public ingress,
  no shared secret in DNS, no Cloudflare Worker. `gh webhook forward` was rejected
  because it's CLI-session-oriented (one user per repo, no programmatic API).
- Repo-level subscriptions (vs. org-level) mean we only manage hooks for repos we
  actually observe. The lazy `ensureSubscribed(repo)` path runs once per repo per
  process lifetime, then becomes a cache hit.
- A hard cutover (no `MONITOR_WEBHOOKS` feature flag) keeps the migration tractable.
  Worst case if all webhook plumbing fails: the daemon falls back to a 10-min poll
  with terminal-PR-skip and UNKNOWN backoff (Phase 0), still under budget.

**Consequences**:

- New runtime dep: `smee-client@^5.0.0` (was zero deps).
- New `lib/webhook-{verify,events,handler,tunnel,subscriber,replay,event-log}.ts`
  modules; new `POST /api/webhook` route; new server lifecycle hooks.
- Configuration: `.catalyst/config.json` adds `catalyst.monitor.github.smeeChannel`
  + `webhookSecretEnv`; HMAC secret lives in an env var pointed at by the latter.
  `plugins/dev/scripts/setup-webhooks.sh` is the idempotent setup helper.
- Startup replay: 1-hour window of deliveries from
  `gh api repos/{repo}/hooks/{id}/deliveries` is replayed through the same handler
  used for live deliveries (with synthetic signing — we own the secret), so events
  missed during downtime are reconciled without operator action.
- Event-log fan-out: every accepted webhook event is appended to
  `~/catalyst/events/YYYY-MM.jsonl` with topic namespace `<source>.<noun>.<verb>`
  (e.g. `github.pr.merged`). This seeded the unified event-bus that CTL-210 (**shipped** —
  Linear webhooks + consumer-side `catalyst-events` CLI) and CTL-211 (**shipped** — worker
  definition-of-done = production deploy success) build on.
- Steady-state GitHub API budget: 200+ tracked PRs × < 50 calls/hr (well under both
  the GraphQL and REST 5,000 calls/hr ceilings).

---

## ADR-013: Event-Driven Worker Waits (`wait-for-github` two-phase pattern)

**Decision**: Replace all `gh pr view --json` poll loops inside worker skills with a
`catalyst-events wait-for` blocking call that consumes the unified event log, with a
REST-authoritative check after each wake.

**Rationale**:

- `gh pr view --json` uses GraphQL. A busy orchestrator with 50+ workers polling every 30s
  exhausted the 5,000-call/hr GitHub GraphQL budget in under 11 minutes (CTL-209
  root-cause analysis). Polling was the only viable option before the event log existed.
- The unified event log (ADR-012) now gives workers a low-cost wake source: a single
  `tail -f` covers all event types (CI, reviews, pushes, merges) at zero API budget cost.
- Workers should not use GraphQL for state checks. REST (`gh api repos/{repo}/pulls/{n}`)
  is cheaper and returns `.mergeable_state`, which encodes CI + review status in one field.

**Design (two-phase)**:

1. **Phase 1** (`--timeout 180`): `catalyst-events wait-for` waits for any relevant event
   (check-suite, pr-review, push, pr-merged). On match, do a REST authoritative check.
   On timeout (3 min without an event), run diagnostics.
2. **Diagnostics**: count heartbeats in the last 500 log lines; re-check tunnel state. If
   infrastructure is healthy, extend to Phase 2. If not, switch to REST fallback.
3. **Phase 2** (`--timeout 7200`): same filter, 2-hour window. Infrastructure confirmed
   healthy — a long wait is normal (CI queued, reviewer slow to act).
4. **REST fallback** (`sleep 300` loop): if tunnel is down, poll every 5 min via
   `gh api repos/{repo}/pulls/{n}`. Avoids GraphQL, stays under budget.

**Consequences**:

- Every skill that previously polled `gh pr view` must be rewritten to use `wait-for`.
- The filter jq expression must cover both v1 and v2 envelope shapes (`.event` vs
  `.attributes."event.name"`).
- Workers must never use `.mergeable_state` as the sole decision signal — it's
  eventually-consistent. Always follow with a REST re-check before acting.
- The REST fallback is required for environments without a configured webhook tunnel.

---

## ADR-014: Worker Owns Full PR Lifecycle (CTL-252)

**Decision**: Remove `gh pr merge --auto` from all worker skills. Workers enter an
event-driven listen loop after opening a PR, resolve blockers inline, execute
`gh pr merge --squash --delete-branch` directly when the PR is CLEAN, and write
`status: "done"` before exiting. The orchestrator's Phase 4 is a safety-net fallback
only for workers that stalled before completing their own merge.

**Rationale**:

- `gh pr merge --auto` arms GitHub's auto-merge, which merges asynchronously after all
  required checks pass. This forces the worker to exit at `pr-created` and leaves the
  merge to GitHub (or the orchestrator's poll loop).
- With ADR-013's event-driven loop in place, the worker is already watching for exactly
  the events that signal "ready to merge" (CI green, no blocking reviews, no BEHIND). At
  that point executing `gh pr merge --squash` directly is simpler and eliminates the
  delay between "auto-merge armed" and "GitHub actually merges."
- Removing `--auto` shrinks the state machine: `pr-created → done` replaces
  `pr-created → (auto-merge armed) → (orchestrator detects merged) → done`. The
  orchestrator's Phase 4 polling loop is reduced to a fallback for crashed workers.

**Consequences**:

- `autoMergeArmedAt` field removed from the `pr` signal-file subobject.
- Workers must never use `--auto` in any `gh pr merge` invocation.
- The orchestrator's Phase 4 is now a safety net, not the primary merge path. Its poll
  interval can be relaxed (was 30s; 10-min polling is now acceptable for fallback-only use).
- Signal file `status: "done"` is written by the worker in the normal case. The
  orchestrator writes it only when it detects a previously stalled worker's PR is merged.
- Skills and documentation that said "the orchestrator polls until merged" must be updated.

---

## ADR-015: Bidirectional catalyst-comms (CTL-249)

**Decision**: Add inbound message reads to workers. Workers poll the shared comms channel
at each phase boundary for messages directed to `--filter-to <ticket-id>`, using a
`COMMS_LAST_READ` cursor to skip pre-join history.

**Rationale**:

- Before CTL-249, comms was one-direction: workers broadcast status, the orchestrator
  observed. The orchestrator had no way to send runtime instructions to a specific worker
  (e.g., "skip the migration, CTL-99 is handling it").
- Adding `--filter-to <ticket-id>` to `catalyst-comms poll` and advancing a cursor
  at each phase transition is a minimal change: no new infrastructure, no new file format,
  no guaranteed delivery required for the current use cases.

**Design**:

- Workers initialize `COMMS_LAST_READ` to the channel file's current line count at join
  time, so pre-join history is skipped.
- After each phase transition (signal file write), the worker calls
  `catalyst-comms poll --filter-to $TICKET_ID --since $COMMS_LAST_READ` and advances
  the cursor.
- Recognized inbound signals: `abort` (worker exits immediately), future signals TBD.

**ACK gap**:

There is no delivery guarantee. A worker may have passed a phase boundary before an
orchestrator-to-worker message arrives. The worker processes it only if it polls again
before exiting. CTL-253 tracks adding an explicit ACK mechanism.

**Event log integration**:

`catalyst-comms send` now emits a `comms.message.posted` event to the unified event log
(v2 OTel envelope) so orchestrators and monitoring tools can observe all comms traffic
without polling the channel file directly.

**Consequences**:

- Workers produce ≥4 comms messages per run: start, N phase transitions, done (or
  attention on block). The inbound read at each phase boundary adds no new messages but
  adds a `poll` call per phase transition (~5 calls per run).
- `catalyst-events wait-for` can now filter on `comms.message.posted` events to observe
  comms traffic from within the event log pipeline.

## ADR-016: Claude Code metadata on the canonical envelope (CTL-374)

**Status**: Accepted, 2026-05-13.

**Context**: Claude Code exposes per-session telemetry — context-window usage, cost,
turn count, model — only through the statusLine pipeline (stdin JSON to whatever
command is configured in `~/.claude/settings.json`'s `statusLine.command`). Hooks
like `PreToolUse`, `PostToolUse`, and `Stop` do not receive that data. We want the
HUD to display per-worker context % at a glance and workers to be able to react to
context pressure (e.g. trigger a handoff before forced compaction).

**Decision**: Add five new typed attributes to the canonical event envelope:

| Attribute | Type |
|---|---|
| `claude.session.id` | string (Claude Code session UUID) |
| `claude.model` | string |
| `claude.context.used_pct` | number |
| `claude.context.tokens` | number |
| `claude.turn` | number |

Introduce a `session.context` event type emitted by `catalyst-statusline.sh` on each
statusLine tick when the Claude session is bound to a Catalyst session. Emit a
companion `attention.context_pressure` event when `context_pct` crosses 70% upward.

Migration `005_claude_session_metadata.sql` adds two columns to `sessions`:

- `claude_session_id TEXT` — bound by `catalyst-session.sh start --claude-session-id`
  (with fallback to `CLAUDE_CODE_SESSION_ID` env var). Indexed for fast lookups
  when the statusline wrapper joins inbound `session_id` to a Catalyst session.
- `last_context_pct INTEGER` — bookkeeping for threshold-crossing detection. The
  `emit-context` subcommand reads and writes this value so callers don't have to
  remember the previous %.

**PII boundary**: `cost_usd` is intentionally **not** a typed attribute. It travels
in `body.payload.cost_usd` only because the OTLP forwarder
(`otel-forward/lib/destinations/otlp.ts:33-34`) forwards `attributes` and
`body.message` verbatim but does **not** forward `body.payload`. Anything in payload
stays on the local machine. The same gate applies to any future cost-related field.

**Installation**: Users opt in by editing `~/.claude/settings.json` to point
`statusLine.command` at `catalyst-statusline.sh`. The wrapper renders the normal
statusline via `bunx -y ccstatusline@latest` (or any `$CATALYST_STATUSLINE_CMD`)
and, in the background, calls `catalyst-session.sh emit-context`. The foreground
render is detached from the emit path — emit failures never break Claude Code's
status bar.

**Rationale**:

- Storing the Claude UUID lets us join statusLine ticks to the right Catalyst
  session even when one machine hosts multiple orchestrator workers.
- A single 70% threshold matches the existing prose guidance in
  `implement-plan/SKILL.md` (the "context >70%, recommend handoff" rule). More
  thresholds (50/60/80) are deferred until we have data on which ones matter.
- Keeping cost out of typed attributes is reversible — a future ADR can promote it
  once we have a denylist mechanism in the forwarder. The current "everything in
  attributes ships off-machine" invariant is too strong for billing data.

---

## ADR-017: Phase-Agent Dispatch Architecture (CTL-447 → CTL-470)

**Status**: Accepted, 2026-05-17.

**Context**: Pre-CTL-452 orchestrators dispatched one long-lived
`claude -p /catalyst-legacy:oneshot <TICKET> --auto-merge` per ticket. That worker
streamed JSON for the full lifecycle — research → plan → implement → verify →
review → PR → merge → deploy — across hundreds of turns in a single context
window. Three problems compounded:

- **Context rot**: by the time `implement` finished, the worker was carrying
  the entire research and planning transcript. Verify/review/ship phases ran on
  a stale, near-saturated context window.
- **Unbounded turn caps**: a single `--max-turns` had to cover all phases, so
  it was set high enough to never block the slowest phase. Fast phases inherited
  the same ceiling.
- **Crash recovery from a bad place**: a stuck worker was always revived from
  the unbounded-context state it got stuck in. There was no clean checkpoint
  between phases.

**Decision**: Dispatch workers as `claude --bg --resume
/catalyst-dev:phase-<name> <TICKET> --orch-dir <ORCH_DIR>` — one short-lived
`--bg` job per phase. The orchestrator walks the canonical 10-phase sequence
(`triage` → `research` → `plan` → `implement` → `verify` → `review` → `pr` →
`monitor-merge` → `monitor-deploy` → `teardown`) via `orchestrate-phase-advance`, waking on
`phase.<name>.complete.<TICKET>` events routed by a new deterministic broker
interest type, `phase_lifecycle` (CTL-447). Selected by
`.catalyst/config.json → catalyst.orchestration.dispatchMode` —
`"phase-agents"` is the template default; `"oneshot-legacy"` (the pre-CTL-452
model) is the runtime fallback when the key is missing.

**Rationale**:

- A short-lived per-phase worker stays well inside its effective context
  window. Each phase reads only the inputs it actually needs (the prior phase's
  signal file plus any referenced thoughts documents) — research transcripts
  don't tax the implement phase.
- Per-phase turn caps in `phase-agent-dispatch:51-66` let `triage` cap at 10
  turns while `implement` caps at 75, instead of every phase paying the
  worst-case ceiling. Per-phase model selection (`catalyst.orchestration.phaseAgents`)
  lets cheap phases (`monitor-deploy` defaults to Haiku) skip the Opus
  per-turn cost.
- `phase_lifecycle` is a deterministic regex match in the broker
  (`broker/index.mjs:1299-1335`) against
  `^phase\.([^.]+)\.(complete|failed)\.([A-Za-z][A-Za-z0-9_]*-\d+)$` — no Groq
  classification, no semantic ambiguity, one interest per ticket carrying
  `{ticket, phase_names[10]}`. All four orchestrator interests
  (`pr_lifecycle`, `ticket_lifecycle`, `comms_lifecycle`, `phase_lifecycle`)
  fire back as `filter.wake.<ORCH_NAME>`, so the orchestrator watches a single
  event stream.

**Consequences**:

- **Signal file layout splits**: the flat top-level `workers/<TICKET>.json`
  remains, and `phase-agent-dispatch` writes per-phase
  `workers/<TICKET>/phase-<name>.json` files alongside it. `catalyst-hud`
  currently scans only the flat file — the per-phase files are written but not
  yet surfaced (see `worker-signals-reader.ts:42`, tracked separately).
- **New healthcheck mode** for `--bg` state.json mtime: `orchestrate-healthcheck`
  stats `${JOBS_ROOT}/<bg_job_id>/state.json` (default
  `$HOME/.claude/jobs/<bg>/state.json`) and treats files older than
  `--stale-bg-seconds` (default 900s) as stalled when `.state` is not in
  `{done, failed, errored, stopped}`. Legacy PID liveness continues to cover
  `oneshot-legacy` workers.
- **Intermediate Linear states** (CTL-454) — `triaged`, `researching`,
  `planning`, `verifying`, `reviewing`, plus the existing `inProgress` and
  `inReview` — give per-phase Linear visibility. These map through
  `stateMap` in `.catalyst/config.json` so projects can opt in incrementally.
- **Revive budget** is enforced at the top-level signal file
  (`workers/<TICKET>.json.reviveCount`). When `reviveCount >= MAX_REVIVES`
  (default 10) the worker is marked `stalled` with
  `attentionReason="revive-budget-exhausted"`. Revives are once-per-phase;
  the second `phase.<name>.failed` for the same phase escalates immediately
  rather than retrying.
- **Legacy mode preserved**: `oneshot-legacy` is unchanged. Existing projects
  that haven't set `dispatchMode = "phase-agents"` continue to run one
  long-lived `claude -p /oneshot` per ticket. Cutover is per-project, not
  forced.
- **Implemented incrementally** across CTL-447 (broker interest type), CTL-452
  (orchestrator state-machine rewrite + `--bg` cutover), CTL-454 (intermediate
  Linear states), CTL-455 (session_metrics zero-value fix surfaced by the
  cutover), and follow-ups through CTL-470.
- The user-facing canonical reference lives at
  [`website/src/content/docs/reference/orchestration/phase-agents.md`](../website/src/content/docs/reference/orchestration/phase-agents.md)
  (shipped via PR #812). The internal canonical reference is
  [`docs/orchestrator-overview.md`](orchestrator-overview.md). Related ADRs:
  ADR-006 (global state JSON), ADR-008 (SQLite session store), ADR-014 (worker
  owns full PR lifecycle).

## ADR-018: Event-Sourced Worker Signal Files via Broker Projection (CTL-483)

**Status**: Accepted, 2026-05-17. Phase 1 (dual-write) shipped; Phase 2 (cutover)
and Phase 3 (SQLite mirror) tracked separately.

**Context**: `workers/<TICKET>.json` signal files are currently written directly by
**seven different code paths**:

- `orchestrate-dispatch-next` — records PID + lastHeartbeat after dispatch
- `orchestrate-followup` — seeds new signal files for follow-up tickets
- The worker agent itself (`oneshot/SKILL.md` — full lifecycle transitions)
- `orchestrate-healthcheck` — marks workers failed/stalled
- `orchestrate-revive` — manages revive retry budget
- `orchestrate-auto-fixup` — clears/sets `blockedSince`
- `orchestrate-auto-rebase` — clears/sets `dirtySince`

All seven use the same atomic `jq ... > tmp && mv` pattern, but there is **no
inter-process locking**. Cross-script races (e.g. healthcheck marks a worker
`failed` while the worker is simultaneously writing `pr-created`) are undetected
and silent.

The broker already has the relevant projection precedent: `broker-interests.json`
is fully event-sourced from `filter.register` / `filter.deregister`
(`broker/index.mjs:handleRegister/handleDeregister/saveInterests`). ADR-008 set
the dual-write migration pattern for sessions (JSONL → SQLite), and ADR-011
established the filesystem-first invariant for archive artifacts.

**Decision**: Move worker state mutations from "direct file write" to "emit a
`worker.state_changed` command event; broker projects the new state to disk".
The event carries the FULL new state in `body.payload.state` (not a patch), so
the broker is the simple end of the contract — no merging logic.

Migration is dual-write across three phases, mirroring ADR-008:

**Phase 1 (additive, this ADR)**: writers continue their direct `jq ... > tmp && mv`
AND emit a `worker.state_changed` event. The broker projects events to a
**shadow path** — `workers/<TICKET>.json.projected` — so direct writes are never
raced. A new `orchestrate-shadow-diff` CLI compares canonical vs shadow files
(stripped of audit metadata) and reports drift. PoC writer is
`orchestrate-auto-rebase` (single helper-function entry point, minimal blast
radius). The remaining six writers are migrated to dual-write one at a time
under follow-up tickets.

**Phase 2 (cutover)**: once `orchestrate-shadow-diff` shows zero drift across a
full orchestration cycle for ALL seven writers, direct writes are removed.
Broker becomes sole writer at the canonical path. `worker.state_changed`
remains in `processEvent`; the broker dispatch is unchanged.

**Phase 3 (optional)**: mirror to SQLite `worker_state` table per the ADR-011
hybrid pattern (`worker_state` table indexed by `(orch_id, ticket)`; filesystem
files remain the durable source of truth). Enables fast cross-orchestrator
queries without re-parsing JSON files.

**Event design**:

| Field | Source |
|---|---|
| `event.name` | `worker.state_changed` |
| `attributes."catalyst.orchestrator.id"` | path component |
| `attributes."catalyst.worker.ticket"` | path component |
| `attributes."catalyst.writer"` | audit trail (which script emitted) |
| `body.payload.state` | full new contents of `workers/<TICKET>.json` |

The full envelope plus a worked example is in
`plugins/dev/references/event-schema.md` under `## catalyst-orchestrator`. The
event name is registered in `plugins/dev/references/event-name-allowlist.md`
under `### worker_lifecycle`.

**Broker handler**: `handleWorkerStateChanged` (exported from
`plugins/dev/scripts/broker/index.mjs`). Reads orchestrator + ticket from the
event, derives the shadow path via `getProjectedWorkerStatePath`, and writes
atomically via `writeProjectedWorkerState` (the helper adds a `_projected`
metadata object recording `{writer, ts}` for forensic audit). Path resolution
honors `CATALYST_RUNS_DIR` (default: `${CATALYST_DIR}/runs`). Unit tests in
`plugins/dev/scripts/broker/worker-state.test.mjs` cover canonical + legacy
envelope shapes, missing-field drops, atomic write, and path isolation.

**Writer emit helper**: `plugins/dev/scripts/lib/emit-worker-state-changed.sh`
is sourced by writers opting into dual-write. Best-effort — every emission
failure path is a silent return so the direct write remains authoritative
during Phase 1.

**Feedback-loop safety**: the broker does NOT emit `worker.state_changed`
itself, so a `shouldSkipEvent` rule is unnecessary. If a future SQLite-mirror
handler is added in Phase 3, it will consume the same event without
re-emitting, preserving this property.

**Supersedes**: ADR-006's design for the `workers/<TICKET>.json` portion only.
The global state (`~/catalyst/state.json`) and event log
(`~/catalyst/events/YYYY-MM.jsonl`) decisions in ADR-006 remain in force.

**Consequences**:

- The race surface across seven writers collapses to "broker is sole writer"
  after Phase 2 cutover.
- Unblocks distributed broker — workers can POST `worker.state_changed`
  to a remote endpoint instead of writing local files, with the broker
  projecting from the receive side.
- Provides a single observable mutation API for worker state, which
  downstream tools (HUD, dashboards) can subscribe to without polling files.
- Adds an event-log entry per worker state mutation (~5–10 per worker run).
  Negligible at current volume (a few hundred events per orchestration).
- During Phase 1, double disk usage for worker signals (canonical + shadow
  copy). Each file is small (<2 KB), so the absolute cost is trivial.
- Writers gain a soft dependency on the events directory being writable;
  failure to emit is silent (best-effort), preserving the direct-write
  invariant.

---

## ADR-019: Turn-cap exhaustion → automated handoff continuation (CTL-484)

**Context**

Phase agents are dispatched with a turn cap (default 75 for `phase-implement`,
lower for other phases). The cap is enforced via prose in the agent's `/goal`
block — when the agent self-evaluates "I have stopped after N turns" it exits,
and Claude CLI records `~/.claude/jobs/<id>/state.json::state = "stopped"`.

Until CTL-484, `orchestrate-revive` treated this terminal state identically to
any other failure: it called `claude --bg --resume <session_id>` to relaunch
the worker and bumped `.reviveCount`. After 10 such cap-stops the worker was
marked `stalled` with `attentionReason: revive-budget-exhausted` — even though
each "revive" was successful forward progress, not a recovery from a real
error. Long-running tickets that genuinely needed >75 turns silently exhausted
the budget meant for error recovery, the single largest gap in the
phase-agent architecture.

**Decision**

Introduce `turn-cap-exhausted` as a distinct, non-terminal status that
participates in the broker's `phase_lifecycle` routing alongside
`complete`/`failed`. Workers that detect impending cap exhaustion write a
structured handoff doc to `thoughts/shared/handoffs/<TICKET>/<ts>_turn-cap-continuation.md`
and emit `phase.<name>.turn-cap-exhausted.<TICKET>` carrying the handoff path
in its payload. `orchestrate-revive` grows a continuation branch that:

1. Detects `status="turn-cap-exhausted"` + handoff path on the per-phase signal
2. Spawns `claude --bg --resume <session_id>` with three new env vars:
   `CATALYST_IS_CONTINUATION=true`, `CATALYST_HANDOFF_PATH=<path>`,
   `CATALYST_CONTINUATION_COUNT=<n>`
3. Bumps `.continuationCount` on a budget separate from `.reviveCount`
   (default `MAX_CONTINUATIONS=3`)
4. On budget exhaustion, transitions to `stalled` with
   `attentionReason="continuation-budget-exhausted"`

The resumed worker's `phase-implement` Prelude block reads
`CATALYST_HANDOFF_PATH` and cat's the handoff into the transcript, telling the
agent: "trust this summary; do not re-walk the plan."

**Where it lives**

- Event/status: `plugins/dev/scripts/phase-agent-emit-complete` (accepts
  `--status turn-cap-exhausted` and `--handoff-path <path>`),
  `plugins/dev/scripts/lib/phase-emit-complete.sh` (same)
- Broker routing: `plugins/dev/scripts/broker/index.mjs:1297`
  (`PHASE_EVENT_PATTERN` regex), tests in `phase-lifecycle.test.mjs`
- Worker schema: `plugins/dev/templates/worker-signal.json` adds
  `continuationCount`, `continuations[]`, `handoffPath`; validator in
  `signal-schema.ts`; reader in `state-reader.ts`
- Orchestrator script: `plugins/dev/scripts/orchestrate-revive` adds the
  continuation branch, `spawn_continuation_bg` helper, and
  `--max-continuations` flag
- Resumed-worker hook: `plugins/dev/skills/resume-handoff/SKILL.md`
  Prerequisites block now honors `CATALYST_HANDOFF_PATH`
- Producer: `plugins/dev/skills/phase-implement/SKILL.md` Prelude has the
  continuation orientation; Failure-handling has the turn-cap branch (writes
  handoff, emits `--status turn-cap-exhausted`, exits 0); `/goal` block
  describes both completion and cap-exit branches
- Docs: `plugins/dev/references/event-name-allowlist.md` backfills the
  `phase_lifecycle` section

**Rationale**

- **Distinct status, not a payload discriminator**: putting the cap-vs-error
  distinction in `event.name` (the routable surface) is what allows the
  broker to route it to a separate code path. Encoding it only in
  `body.payload.failure_reason` would have required every consumer to parse
  the reason — fragile and easy to miss.
- **Separate budget**: `reviveCount` and `continuationCount` measure
  different failure modes. Mixing them was the bug. Default 3
  continuations matches typical multi-session implementation work; the
  budget can be raised via `--max-continuations` on the script or a future
  config setting.
- **Worker self-detection, not external watchdog**: the agent already knows
  its turn count (via `/goal` prose) — adding an external poller of
  `~/.claude/jobs/state.json` would duplicate that awareness with race
  conditions. The cost of self-detection is a `/goal` revision.
- **Handoff file is bash-templated, not via `create-handoff` skill**: the
  `create-handoff` skill is interactive prose. A background-only path
  cannot prompt for confirmation, so the phase-implement skill writes the
  file directly with the same template shape. This is acceptable because
  the structured fields (commit SHA, diff stat, plan path) are easy to
  produce from bash with no judgment calls.
- **`turn-cap-exhausted` is non-terminal**: omitting `completedAt` and
  staying off the `TERMINAL_STATUSES` list lets `orchestrate-revive` pick
  the worker up. The monitor UI can render it distinctly (yellow vs the
  red of `stalled`) — the schema is reserved for that.

**Alternatives considered**

- **Raise `MAX_REVIVES`**: papers over the actual issue. Cap-bound work
  and error recovery are different and conflating them masks real
  failures.
- **Bump per-phase turn caps in config**: works for known-long tasks
  but fails on tasks whose length isn't predictable until partway in.
- **External watchdog reading `~/.claude/jobs/state.json`**: duplicates
  agent self-awareness; adds a polling daemon; can't write the
  structured handoff because the agent's context is gone.

**Consequences**

- Long substantive tickets can chain multiple sessions without operator
  intervention.
- `continuationCount` distinct from `reviveCount` lets the operator
  diagnose "this worker is making progress but needs more turns" vs
  "this worker is failing and needs help" at a glance.
- Scope is `phase-implement` for v1 — other turn-bounded phases
  (`phase-research`, `phase-plan`, etc.) have lower caps and rarely
  exhaust; they can adopt the same pattern incrementally if rollout
  warrants it. The shared infrastructure (event status, emitter flags,
  broker regex, orchestrate-revive split, schema, resume hook) is
  reusable as-is.

---

## ADR-020: Phase-mode turn-cap continuation lives in `orchestrate-revive`, not the daemon (CTL-613)

**Context**

ADR-019 introduced the turn-cap continuation path against the legacy top-level
`workers/<TICKET>.json` loop in `orchestrate-revive`. With phase-agents mode
(ADR-017) now the default `dispatchMode`, phase-mode workers don't write the
top-level signal — only the per-phase signal `workers/<TICKET>/phase-<name>.json`.
ADR-019's loop is structurally a no-op for them. The CTL-493 per-phase loop
that was added to plug the legacy/phase split only consumes `status="stalled"`
and silently skips `status="turn-cap-exhausted"`, so a handoff doc written by
`phase-implement` sits unused and the ticket hangs (incident ADV-1134).

The daemon's terminal-status set (`execution-core/signal-reader.mjs`) classifies
`turn-cap-exhausted` as a terminal phase status — a deliberate ADR-019 choice
so the daemon doesn't try to resurrect a worker that the agent itself decided
to stop. That terminal classification is correct: continuation is a different
operation (resume + handoff) than reclaim (re-dispatch from scratch). What's
missing is a code path that consumes the terminal signal and dispatches the
continuation.

**Decision**

Add a fifth branch to `orchestrate-revive`'s CTL-493 per-phase loop that
consumes `P_STATUS=="turn-cap-exhausted"` directly off the per-phase signal:
budget-check against a new `.phaseContinuationCount` field, resolve the Claude
session id, resolve the worktree from the orchestrator's `state.json`, spawn
the continuation via the existing `spawn_continuation_bg` helper, mutate the
per-phase signal back to `running`, and emit `phase.<name>.dispatched` so the
broker re-arms. `phaseContinuationCount` shares the `MAX_CONTINUATIONS` budget
with ADR-019's top-level counter (default 3); the two counters are tracked
separately so a phase re-walked across the pipeline doesn't inherit a stale
top-level count.

Resolve the prior session id for `claude --bg` workers from
`~/.claude/jobs/<bg_job_id>/state.json`'s `linkScanPath` field rather than
plumbing the session id into the per-phase signal at dispatch time. The
basename minus `.jsonl` is the canonical session id. This keeps the dispatcher
contract (single-write of the per-phase signal) intact.

**Rationale**

- **Daemon terminal-status set stays intact**: `signal-reader.mjs` continues
  to classify `turn-cap-exhausted` as terminal so the daemon doesn't try to
  reclaim or re-dispatch on it. The recovery path is `orchestrate-revive`'s
  job — a script invoked by the daemon's sweep, not the daemon's own decision
  tree. Conflating those (e.g., un-terminalizing the status and adding a
  continuation arm to the daemon) would mix two distinct lifecycles into one
  state machine.
- **Session-id resolver fallback over signal-side plumbing**: the
  `linkScanPath` field is populated by Claude CLI within milliseconds of the
  `--bg` worker starting. Reading it on demand is cheap and self-contained —
  no `phase-agent-dispatch` change, no atomic-write contention with the
  existing single-writer guarantee on per-phase signals. The alternative
  (writing the session id into the signal at dispatch time) would require
  `phase-agent-dispatch` to parse Claude's init output, race the per-phase
  signal's initial write, and grow the schema surface for what is effectively
  a derived field.
- **Separate budget field, shared cap**: `phaseContinuationCount` ≠
  `continuationCount` so the operator can disambiguate which lifecycle did
  the continuing. Sharing `MAX_CONTINUATIONS` avoids a second config knob
  for the same kind of decision.

**Alternatives considered**

- **Un-terminalize `turn-cap-exhausted` in the daemon**: would let the daemon's
  reclaim/revive pass walk into the continuation logic, but conflates two
  distinct recovery operations and grows the daemon's state surface.
- **Plumb session id into the per-phase signal at dispatch time**: removes
  the resolver fallback's dependency on Claude CLI's job dir layout, but
  duplicates a derived field that the job dir already owns and adds a
  signal-side race with the existing single-write contract. Deferred — the
  fallback is sufficient and easy to revisit if `linkScanPath` proves flaky.

**Consequences**

- Phase-mode workers can chain `turn-cap-exhausted` continuations
  automatically up to `MAX_CONTINUATIONS`.
- `phaseContinuationCount` becomes a visible signal field. The schema
  validator (`signal-schema.ts`) is documented with a sibling comment so
  future readers see the parallel with the top-level `continuationCount`.
- `--bg` session id resolution gains a second entry point
  (`resolve_phase_session_id`) distinct from the stream-JSONL-driven
  `resolve_session_id`; both coexist (the legacy resolver still serves
  ADR-019's top-level branch).

---

## ADR-021: Workspace-level type-label taxonomy (CTL-995)

**Decision**: All six type labels (`bug`, `feature`, `refactor`, `docs`, `chore`, `test`) live
at workspace scope (not per-team), nested under a single `type` label group, with canonical
palette colors: bug `#e5484d` · feature `#8b5cf6` · refactor `#14b8a6` · docs `#3b82f6` ·
chore `#8d8d8d` · test `#22c55e`.

**Rationale**:

- Pre-migration state had `refactor`, `docs`, `chore`, and `test` as per-team labels duplicated
  across CTL/ADV/OTL/SLI/EVR, causing color drift and making the UI badge design system require
  per-team ID lists instead of a single workspace ID per type.
- `bug` and `feature` were already at workspace scope; unifying all six removes the asymmetry.
- A `type` group label provides a logical container so the six labels are visually grouped in
  the Linear label picker.

**Alternatives considered**:

- **Promote team labels in-place via `issueLabelUpdate(teamId: null)`**: API rejected this field
  (not in `IssueLabelUpdateInput`); fell back to rename-create-relabel-delete.
- **Leave per-team labels, add workspace labels as aliases**: would create two labels per type,
  ambiguous for new tickets.

**Consequences**:

- Any tooling that filters by label ID must use the workspace IDs documented in
  `thoughts/shared/research/2026-06-10-ctl-995-label-taxonomy-migration.md`.
- Component labels (orchestrator/broker/phase-agent/monitor/cli/ci/website/estimation/worktree)
  remain team-scoped (CTL-only) — only the type axis is workspace-level.
- New tickets on any team should apply workspace type labels; team-scoped type labels should not
  be created.

---

## ADR-022: Belief engine is a derivation layer; "log → projection" is the directional target, not the shipped reality

**Status**: Accepted (direction), 2026-06-14. Track A active; Track B is a deliberate, un-started bet.

**Context**: External research into the "log is the agent" line (ActiveGraph / arXiv 2605.21997 /
operad / ESAA) prompted the question: how does Catalyst's stratified-Datalog belief engine
(`execution-core/beliefs/`, CTL-962→967, CTL-1063) fit the immutable-log-+-deterministic-projection
model? A 24-agent verification workflow (`wf_42692b50-b35`, 2026-06-14) plus an adversarial pro/con
panel established the facts. Two source documents hold the full reasoning:
`thoughts/shared/research/2026-06-14-resilience-and-peer-platform-learnings.md` and
`thoughts/shared/research/2026-06-13-catalyst-patentability-and-open-core-strategy.md`.

The conceptual fit is exact: Datalog's EDB→IDB deductive closure **is** event-sourcing's
`state = fold(log)`, expressed declaratively. The belief engine also already gets the hard
determinism discipline right — `now` captured once per tick (`collector.mjs:765`), the EDB frozen
inside a single SQLite transaction during evaluation (`collector.mjs:348,734`), and a differential
shadow oracle (`advance-shadow.mjs`) that compares the Datalog `advance_to` against the procedural
`deriveAdvancement` on the same tick-locked snapshot. That is the categorically correct substrate.

But the verification established three facts that bound the claim:

1. **The EDB is fed from mutable live state, not the log.** Eight of nine `obs_*` tables are live
   probes (`obs_agent` shells `claude agents`; `obs_job` reads `~/.claude/jobs/*/state.json`;
   `obs_signal` reads the mutable `phase-*.json` files; `obs_linear/relation` read an in-memory API
   cache). The one log-sourced table, `obs_heartbeat`, is **permanently empty** because no
   `worker.heartbeat` emitter exists (`collector.mjs:164-167`). So as-shipped this is
   "the *filesystem* is the agent, observed through Datalog" — **not** a log projection.
2. **The custom `rules.dl` compiler compiles only 3 of 18 rules** (`compiler/index.mjs`); the
   load-bearing logic (recursive S5 dependency rules, S6 `advance_to`/`cycle_exhausted`) is `extern`
   hand-written SQL, with a 61KB checked-in generated artifact kept in hand-sync.
3. **Advancement is graded *against* the 33-line procedural `deriveAdvancement` as ground truth**
   (`advance-shadow.mjs`), so porting advancement to Datalog can at best equal it — low standalone ROI.

The engine has also been shadow/dark (default-off) its entire life; graduation is **not** a flag
flip — it is blocked on prerequisites that do not exist (a log-sourced EDB; `caused_by` + monotonic
`seq` on the canonical envelope, both verified absent).

**Decision**:

1. **Affirm "immutable log → deterministic projection" as the directional target**, and keep the
   belief engine as the principled projection substrate. Do **not** rip it out.
2. **Stop describing the belief EDB as a "log projection"** in docs/comments until its authoritative
   tables are sourced from the event log. Today it is a projection of parallel mutable state.
3. **Split the engine's conflated ambition into two tracks:**
   - **Track A — derivation / health / provenance / absence-detection brain.** Dependency reasoning
     (S5), `catalyst why` provenance, and negation-over-time absence detection. This is where Datalog
     beats the procedural code and where it earns its keep. It does **not** require replacing
     `deriveAdvancement` or the full rewrite. **Keep, invest, graduate.**
   - **Track B — Datalog owns the control path** (R16/R17 replace `deriveAdvancement`; log-sourced
     EDB; `signal.json` demoted to a regeneratable projection). A genuine architectural bet to be made
     *deliberately*, with the `advance-shadow` oracle as the zero-disagreement graduation gate — not
     drifted into.
4. **First graduation = the resilience absence-detector** (per ADR-relevant plan
   `2026-06-14-resilience-safeguard-monitor-outage.md`, L2): "no `github.*`/`linear.*` event in N
   minutes → `ingestion_stale`" is a one-line stratified-Datalog rule and the single thing the
   procedural code is worst at. It requires emitting the heartbeat/webhook-freshness events (fixing
   the empty `obs_heartbeat`), which exercises the log-as-EDB-source path for real and makes the
   engine authoritative for one valuable thing — all Track A, no `deriveAdvancement` replacement.

**Rationale**:

- The decide/act seam must stay a bright line: Datalog *derives* intent purely; an imperative
  executor *acts* and emits the resulting event back into the log. `advance-shadow` already respects
  this (derive-only); the one actuation path (`escalate.mjs`, gated by `CATALYST_INTENTS_ENFORCE=1`)
  sits outside the rule engine, which is correct.
- **Datalog, not Prolog**, is the right choice: guaranteed termination is a feature for a control
  plane that must always halt. Bounded `WITH RECURSIVE` (S5) is the correct use of recursion; resist
  drift toward Prolog-style unbounded search in the control path.
- Per-tick EDB checkpoints are the materialized-view/snapshot half of event sourcing — and the half
  ActiveGraph admits it lacks. The primitive is right; only its *source* is wrong.

**Consequences**:

- `caused_by` + monotonic `seq` on the canonical event envelope become prerequisites for a
  log-sourced EDB (tracked as the `EVENT_SCHEMA_CAUSAL_SEQ` gap; near-free, additive).
- The `rules.dl` compiler's fate is decided by Track-B intent: either migrate the load-bearing
  `extern` rules into compiled form, or retire the compiler — do not maintain a 3/18 compiler plus a
  hand-synced generated artifact indefinitely.
- **Do not "fix" `REVIVE_BUDGET=1`** — it is dead code in the live recovery path (the CTL-736
  progress-gate is the live model).
- Complements **ADR-018** (broker `replayWorkerStateProjection` is the existing event-fold pattern
  Track A extends) and **ADR-006/008** (log + SQLite session store). Supersedes nothing.

**Alternatives considered**:

- **Rip out the belief engine; keep procedural only** — rejected: loses dependency reasoning,
  provenance, and absence-detection the procedural code structurally cannot provide; discards correct
  determinism primitives and a finished migration instrument (the oracle).
- **Promote `advance_to` to authoritative now** — rejected: blocked on prerequisites, and advancement
  via Datalog has low standalone ROI (graded against the simple function as spec).
- **Full "log is the agent" rewrite now** — deferred: that is Track B, a deliberate bet, not a default.

---

## ADR-023: Shadow→Enforce Rollout Discipline for Autonomous Actuators

**Status**: Accepted, 2026-06-16.

**Context**: The fleet has accumulated several autonomous actuators — the session reaper (CTL-649/657), the proc-reaper (CTL-1165), the stall-janitor (CTL-1004/1064), the unstuck-sweep (CTL-1064), the belief-engine executors (CTL-962→967), and fleet-health self-heal (CTL-1165 D5). Each can take a real, hard-to-reverse action: kill a process, remove a git worktree, `claude stop` a session, apply a `needs-human` label, page an operator, force-push a branch. Without a shared rollout discipline an actuator could be enabled before its behavior is proven on a real host — the 1,798-job / 17 GB-swap reap-leak outage (CTL-1165) is the cautionary case. Several actuators independently adopted an `off|shadow|enforce` mode convention, but it was never elevated to a stated principle. Verified 2026-06-16: every recovery actuator on the live fleet runs on its conservative code default (shadow/off); nothing turns one on without an explicit flag.

**Decision**: Adopt one rollout discipline for every fleet actuator:

1. **Rules DERIVE, executors ACT.** The decision (a belief, a stall classification, a category) is computed purely; a separate imperative executor takes the action and emits the resulting event back into the log. The decide/act seam stays a bright line (mirrors ADR-022's belief-engine seam).
2. **Dark by default.** Every actuator ships `off` (or `shadow`), gated by a single knob — an env flag (`CATALYST_INTENTS_ENFORCE`, `CATALYST_STALL_JANITOR`, `CATALYST_UNSTUCK_SWEEP`, `CATALYST_DIAGNOSTICIAN`, `EXECUTION_CORE_FLEET_SELF_HEAL`) or a Layer-1 config mode (`orphanReaper.procReaper.mode`). Nothing derived is in the live decision path until an operator flips it.
3. **Three-state mode `off → shadow → enforce`.** Shadow emits a "would-X" twin (`procOrphans.would-reap`, `unstuck.would.push`, `janitor.would.kill`, the `advance-shadow` comparator) so the action is observable and auditable without firing.
4. **Gated criteria flips.** Promotion `shadow → enforce` requires written criteria verified on real hosts over a real observation window (the CTL-1165 proc-reaper criteria are the template: shadow has seen real candidates over ≥3–5 days; each candidate spot-checked as a true target; no false spared/reaped; steady-state bounded).
5. **Reversible by unset.** A flip reverts by unsetting the flag/mode + restart; gates fail closed (a failed `claude agents` liveness read aborts the sweep, killing nothing).
6. **One at a time.** Subsystem flips are independent knobs — flip one, watch, then the next; never a blanket "turn everything on."

**Rationale**:

- The reap-leak outage proved an unproven actuator can cause fleet-wide harm; shadow-first + gated criteria makes harm observable before it is possible.
- Independent knobs (vs one global switch) let the riskiest actuators (force-push, kill) be enabled last, after the cheap-safe ones (escalate, label) are proven. **Known coarseness**: `CATALYST_INTENTS_ENFORCE` is today a *single* global flag arming four belief executors at once; its safety rests on each being individually idempotent/bounded (`labelOnce` marker, bgJobId-pinned kill, max-attempts cap) until per-intent granularity exists.
- This is the cross-cutting statement of the **deterministic-vs-flexible boundary**: deterministic rule-based actuators (reapers, janitors, belief executors) stay predictable and gated this way; the flexible LLM reasoning layer (ADR-025) is a separate category with its own guardrails.

**Consequences**:

- New actuators MUST ship with an `off|shadow|enforce` mode, a `would-X` shadow event, and written promotion criteria — none goes straight to `enforce`.
- The mode convention is instantiated per-feature in `website/.../reference/configuration.md` + the config schema enum; this ADR is the principle they realize.
- Flips are operator-owned; there is (by design) no auto-promotion. The **ownerless-gate risk** — clean shadow evidence sitting with nobody driving the flip — is real and is itself an operator-surfacing concern (ADR-025 / CTL-1176).

**Alternatives considered**:

- **Enable actuators on merge (no gate)** — rejected: that is exactly what produced the reap-leak outage.
- **A single global enforce flag for all actuators** — rejected: couples low-risk and high-blast-radius actions; the independent-knob model is safer.

---

## ADR-024: Mechanical Fleet Hygiene — Reapers, Janitors, and Garbage Collection (Thread 1)

**Status**: Accepted, 2026-06-16.

**Context**: Each short-lived phase-agent worker leaves durable state behind: a `~/.claude/jobs/<id>` bg-job dir, an `execution-core/workers/<TICKET>/` phase-signal dir, a git worktree under `~/catalyst/wt/`, and reparented `node`/`bun` child processes. Unmanaged, these accumulate and degrade the fleet. Two incidents make the case: the reap-leak outage (1,798 job dirs / 17 GB swap, CTL-1165) and a 2026-06-16 incident where **137 `execution-core/workers/` state dirs cold the CTL-731 liveness snapshot** (`inFlightCount:0` while workers were live) → the daemon held *all* new-work dispatch, including Urgent. These are **mechanical** cleanup concerns, distinct from the inference engine (ADR-022) and the reasoning sweep (ADR-025), and were scattered across tickets with no unifying record.

**Decision**: Treat mechanical hygiene as one named layer of bounded, deterministic cleaners, each governed by ADR-023:

1. **Session/bg-worker reaper** (CTL-649/657) — reaps completed/dead bg workers (`claude stop` + `reap-complete`). Live/enforce.
2. **proc-reaper** (CTL-1165 D2, `orphanReaper.procReaper.mode`) — kills reparented `node`/`bun` grandchildren that `claude stop` orphans. Shadow; enforce-flip gated on the CTL-1165 criteria.
3. **job-dir GC** (CTL-1165 D3) — removes aged `~/.claude/jobs` dirs past a 24 h retention.
4. **worker-dir GC** (CTL-1205, **NEW — did not exist**) — removes `execution-core/workers/<TICKET>/` state dirs on pipeline completion (in the reaper's `pr.merged` cleanup, after worktree removal) + a periodic sweep for Done/merged tickets. Nothing reaped these before; the per-tick `readdirSync` over the pile is what cold the CTL-731 snapshot.
5. **stall-janitor** (CTL-1004/1064, `CATALYST_STALL_JANITOR`) — J1 reaps orphan git worktrees (teardown-done), J2 kills idle ghost sessions, J3 re-dispatches the narrow `prior-artifact-retry-exhausted` stall. Shadow → enforce.
6. **unstuck-sweep** (CTL-1064, `CATALYST_UNSTUCK_SWEEP`) — category-aware stalled-ticket rescuer; its `actByCategory` act-seams are intentionally unwired (`{}`) pending the act modules.
7. **fleet-health probe** (CTL-1165 D5) — alerts (`fleet.health.degraded`) on jobs/swap/procs thresholds; self-heal default-off.

**Boundary (load-bearing)**: these cleaners operate on fleet *state* (processes, dirs, worktrees, sessions); they do **not** reason about ticket content — that is ADR-025. They are **not interchangeable**: the stall-janitor reaps worktrees + sessions but **not** worker-state dirs (that is the worker-dir GC). A cold liveness snapshot is a worker-dir-GC problem, **not** a stall-janitor one — a distinction that misdiagnosed the 2026-06-16 incident until corrected.

**Rationale**:

- **Liveness depends on hygiene.** The CTL-731 guard (holds new work when the liveness snapshot is stale/cold) is pressured by per-tick I/O over accumulated state dirs; bounded dirs keep the snapshot warm.
- Each cleaner has a single clear target; conflating them (the "just flip the janitor" instinct) misdiagnoses incidents.
- The immutable event log is the source of truth — removing a completed ticket's state dir is safe; the daemon restores from the log on boot.

**Consequences**:

- **worker-dir GC (CTL-1205)** is the durable fix for the CTL-731 cold-snapshot incident class; the immediate relief is archiving worktree-gone + aged state dirs.
- Each cleaner follows ADR-023 (`off|shadow|enforce`, `would-X`, gated flips). proc-reaper / stall-janitor / unstuck-sweep remain shadow/off pending their criteria.
- The **CTL-731 liveness-snapshot guard** is named here as the reason hygiene matters; it had no durable doc before this ADR.

**Alternatives considered**:

- **Let state accumulate (rely on host reboots)** — rejected: the outages prove it does not hold.
- **One mega-reaper** — rejected: distinct targets need distinct, separately-gated cleaners.

---

## ADR-025: Pre-Human Reasoning-Recovery Sweep and Operator Surfacing (Thread 3)

**Status**: Accepted (direction), 2026-06-16. Surfacing shipped (CTL-1180/1182/1181); the reasoning sweep (CTL-1176) is proposed, not built.

**Context**: When a ticket stalls, fails, or needs a decision, two things must happen well: it must **surface** to the operator (not sit silent), and ideally something autonomous should try to **unstick** it before it consumes human attention. This session found both broken. ADV-1392's `pr` phase failed (`push_rejected_no_workflow_scope`) and surfaced **nowhere** — no `needs-human`, no inbox row, no comment — masked as Linear state `PR`, because `needs-human` was applied only for `status:"stalled"`, never `"failed"`. CTL-1167 stalled on a dirty-tree rebase precheck with no explanatory comment. A fleet scan found **31 silently-stuck tickets in a month against only 6 `escalate.human` events**. And nothing reasons over the escalation queue: the diagnostician (CTL-937/828) is evidence-only and dark, the stall-janitor's J3 covers one narrow category, `phase-remediate` (CTL-653) fires only in-pipeline on a verify verdict, and the unstuck-sweep's act-seams are unwired.

**Decision**: Define a flexible, LLM-reasoning recovery layer that sits in front of the human inbox — distinct from the deterministic hygiene (ADR-024) and belief (ADR-022) layers:

1. **The reasoning recovery sweep (CTL-1176)** — a periodic LLM pass over the stuck/failed/needs-human queue that, per item, reconstructs the situation from the immutable log + belief store + worktree/PR/CI state and asks *"is this genuinely a human-decision, or can I unblock it?"*. It resolves the mechanical cases via existing deterministic act-seams and escalates only true human-decisions, **with a written reason**. It unifies the prior fragments (diagnostician + janitor + sweeper + remediator). **Guardrail (adopted from CTL-828's three-panel review)**: it is **not** a general open-ended fixer — DETERMINISTIC when the stuck-type is typed and the fix mechanical; LLM only with a structured brief + a downstream deterministic re-check gate + hard cycle cap; HUMAN otherwise. No open-ended re-dispatch authority (that reopens the CTL-736 revive-storm). Every decision is written to the immutable log + a Linear comment (auditable).
2. **Surfacing model (CTL-1180, shipped)** — a terminally-`failed` phase surfaces like a `stalled` one: `needs-human` applied for `status ∈ {failed, stalled}` when not pipeline-done (scheduler terminal sweep), plus a `phaseFailed`/`escalationType` trigger in the monitor's `deriveAttention` so it reaches the Needs-You inbox + nav dot + `/queue`. Closes the `failed ≠ stalled` silent-stuck gap.
3. **Always-record comment policy (CTL-1182, shipped)** — every phase, *including a failed one*, records its outcome on the Linear ticket; a codified `linearis` fallback when the app-actor mirror fails; a failure-path comment so escalations self-document.
4. **Registered deterministic act-seams the sweep invokes** — the workflow-scope push detour (CTL-1181), sibling-conflict resolve (CTL-855), orphan-PR detect/adopt (CTL-1175/1159/1160), and the ADR-024 hygiene cleaners. The LLM *selects among* registered seams; it does not invent mutations.

**Rationale**:

- Today the fleet only **alerts** (`fleet.health.degraded`) and **escalates** (`needs-human`, inconsistently), then stops — the "before we just stop, try to clean it up" step exists only as scaffolding. The 31-silently-stuck / 6-escalations ratio quantifies the cost.
- The **deterministic-vs-flexible boundary** (ADR-023): rules/hygiene stay predictable and gated; the flexible LLM judgment is bounded to "human-or-not + which registered seam" — never an open-ended agent.
- **Surfacing is the floor.** Even before the sweep acts, a stuck ticket must reach the operator with a reason (CTL-1180/1182); inbox membership keys on the worker-dir/event signal status (`failed`/`stalled`/`needs-human`), not just `gh pr list`, so failed-but-no-PR cases (ADV-1392) surface.

**Consequences**:

- CTL-1176 needs its own scoping doc (it currently survives as one paragraph) and becomes this ADR's implementation vehicle.
- The belief executors (ADR-022, `INTENTS_ENFORCE`) and this LLM sweep are **complementary**: the deterministic layer escalates by rule; the flexible layer triages the escalation queue and attempts resolution.
- This is the architecture record for the "supervisor" concept previously split across CTL-780 (held) / CTL-828 (deferred) / CTL-937.

**Alternatives considered**:

- **A general "get-it-moving" agent with open-ended re-dispatch/fix authority** — rejected (CTL-828 panel): reopens the long-lived-orchestrator / revive-storm failure modes (CTL-736).
- **Surfacing only, no autonomous resolution** — insufficient: leaves resolvable stalls (a stray lockfile, a missing OAuth scope) consuming human attention.
- **Leave re-engagement to the inference engine's lease rules** (CTL-780) — that is the *deterministic* re-engagement, held pending the engine; this ADR is the *flexible* reasoning complement, not a replacement.
