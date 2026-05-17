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
`claude -p /catalyst-dev:oneshot <TICKET> --auto-merge` per ticket. That worker
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
`--bg` job per phase. The orchestrator walks the canonical 9-phase sequence
(`triage` → `research` → `plan` → `implement` → `verify` → `review` → `pr` →
`monitor-merge` → `monitor-deploy`) via `orchestrate-phase-advance`, waking on
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
  `{ticket, phase_names[9]}`. All four orchestrator interests
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
