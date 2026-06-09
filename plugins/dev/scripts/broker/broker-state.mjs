// broker-state.mjs — Structured agent identity + ticket routing store (CTL-303).
//
// Extends filter-state.db with two new tables:
//
//   agents       — one row per active/recent agent; indexed by session_id.
//                  Enables auto-correlation: when an agent checks in with a
//                  ticket, the broker auto-derives pr_lifecycle interests when
//                  PR ↔ ticket links appear in subsequent events.
//
//   ticket_state — lightweight routing index for ticket_lifecycle interests.
//                  Keyed on ticket identifier (e.g. "CTL-275"). Updated by
//                  Linear webhook events so deterministic routing doesn't need
//                  a Groq round-trip.
//
// The filter_state table (from CTL-284) lives in the same DB file under the
// same openBrokerStateDb / closeBrokerStateDb umbrella so callers only open
// one SQLite handle.

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

let db = null;

const CATALYST_DIR = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
const DEFAULT_DB_PATH = resolve(CATALYST_DIR, "filter-state.db");

export function openBrokerStateDb(dbPath = DEFAULT_DB_PATH) {
  if (db) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  // CTL-821: don't fail instantly on transient WAL contention (live broker +
  // orch-monitor + test drivers can hold handles on the same file).
  db.run("PRAGMA busy_timeout = 5000");

  // Legacy filter_state table (CTL-284) — still needed for PR↔deploy correlation.
  db.run(`
    CREATE TABLE IF NOT EXISTS filter_state (
      interest_id      TEXT PRIMARY KEY,
      pr_number        INTEGER NOT NULL,
      repo             TEXT NOT NULL,
      merge_commit_sha TEXT,
      deployment_id    INTEGER,
      environment      TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      updated_at       TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_filter_state_sha
      ON filter_state(merge_commit_sha)
      WHERE merge_commit_sha IS NOT NULL
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_filter_state_deployment
      ON filter_state(deployment_id)
      WHERE deployment_id IS NOT NULL
  `);

  // CTL-303: structured agent identity table.
  db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id      TEXT PRIMARY KEY,
      agent_name    TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      orchestrator  TEXT,
      ticket        TEXT,
      claimed_pr    INTEGER,
      cwd           TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      checked_in_at TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);
  // CTL-402: add reason column to existing DBs (no-op on fresh installs).
  try {
    db.run(`ALTER TABLE agents ADD COLUMN reason TEXT`);
  } catch {
    /* already exists */
  }
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agents_ticket
      ON agents(ticket)
      WHERE ticket IS NOT NULL
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agents_orchestrator
      ON agents(orchestrator)
      WHERE orchestrator IS NOT NULL
  `);

  // CTL-303: ticket routing state for ticket_lifecycle interests.
  db.run(`
    CREATE TABLE IF NOT EXISTS ticket_state (
      ticket       TEXT PRIMARY KEY,
      linear_state TEXT,
      pr_number    INTEGER,
      updated_at   TEXT NOT NULL
    )
  `);
  // CTL-821 (Gateway L1 child a): grow ticket_state into the full Linear-truth
  // descriptor — additive ALTERs in try/catch (the CTL-402 pattern), so an
  // existing live filter-state.db migrates in place with zero data loss and a
  // re-open is a no-op. `removed_at` is the removed flag (null = present);
  // `uuid` carries the Linear entityId so a `remove` webhook (whose payload
  // has ONLY the UUID, never the CTL-123 identifier) can be resolved.
  for (const col of [
    "relations TEXT",
    "labels TEXT",
    "priority INTEGER",
    "resolution TEXT",
    "assignee TEXT",
    "uuid TEXT",
    "removed_at TEXT",
  ]) {
    try {
      db.run(`ALTER TABLE ticket_state ADD COLUMN ${col}`);
    } catch {
      /* already exists */
    }
  }
  // UNIQUE so a buggy upstream writing one entityId onto two identifiers fails
  // loud instead of silently shadowing a row in the remove-webhook resolution.
  // Drop-then-create migrates any interim non-unique version of this index;
  // ticket_state is small (hundreds of rows) so the per-boot rebuild is ~ms.
  db.run(`DROP INDEX IF EXISTS idx_ticket_state_uuid`);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_state_uuid
      ON ticket_state(uuid)
      WHERE uuid IS NOT NULL
  `);

  // CTL-403: waiting_sessions tracks active wait-for loops so the watchdog can
  // distinguish 'silently dead' (no heartbeat AND no active wait) from
  // 'legitimately waiting' (no heartbeat BUT wait has not yet timed out).
  db.run(`
    CREATE TABLE IF NOT EXISTS waiting_sessions (
      session_id   TEXT PRIMARY KEY,
      orchestrator TEXT,
      ticket       TEXT,
      wait_for     TEXT,
      timeout_ms   INTEGER NOT NULL,
      since        TEXT NOT NULL,
      timeout_at   TEXT NOT NULL,
      reason       TEXT,
      updated_at   TEXT NOT NULL
    )
  `);

  // CTL-532: event-sourced worker-state projection (ADR-018 Phase 3).
  // One row per (orchestrator, ticket) holding phase/status/PR/revive-count
  // derived purely from the durable event stream. Rebuilt idempotently on
  // every broker start by replayWorkerStateProjection().
  db.run(`
    CREATE TABLE IF NOT EXISTS worker_state (
      orchestrator   TEXT NOT NULL,
      ticket         TEXT NOT NULL,
      phase          TEXT,
      status         TEXT,
      pr_number      INTEGER,
      revive_count   INTEGER NOT NULL DEFAULT 0,
      last_event_id  TEXT,
      last_event_ts  TEXT,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (orchestrator, ticket)
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_worker_state_orchestrator
      ON worker_state(orchestrator)
  `);

  // CTL-532: idempotency ledger for revive counting — re-folding a seen
  // event id is a no-op, so a full-log replay never double-counts revives.
  db.run(`
    CREATE TABLE IF NOT EXISTS worker_revive_events (
      event_id      TEXT PRIMARY KEY,
      orchestrator  TEXT NOT NULL,
      ticket        TEXT NOT NULL,
      ts            TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_worker_revive_lookup
      ON worker_revive_events(orchestrator, ticket)
  `);

  // CTL-532: single-row observability/watermark record (id pinned to 1).
  db.run(`
    CREATE TABLE IF NOT EXISTS projection_meta (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id  TEXT,
      last_event_ts  TEXT,
      events_folded  INTEGER NOT NULL DEFAULT 0,
      updated_at     TEXT NOT NULL
    )
  `);

  return db;
}

