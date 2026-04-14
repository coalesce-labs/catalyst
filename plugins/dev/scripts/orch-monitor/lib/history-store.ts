import { Database } from "bun:sqlite";
import { existsSync } from "fs";

export interface HistoryQuery {
  skill?: string;
  ticket?: string;
  since?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryEntry {
  sessionId: string;
  workflowId: string | null;
  ticket: string | null;
  label: string | null;
  skillName: string | null;
  status: string;
  phase: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  costUsd: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
}

export interface HistoryResult {
  entries: HistoryEntry[];
  total: number;
}

export interface StatsQuery {
  skill?: string;
  since?: string;
}

export interface SkillBreakdown {
  skill: string;
  count: number;
  doneCount: number;
  failedCount: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgDurationMs: number;
  successRate: number;
}

export interface DailyCost {
  date: string;
  costUsd: number;
  sessionCount: number;
}

export interface ToolUsage {
  tool: string;
  totalCalls: number;
  totalDurationMs: number;
}

export interface StatsResult {
  totalSessions: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgDurationMs: number;
  successRate: number;
  skillBreakdown: SkillBreakdown[];
  dailyCosts: DailyCost[];
  topTools: ToolUsage[];
}

export interface ComparisonSide {
  sessionId: string;
  skillName: string | null;
  ticket: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  tools: ToolUsage[];
}

export interface SessionComparison {
  left: ComparisonSide;
  right: ComparisonSide;
}

function openReadonly(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err) {
    console.error(`[history-store] open failed for ${dbPath}:`, err);
    return null;
  }
}

interface HistoryRow {
  session_id: string;
  workflow_id: string | null;
  ticket_key: string | null;
  label: string | null;
  skill_name: string | null;
  status: string;
  phase: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
}

function rowToEntry(row: HistoryRow): HistoryEntry {
  return {
    sessionId: row.session_id,
    workflowId: row.workflow_id,
    ticket: row.ticket_key,
    label: row.label,
    skillName: row.skill_name,
    status: row.status,
    phase: row.phase,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
  };
}

