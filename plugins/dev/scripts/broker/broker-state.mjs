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
  try { db.run(`ALTER TABLE agents ADD COLUMN reason TEXT`); } catch { /* already exists */ }
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
    [interestId, prNumber, repo, nowIso()],
  );
}

export function setFilterStateMerged(interestId, mergeCommitSha) {
  const result = ensure().run(
    `UPDATE filter_state
       SET merge_commit_sha = ?, status = 'merged', updated_at = ?
       WHERE interest_id = ?`,
    [mergeCommitSha, nowIso(), interestId],
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
    [deploymentId, environment, nowIso(), row.interest_id],
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
    [nowIso(), row.interest_id],
  );
  return { interestId: row.interest_id };
}

export function setFilterStateFailed(deploymentId) {
  const row = ensure()
    .prepare(`SELECT interest_id FROM filter_state WHERE deployment_id = ? LIMIT 1`)
    .get(deploymentId);
  if (!row) return null;
  ensure().run(
    `UPDATE filter_state SET status = 'failed', updated_at = ? WHERE interest_id = ?`,
    [nowIso(), row.interest_id],
  );
  return { interestId: row.interest_id };
}

export function deleteFilterState(interestId) {
  ensure().run(`DELETE FROM filter_state WHERE interest_id = ?`, [interestId]);
}

export function getFilterStateByInterest(interestId) {
  const row = ensure()
    .prepare(`SELECT * FROM filter_state WHERE interest_id = ?`)
    .get(interestId);
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

export function upsertAgent({ agentId, agentName, sessionId, orchestrator, ticket, claimedPr, cwd }) {
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
    [agentId, agentName, sessionId, orchestrator ?? null, ticket ?? null, claimedPr ?? null, cwd ?? null, ts, ts],
  );
}

export function markAgentDone(agentId, status = "done", reason = null) {
  ensure().run(
    `UPDATE agents SET status = ?, updated_at = ?, reason = ? WHERE agent_id = ?`,
    [status, nowIso(), reason ?? null, agentId],
  );
}

export function getRecentAgents(limit = 20) {
  return ensure()
    .prepare(
      `SELECT agent_id, session_id, ticket, status, reason, checked_in_at, updated_at
       FROM agents ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function getAgentBySession(sessionId) {
  const row = ensure()
    .prepare(`SELECT * FROM agents WHERE session_id = ? AND status = 'active' ORDER BY checked_in_at DESC LIMIT 1`)
    .get(sessionId);
  return row ? rowToAgent(row) : null;
}

export function getAgentsByTicket(ticket) {
  return ensure()
    .prepare(`SELECT * FROM agents WHERE ticket = ? AND status = 'active' ORDER BY checked_in_at DESC`)
    .all(ticket)
    .map(rowToAgent);
}

export function getAgentsByOrchestrator(orchestrator) {
  return ensure()
    .prepare(`SELECT * FROM agents WHERE orchestrator = ? AND status = 'active' ORDER BY checked_in_at DESC`)
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

export function upsertWaitingSession({ sessionId, orchestrator, ticket, waitFor, timeoutMs, since, reason }) {
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
    [sessionId, orchestrator ?? null, ticket ?? null, waitFor ?? null, timeoutMs, since, timeoutAt, reason ?? null, nowIso()],
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
    [ticket, linearState ?? null, prNumber ?? null, nowIso()],
  );
}

export function getTicketState(ticket) {
  const row = ensure()
    .prepare(`SELECT * FROM ticket_state WHERE ticket = ?`)
    .get(ticket);
  if (!row) return null;
  return {
    ticket: row.ticket,
    linearState: row.linear_state,
    prNumber: row.pr_number,
    updatedAt: row.updated_at,
  };
}