export function closeBrokerStateDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function ensure() {
  if (!db) throw new Error("broker-state DB not opened — call openBrokerStateDb() first");
  return db;
}

const nowIso = () => new Date().toISOString();

// ─── filter_state helpers (verbatim from CTL-284 filter-state.mjs) ──────────

export function upsertFilterStateOpen({ interestId, prNumber, repo }) {
  ensure().run(
    `INSERT INTO filter_state (interest_id, pr_number, repo, status, updated_at)
     VALUES (?, ?, ?, 'open', ?)
     ON CONFLICT(interest_id) DO UPDATE SET
       pr_number = excluded.pr_number,
       repo = excluded.repo,
       status = 'open',
       merge_commit_sha = NULL,
       deployment_id = NULL,
       environment = NULL,
       updated_at = excluded.updated_at`,
    [interestId, prNumber, repo, nowIso()]
  );
}

export function setFilterStateMerged(interestId, mergeCommitSha) {
  const result = ensure().run(
    `UPDATE filter_state
       SET merge_commit_sha = ?, status = 'merged', updated_at = ?
       WHERE interest_id = ?`,
    [mergeCommitSha, nowIso(), interestId]
  );
  return result.changes > 0 ? { interestId } : null;
}

export function setFilterStateDeploying(mergeCommitSha, deploymentId, environment) {
  const row = ensure()
    .prepare(`SELECT interest_id FROM filter_state WHERE merge_commit_sha = ? LIMIT 1`)
    .get(mergeCommitSha);
  if (!row) return null;
  ensure().run(
    `UPDATE filter_state
       SET deployment_id = ?, environment = ?, status = 'deploying', updated_at = ?
       WHERE interest_id = ?`,
    [deploymentId, environment, nowIso(), row.interest_id]
  );
  return { interestId: row.interest_id };
}

