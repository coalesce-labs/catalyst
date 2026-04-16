import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { checkProcessAlive } from "./liveness";
import type { WorkerCost } from "./state-reader";

export interface SessionPr {
  number: number;
  url: string | null;
  ciStatus: string | null;
  openedAt: string | null;
  mergedAt: string | null;
}

export interface SessionState {
  sessionId: string;
  workflowId: string | null;
  ticket: string | null;
  label: string | null;
  skillName: string | null;
  status: string;
  phase: number;
  pid: number | null;
  alive: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  timeSinceUpdate: number;
  cost: WorkerCost | null;
  pr: SessionPr | null;
  cwd: string | null;
  gitBranch: string | null;
}

interface SessionStoreSnapshot {
  available: boolean;
  sessions: SessionState[];
}

export interface SessionQuery {
  soloOnly?: boolean;
  workflowId?: string;
  ticket?: string;
  status?: string;
  limit?: number;
}

function openReadonly(dbPath: string): Database | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    return db;
  } catch (err) {
    console.error(`[session-store] open failed for ${dbPath}:`, err);
    return null;
  }
}

/**
 * Returns true if dbPath exists and contains a `sessions` table we can query.
 * This is a cheap probe — callers use it to short-circuit when the SQLite
 * store isn't yet provisioned on this machine.
 */
export function sessionStoreAvailable(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = openReadonly(dbPath);
  if (!db) return false;
  try {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
      )
      .get();
    return !!row;
  } catch (err) {
    console.error(`[session-store] availability check failed:`, err);
    return false;
  } finally {
    db.close();
  }
}

interface SessionRow {
  session_id: string;
  workflow_id: string | null;
  ticket_key: string | null;
  label: string | null;
  skill_name: string | null;
  status: string;
  phase: number;
  pid: number | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  pr_number: number | null;
  pr_url: string | null;
  ci_status: string | null;
  opened_at: string | null;
  merged_at: string | null;
  cwd: string | null;
  git_branch: string | null;
}

function rowToState(row: SessionRow): SessionState {
  const timeSinceUpdate = (() => {
    const parsed = Date.parse(row.updated_at);
    if (Number.isNaN(parsed)) return 0;
    return Math.max(0, (Date.now() - parsed) / 1000);
  })();

  const cost: WorkerCost | null =
    row.cost_usd === null
      ? null
      : {
          costUSD: row.cost_usd ?? 0,
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          cacheReadTokens: row.cache_read_tokens ?? 0,
        };

  const pr: SessionPr | null =
    row.pr_number === null
      ? null
      : {
          number: row.pr_number,
          url: row.pr_url,
          ciStatus: row.ci_status,
          openedAt: row.opened_at,
          mergedAt: row.merged_at,
        };

  return {
    sessionId: row.session_id,
    workflowId: row.workflow_id,
    ticket: row.ticket_key,
    label: row.label,
    skillName: row.skill_name,
    status: row.status,
    phase: row.phase,
    pid: row.pid,
    alive: checkProcessAlive(row.pid),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    timeSinceUpdate,
    cost,
    pr,
    cwd: row.cwd ?? null,
    gitBranch: row.git_branch ?? null,
  };
}

/**
 * Read all (or filtered) sessions from the SQLite store, left-joined with
 * metrics and the most-recent PR per session. Returns a snapshot object
 * with an `available` flag so callers can distinguish "store not yet
 * provisioned" from "store queried and empty".
 */
export function readSessionStore(
  dbPath: string,
  query: SessionQuery = {},
): SessionStoreSnapshot {
  if (!existsSync(dbPath)) {
    return { available: false, sessions: [] };
  }

  const db = openReadonly(dbPath);
  if (!db) return { available: false, sessions: [] };

  try {
    // Build WHERE clause with parameter bindings so user input never
    // interpolates into SQL.
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (query.soloOnly) clauses.push("s.workflow_id IS NULL");
    if (query.workflowId) {
      clauses.push("s.workflow_id = ?");
      params.push(query.workflowId);
    }
    if (query.ticket) {
      clauses.push("s.ticket_key = ?");
      params.push(query.ticket);
    }
    if (query.status) {
      clauses.push("s.status = ?");
      params.push(query.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit =
      typeof query.limit === "number" && Number.isFinite(query.limit)
        ? `LIMIT ${Math.max(0, Math.floor(query.limit))}`
        : "";

    // Join latest PR per session (by opened_at DESC, then pr_number DESC as tiebreak).
    // SQLite's min/max with companion columns pattern is awkward; we use a
    // correlated subquery. Still cheap for realistic session counts.
    const sql = `
      SELECT
        s.session_id,
        s.workflow_id,
        s.ticket_key,
        s.label,
        s.skill_name,
        s.status,
        s.phase,
        s.pid,
        s.started_at,
        s.updated_at,
        s.completed_at,
        s.cwd,
        s.git_branch,
        m.cost_usd,
        m.input_tokens,
        m.output_tokens,
        m.cache_read_tokens,
        p.pr_number,
        p.pr_url,
        p.ci_status,
        p.opened_at,
        p.merged_at
      FROM sessions s
      LEFT JOIN session_metrics m ON m.session_id = s.session_id
      LEFT JOIN (
        SELECT session_id, pr_number, pr_url, ci_status, opened_at, merged_at
        FROM session_prs
        WHERE (session_id, pr_number) IN (
          SELECT session_id, MAX(pr_number) FROM session_prs GROUP BY session_id
        )
      ) p ON p.session_id = s.session_id
      ${where}
      ORDER BY s.started_at DESC
      ${limit}
    `;

    const rows = db.prepare(sql).all(...params) as SessionRow[];
    return {
      available: true,
      sessions: rows.map(rowToState),
    };
  } catch (err) {
    console.error(`[session-store] query failed on ${dbPath}:`, err);
    return { available: false, sessions: [] };
  } finally {
    db.close();
  }
}