export function queryHistory(
  dbPath: string,
  query: HistoryQuery,
): HistoryResult {
  const db = openReadonly(dbPath);
  if (!db) return { entries: [], total: 0 };

  try {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (query.skill) {
      clauses.push("s.skill_name = ?");
      params.push(query.skill);
    }
    if (query.ticket) {
      clauses.push("s.ticket_key = ?");
      params.push(query.ticket);
    }
    if (query.since) {
      clauses.push("s.started_at >= ?");
      params.push(query.since);
    }
    if (query.search) {
      clauses.push(
        "(s.skill_name LIKE ? OR s.ticket_key LIKE ? OR s.label LIKE ?)",
      );
      const pattern = `%${query.search}%`;
      params.push(pattern, pattern, pattern);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const countSql = `SELECT COUNT(*) as cnt FROM sessions s ${where}`;
    const countRow = db.prepare(countSql).get(...params) as { cnt: number };
    const total = countRow?.cnt ?? 0;

    const limit =
      typeof query.limit === "number" && Number.isFinite(query.limit)
        ? `LIMIT ${Math.max(0, Math.floor(query.limit))}`
        : "";
    const offset =
      typeof query.offset === "number" && query.offset > 0
        ? `OFFSET ${Math.floor(query.offset)}`
        : "";

    const sql = `
      SELECT
        s.session_id, s.workflow_id, s.ticket_key, s.label, s.skill_name,
        s.status, s.phase, s.started_at, s.updated_at, s.completed_at,
        m.cost_usd, m.duration_ms, m.input_tokens, m.output_tokens, m.cache_read_tokens
      FROM sessions s
      LEFT JOIN session_metrics m ON m.session_id = s.session_id
      ${where}
      ORDER BY s.started_at DESC
      ${limit} ${offset}
    `;

    const rows = db.prepare(sql).all(...params) as HistoryRow[];
    return { entries: rows.map(rowToEntry), total };
  } catch (err) {
    console.error(`[history-store] queryHistory failed on ${dbPath}:`, err);
    return { entries: [], total: 0 };
  } finally {
    db.close();
  }
}

interface AggRow {
  total_sessions: number;
  total_cost: number | null;
  avg_cost: number | null;
  avg_duration: number | null;
  done_count: number;
}

interface SkillRow {
  skill_name: string;
  count: number;
  done_count: number;
  failed_count: number;
  total_cost: number | null;
  avg_cost: number | null;
  avg_duration: number | null;
}

interface DailyCostRow {
  day: string;
  cost: number;
  session_count: number;
}

interface ToolRow {
  tool_name: string;
  total_calls: number;
  total_duration_ms: number;
}

export function queryStats(dbPath: string, query: StatsQuery): StatsResult {
  const empty: StatsResult = {
    totalSessions: 0,
    totalCostUsd: 0,
    avgCostUsd: 0,
    avgDurationMs: 0,
    successRate: 0,
    skillBreakdown: [],
    dailyCosts: [],
    topTools: [],
  };

  const db = openReadonly(dbPath);
  if (!db) return empty;

  try {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (query.skill) {
      clauses.push("s.skill_name = ?");
      params.push(query.skill);
    }
    if (query.since) {
      clauses.push("s.started_at >= ?");
      params.push(query.since);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const aggSql = `
      SELECT
        COUNT(*) as total_sessions,
        SUM(COALESCE(m.cost_usd, 0)) as total_cost,
        AVG(COALESCE(m.cost_usd, 0)) as avg_cost,
        AVG(COALESCE(m.duration_ms, 0)) as avg_duration,
        SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) as done_count
      FROM sessions s
      LEFT JOIN session_metrics m ON m.session_id = s.session_id
      ${where}
    `;
    const agg = db.prepare(aggSql).get(...params) as AggRow | null;
    if (!agg || agg.total_sessions === 0) return empty;

    const skillSql = `
      SELECT
        COALESCE(s.skill_name, 'unknown') as skill_name,
        COUNT(*) as count,
        SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) as done_count,
        SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) as failed_count,
        SUM(COALESCE(m.cost_usd, 0)) as total_cost,
        AVG(COALESCE(m.cost_usd, 0)) as avg_cost,
        AVG(COALESCE(m.duration_ms, 0)) as avg_duration
      FROM sessions s
      LEFT JOIN session_metrics m ON m.session_id = s.session_id
      ${where}
      GROUP BY COALESCE(s.skill_name, 'unknown')
      ORDER BY total_cost DESC
    `;
    const skillRows = db.prepare(skillSql).all(...params) as SkillRow[];

    const dailySql = `
      SELECT
        DATE(s.started_at) as day,
        SUM(COALESCE(m.cost_usd, 0)) as cost,
        COUNT(*) as session_count
      FROM sessions s
      LEFT JOIN session_metrics m ON m.session_id = s.session_id
      ${where}
      GROUP BY DATE(s.started_at)
      ORDER BY day ASC
    `;
    const dailyRows = db.prepare(dailySql).all(...params) as DailyCostRow[];

    const sessionIdFilter = clauses.length
      ? `WHERE t.session_id IN (SELECT s.session_id FROM sessions s ${where})`
      : "";
    const toolSql = `
      SELECT
        t.tool_name,
        SUM(t.call_count) as total_calls,
        SUM(t.total_duration_ms) as total_duration_ms
      FROM session_tools t
      ${sessionIdFilter}
      GROUP BY t.tool_name
      ORDER BY total_calls DESC
      LIMIT 20
    `;
    const toolRows = db
      .prepare(toolSql)
      .all(...(clauses.length ? params : [])) as ToolRow[];

    return {
      totalSessions: agg.total_sessions,
      totalCostUsd: agg.total_cost ?? 0,
      avgCostUsd: agg.avg_cost ?? 0,
      avgDurationMs: agg.avg_duration ?? 0,
      successRate:
        agg.total_sessions > 0
          ? agg.done_count / agg.total_sessions
          : 0,
      skillBreakdown: skillRows.map((r) => ({
        skill: r.skill_name,
        count: r.count,
        doneCount: r.done_count,
        failedCount: r.failed_count,
        totalCostUsd: r.total_cost ?? 0,
        avgCostUsd: r.avg_cost ?? 0,
        avgDurationMs: r.avg_duration ?? 0,
        successRate: r.count > 0 ? r.done_count / r.count : 0,
      })),
      dailyCosts: dailyRows.map((r) => ({
        date: r.day,
        costUsd: r.cost,
        sessionCount: r.session_count,
      })),
      topTools: toolRows.map((r) => ({
        tool: r.tool_name,
        totalCalls: r.total_calls,
        totalDurationMs: r.total_duration_ms,
      })),
    };
  } catch (err) {
    console.error(`[history-store] queryStats failed on ${dbPath}:`, err);
    return empty;
  } finally {
    db.close();
  }
}

interface SessionDetailRow {
  session_id: string;
  skill_name: string | null;
  ticket_key: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
}

export function compareSessions(
  dbPath: string,
  idA: string,
  idB: string,
): SessionComparison | null {
  const db = openReadonly(dbPath);
  if (!db) return null;

  try {
    const sql = `
      SELECT
        s.session_id, s.skill_name, s.ticket_key, s.status,
        s.started_at, s.completed_at,
        COALESCE(m.cost_usd, 0) as cost_usd,
        COALESCE(m.duration_ms, 0) as duration_ms,
        COALESCE(m.input_tokens, 0) as input_tokens,
        COALESCE(m.output_tokens, 0) as output_tokens,
        COALESCE(m.cache_read_tokens, 0) as cache_read_tokens
      FROM sessions s
      LEFT JOIN session_metrics m ON m.session_id = s.session_id
      WHERE s.session_id = ?
    `;

    const rowA = db.prepare(sql).get(idA) as SessionDetailRow | null;
    const rowB = db.prepare(sql).get(idB) as SessionDetailRow | null;
    if (!rowA || !rowB) return null;

    const toolSql = `
      SELECT tool_name, call_count as total_calls, total_duration_ms
      FROM session_tools
      WHERE session_id = ?
      ORDER BY call_count DESC
    `;

    const toolsA = db.prepare(toolSql).all(idA) as ToolRow[];
    const toolsB = db.prepare(toolSql).all(idB) as ToolRow[];

    function buildSide(
      row: SessionDetailRow,
      tools: ToolRow[],
    ): ComparisonSide {
      return {
        sessionId: row.session_id,
        skillName: row.skill_name,
        ticket: row.ticket_key,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        costUsd: row.cost_usd ?? 0,
        durationMs: row.duration_ms ?? 0,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        cacheReadTokens: row.cache_read_tokens ?? 0,
        tools: tools.map((t) => ({
          tool: t.tool_name,
          totalCalls: t.total_calls,
          totalDurationMs: t.total_duration_ms,
        })),
      };
    }

    return {
      left: buildSide(rowA, toolsA),
      right: buildSide(rowB, toolsB),
    };
  } catch (err) {
    console.error(`[history-store] compareSessions failed on ${dbPath}:`, err);
    return null;
  } finally {
    db.close();
  }
}