export function setFilterStateDeployed(deploymentId) {
  const row = ensure()
    .prepare(`SELECT interest_id FROM filter_state WHERE deployment_id = ? LIMIT 1`)
    .get(deploymentId);
  if (!row) return null;
  ensure().run(
    `UPDATE filter_state SET status = 'deployed', updated_at = ? WHERE interest_id = ?`,
    [nowIso(), row.interest_id]
  );
  return { interestId: row.interest_id };
}

export function setFilterStateFailed(deploymentId) {
  const row = ensure()
    .prepare(`SELECT interest_id FROM filter_state WHERE deployment_id = ? LIMIT 1`)
    .get(deploymentId);
  if (!row) return null;
  ensure().run(`UPDATE filter_state SET status = 'failed', updated_at = ? WHERE interest_id = ?`, [
    nowIso(),
    row.interest_id,
  ]);
  return { interestId: row.interest_id };
}

export function deleteFilterState(interestId) {
  ensure().run(`DELETE FROM filter_state WHERE interest_id = ?`, [interestId]);
}

export function getFilterStateByInterest(interestId) {
  const row = ensure().prepare(`SELECT * FROM filter_state WHERE interest_id = ?`).get(interestId);
  if (!row) return null;
  return {
    interestId: row.interest_id,
    prNumber: row.pr_number,
    repo: row.repo,
    mergeCommitSha: row.merge_commit_sha,
    deploymentId: row.deployment_id,
    environment: row.environment,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

// ─── agents helpers ──────────────────────────────────────────────────────────

export function upsertAgent({
  agentId,
  agentName,
  sessionId,
  orchestrator,
  ticket,
  claimedPr,
  cwd,
}) {
  const ts = nowIso();
  ensure().run(
    `INSERT INTO agents
       (agent_id, agent_name, session_id, orchestrator, ticket, claimed_pr, cwd, status, checked_in_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       agent_name    = excluded.agent_name,
       orchestrator  = excluded.orchestrator,
       ticket        = excluded.ticket,
       claimed_pr    = excluded.claimed_pr,
       cwd           = excluded.cwd,
       status        = 'active',
       updated_at    = excluded.updated_at`,
    [
      agentId,
      agentName,
      sessionId,
      orchestrator ?? null,
      ticket ?? null,
      claimedPr ?? null,
      cwd ?? null,
      ts,
      ts,
    ]
  );
}

export function markAgentDone(agentId, status = "done", reason = null) {
  ensure().run(`UPDATE agents SET status = ?, updated_at = ?, reason = ? WHERE agent_id = ?`, [
    status,
    nowIso(),
    reason ?? null,
    agentId,
  ]);
}

export function getRecentAgents(limit = 20) {
  return ensure()
    .prepare(
      `SELECT agent_id, session_id, ticket, status, reason, checked_in_at, updated_at
       FROM agents ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit);
}

export function getAgentBySession(sessionId) {
  const row = ensure()
    .prepare(
      `SELECT * FROM agents WHERE session_id = ? AND status = 'active' ORDER BY checked_in_at DESC LIMIT 1`
    )
    .get(sessionId);
  return row ? rowToAgent(row) : null;
}

export function getAgentsByTicket(ticket) {
  return ensure()
    .prepare(
      `SELECT * FROM agents WHERE ticket = ? AND status = 'active' ORDER BY checked_in_at DESC`
    )
    .all(ticket)
    .map(rowToAgent);
}

export function getAgentsByOrchestrator(orchestrator) {
  return ensure()
    .prepare(
      `SELECT * FROM agents WHERE orchestrator = ? AND status = 'active' ORDER BY checked_in_at DESC`
    )
    .all(orchestrator)
    .map(rowToAgent);
}

function rowToAgent(row) {
  return {
    agentId: row.agent_id,
    agentName: row.agent_name,
    sessionId: row.session_id,
    orchestrator: row.orchestrator,
    ticket: row.ticket,
    claimedPr: row.claimed_pr,
    cwd: row.cwd,
    status: row.status,
    checkedInAt: row.checked_in_at,
    updatedAt: row.updated_at,
  };
}

// ─── waiting_sessions helpers (CTL-403) ──────────────────────────────────────

export function upsertWaitingSession({
  sessionId,
  orchestrator,
  ticket,
  waitFor,
  timeoutMs,
  since,
  reason,
}) {
  const timeoutAt = new Date(new Date(since).getTime() + timeoutMs).toISOString();
  ensure().run(
    `INSERT INTO waiting_sessions
       (session_id, orchestrator, ticket, wait_for, timeout_ms, since, timeout_at, reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       orchestrator = excluded.orchestrator,
       ticket       = excluded.ticket,
       wait_for     = excluded.wait_for,
       timeout_ms   = excluded.timeout_ms,
       since        = excluded.since,
       timeout_at   = excluded.timeout_at,
       reason       = excluded.reason,
       updated_at   = excluded.updated_at`,
    [
      sessionId,
      orchestrator ?? null,
      ticket ?? null,
      waitFor ?? null,
      timeoutMs,
      since,
      timeoutAt,
      reason ?? null,
      nowIso(),
    ]
  );
}

export function clearWaitingSession(sessionId) {
  ensure().run(`DELETE FROM waiting_sessions WHERE session_id = ?`, [sessionId]);
}

export function getWaitingSession(sessionId) {
  const row = ensure()
    .prepare(`SELECT * FROM waiting_sessions WHERE session_id = ?`)
    .get(sessionId);
  return row ? rowToWaitingSession(row) : null;
}

export function getActiveWaitingSessions(nowIso = new Date().toISOString()) {
  return ensure()
    .prepare(`SELECT * FROM waiting_sessions WHERE timeout_at > ? ORDER BY since`)
    .all(nowIso)
    .map(rowToWaitingSession);
}

function rowToWaitingSession(row) {
  return {
    sessionId: row.session_id,
    orchestrator: row.orchestrator,
    ticket: row.ticket,
    waitFor: row.wait_for,
    timeoutMs: row.timeout_ms,
    since: row.since,
    timeoutAt: row.timeout_at,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

// ─── ticket_state helpers ─────────────────────────────────────────────────────

export function upsertTicketState({ ticket, linearState, prNumber }) {
  ensure().run(
    `INSERT INTO ticket_state (ticket, linear_state, pr_number, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ticket) DO UPDATE SET
       linear_state = COALESCE(excluded.linear_state, linear_state),
       pr_number    = COALESCE(excluded.pr_number, pr_number),
       updated_at   = excluded.updated_at`,
    [ticket, linearState ?? null, prNumber ?? null, nowIso()]
  );
}

export function getTicketState(ticket) {
  const row = ensure().prepare(`SELECT * FROM ticket_state WHERE ticket = ?`).get(ticket);
  if (!row) return null;
  return {
    ticket: row.ticket,
    linearState: row.linear_state,
    prNumber: row.pr_number,
    updatedAt: row.updated_at,
  };
}

// ─── ticket descriptor helpers (CTL-821, Gateway L1 child a) ─────────────────

// Descriptor field → column map. Internal constant — the dynamic SQL below
// only ever interpolates these fixed column names, never caller input.
const DESCRIPTOR_COLUMNS = {
  state: "linear_state",
  prNumber: "pr_number",
  relations: "relations",
  labels: "labels",
  priority: "priority",
  resolution: "resolution",
  assignee: "assignee",
  uuid: "uuid",
};

// upsertTicketDescriptor — KEY-PRESENCE semantics (not COALESCE): a field
// ABSENT from the input keeps its stored value; a field present with an
// explicit null CLEARS it. This is load-bearing for the Assignment layer —
// a Linear unassign webhook carries assignee:null and MUST be expressible
// (back-off-when-human-assignee-removed keys off it). Webhook write-through
// callers should pass exactly the fields the webhook carried.
//
// relations/labels must be arrays/objects (stored as JSON text); passing a
// pre-stringified JSON string throws — silent double-encoding would hand
// child (b) a string where readers expect an array.
//
// `removed` is tri-state: true stamps removed_at (sticky — the FIRST removal
// timestamp survives duplicates), false clears it (Linear archive→unarchive
// arrives as `update`), undefined leaves it untouched. The whole upsert runs
// in one transaction so concurrent WAL readers (orch-monitor, the child-c
// read API) never observe the row between the insert and the removed stamp.
export function upsertTicketDescriptor(input = {}) {
  const { ticket, removed } = input;
  if (!ticket) return;
  const cols = [];
  const vals = [];
  for (const [field, col] of Object.entries(DESCRIPTOR_COLUMNS)) {
    if (!(field in input) || input[field] === undefined) continue; // absent → keep
    let v = input[field];
    if ((field === "relations" || field === "labels") && v !== null) {
      if (typeof v === "string") {
        throw new TypeError(
          `upsertTicketDescriptor: ${field} must be an array/object, not a pre-stringified JSON string`
        );
      }
      v = JSON.stringify(v);
    }
    cols.push(col);
    vals.push(v);
  }
  const d = ensure();
  const ts = nowIso();
  d.transaction(() => {
    const insertCols = ["ticket", ...cols, "updated_at"];
    const placeholders = insertCols.map(() => "?").join(", ");
    const setClauses = [
      ...cols.map((c) => `${c} = excluded.${c}`),
      "updated_at = excluded.updated_at",
    ];
    d.run(
      `INSERT INTO ticket_state (${insertCols.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT(ticket) DO UPDATE SET ${setClauses.join(", ")}`,
      [ticket, ...vals, ts]
    );
    if (removed === true) {
      d.run(`UPDATE ticket_state SET removed_at = COALESCE(removed_at, ?) WHERE ticket = ?`, [
        ts,
        ticket,
      ]);
    } else if (removed === false) {
      d.run(`UPDATE ticket_state SET removed_at = NULL WHERE ticket = ?`, [ticket]);
    }
  })();
}

function rowToTicketDescriptor(row) {
  const parse = (s) => {
    if (s === null || s === undefined) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  return {
    ticket: row.ticket,
    state: row.linear_state,
    prNumber: row.pr_number,
    relations: parse(row.relations),
    labels: parse(row.labels),
    priority: row.priority ?? null,
    resolution: row.resolution ?? null,
    assignee: row.assignee ?? null,
    uuid: row.uuid ?? null,
    removed: row.removed_at != null,
    removedAt: row.removed_at ?? null,
    updatedAt: row.updated_at,
  };
}

export function getTicketDescriptor(ticket) {
  const row = ensure().prepare(`SELECT * FROM ticket_state WHERE ticket = ?`).get(ticket);
  return row ? rowToTicketDescriptor(row) : null;
}

// getAllTicketDescriptors — bulk read of the whole ticket_state cache in ONE
// query (CTL-883). The orch-monitor read-model enriches every board ticket from
// the durable Linear cache; doing that per-ticket would re-prepare/execute a
// SELECT N times, so it consumes this single pass instead. Removed rows are
// excluded by default (the board never wants tombstoned tickets); pass
// `{ includeRemoved: true }` for the reconcile/debug paths that need them.
export function getAllTicketDescriptors({ includeRemoved = false } = {}) {
  const sql = includeRemoved
    ? `SELECT * FROM ticket_state ORDER BY ticket`
    : `SELECT * FROM ticket_state WHERE removed_at IS NULL ORDER BY ticket`;
  return ensure().prepare(sql).all().map(rowToTicketDescriptor);
}

// getTicketDescriptorByUuid — the UUID→identifier index lookup. Linear's
// `remove` webhook payload carries only the entityId UUID; this resolves it to
// the descriptor row populated by earlier create/update webhooks.
export function getTicketDescriptorByUuid(uuid) {
  if (!uuid) return null;
  const row = ensure().prepare(`SELECT * FROM ticket_state WHERE uuid = ?`).get(uuid);
  return row ? rowToTicketDescriptor(row) : null;
}

// markTicketRemovedByUuid — the `remove`-webhook write path: resolve the UUID,
// stamp removed_at (sticky — a duplicate remove keeps the first timestamp).
// Returns the resolved identifier, or null when the UUID was never indexed
// (the reconcile backstop, child e, owns that gap).
export function markTicketRemovedByUuid(uuid) {
  if (!uuid) return null;
  const row = ensure().prepare(`SELECT ticket FROM ticket_state WHERE uuid = ?`).get(uuid);
  if (!row) return null;
  const ts = nowIso();
  ensure().run(
    `UPDATE ticket_state SET removed_at = COALESCE(removed_at, ?), updated_at = ? WHERE ticket = ?`,
    [ts, ts, row.ticket]
  );
  return { ticket: row.ticket };
}

// ─── worker_state helpers (CTL-532) ──────────────────────────────────────────

// Statuses that mean the worker has finished — used by getStaleWorkers (and the
// projection reducer) so "terminal" is defined exactly once.
export const WORKER_TERMINAL_STATUSES = new Set(["done", "failed", "complete"]);

// upsertWorkerState — last-write-wins for phase/status gated on the event
// watermark; pr_number is COALESCE-sticky; revive_count is monotone (MAX);
// last_event_ts/last_event_id advance to the high-water mark. Mirrors the
// upsertTicketState COALESCE idiom but adds a watermark gate so an
// out-of-order (older) event can never regress phase/status.
export function upsertWorkerState({
  orchestrator,
  ticket,
  phase,
  status,
  prNumber,
  reviveCount,
  eventId,
  eventTs,
}) {
  if (!orchestrator || !ticket) return;
  ensure().run(
    `INSERT INTO worker_state
       (orchestrator, ticket, phase, status, pr_number, revive_count,
        last_event_id, last_event_ts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(orchestrator, ticket) DO UPDATE SET
       -- phase/status only move forward when the incoming event is at least
       -- as recent as the last folded event (watermark gate).
       phase = CASE
         WHEN excluded.last_event_ts IS NOT NULL
              AND (worker_state.last_event_ts IS NULL
                   OR excluded.last_event_ts >= worker_state.last_event_ts)
              AND excluded.phase IS NOT NULL
         THEN excluded.phase ELSE worker_state.phase END,
       status = CASE
         WHEN excluded.last_event_ts IS NOT NULL
              AND (worker_state.last_event_ts IS NULL
                   OR excluded.last_event_ts >= worker_state.last_event_ts)
              AND excluded.status IS NOT NULL
         THEN excluded.status ELSE worker_state.status END,
       pr_number    = COALESCE(excluded.pr_number, worker_state.pr_number),
       revive_count = MAX(excluded.revive_count, worker_state.revive_count),
       last_event_id = CASE
         WHEN excluded.last_event_ts IS NOT NULL
              AND (worker_state.last_event_ts IS NULL
                   OR excluded.last_event_ts >= worker_state.last_event_ts)
         THEN excluded.last_event_id ELSE worker_state.last_event_id END,
       last_event_ts = CASE
         WHEN excluded.last_event_ts IS NOT NULL
              AND (worker_state.last_event_ts IS NULL
                   OR excluded.last_event_ts >= worker_state.last_event_ts)
         THEN excluded.last_event_ts ELSE worker_state.last_event_ts END,
       updated_at   = excluded.updated_at`,
    [
      orchestrator,
      ticket,
      phase ?? null,
      status ?? null,
      prNumber ?? null,
      reviveCount ?? 0,
      eventId ?? null,
      eventTs ?? null,
      nowIso(),
    ]
  );
}

export function getWorkerState(orchestrator, ticket) {
  const row = ensure()
    .prepare(`SELECT * FROM worker_state WHERE orchestrator = ? AND ticket = ?`)
    .get(orchestrator, ticket);
  return row ?? null;
}

export function getWorkerStatesByOrchestrator(orchestrator) {
  return ensure()
    .prepare(`SELECT * FROM worker_state WHERE orchestrator = ? ORDER BY ticket`)
    .all(orchestrator);
}

export function getAllWorkerStates() {
  return ensure().prepare(`SELECT * FROM worker_state ORDER BY orchestrator, ticket`).all();
}

// recordReviveEvent — INSERT OR IGNORE into the idempotency ledger; returns
// true only when a genuinely new row was inserted (changes > 0), so a re-fold
// of a previously seen revive event id is a safe no-op.
export function recordReviveEvent({ eventId, orchestrator, ticket, ts }) {
  if (!eventId || !orchestrator || !ticket) return false;
  const result = ensure().run(
    `INSERT OR IGNORE INTO worker_revive_events (event_id, orchestrator, ticket, ts)
     VALUES (?, ?, ?, ?)`,
    [eventId, orchestrator, ticket, ts ?? nowIso()]
  );
  return result.changes > 0;
}

export function getReviveCount(orchestrator, ticket) {
  const row = ensure()
    .prepare(
      `SELECT COUNT(*) AS n FROM worker_revive_events
       WHERE orchestrator = ? AND ticket = ?`
    )
    .get(orchestrator, ticket);
  return row?.n ?? 0;
}

export function getProjectionMeta() {
  const row = ensure().prepare(`SELECT * FROM projection_meta WHERE id = 1`).get();
  if (!row) return null;
  return {
    lastEventId: row.last_event_id,
    lastEventTs: row.last_event_ts,
    eventsFolded: row.events_folded,
  };
}

export function setProjectionMeta({ lastEventId, lastEventTs, eventsFolded }) {
  ensure().run(
    `INSERT INTO projection_meta (id, last_event_id, last_event_ts, events_folded, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_event_id = excluded.last_event_id,
       last_event_ts = excluded.last_event_ts,
       events_folded = excluded.events_folded,
       updated_at    = excluded.updated_at`,
    [lastEventId ?? null, lastEventTs ?? null, eventsFolded ?? 0, nowIso()]
  );
}

// getStaleWorkers — event-sourced liveness read. Returns non-terminal rows
// whose last_event_ts is STRICTLY older than `thresholdMs` before `nowIso`.
// This is the positive, event-sourced replacement for the signal-mtime
// heuristic in orchestrate-healthcheck Pass 2 (no caller wired in CTL-532).
export function getStaleWorkers(thresholdMs, nowIso = new Date().toISOString()) {
  const cutoff = new Date(new Date(nowIso).getTime() - thresholdMs).toISOString();
  const terminal = [...WORKER_TERMINAL_STATUSES];
  const placeholders = terminal.map(() => "?").join(", ");
  return ensure()
    .prepare(
      `SELECT * FROM worker_state
       WHERE last_event_ts IS NOT NULL
         AND last_event_ts < ?
         AND (status IS NULL OR status NOT IN (${placeholders}))
       ORDER BY last_event_ts`
    )
    .all(cutoff, ...terminal);
}
