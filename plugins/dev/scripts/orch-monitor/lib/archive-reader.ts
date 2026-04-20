import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface ArchivedOrchestrator {
  orchId: string;
  name: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  wavesCount: number;
  workersCount: number;
  prsMergedCount: number;
  ticketsTouched: string[];
  archivePath: string;
  hasRollup: boolean;
  archivedAt: string;
}

export interface ArchivedWorker {
  workerId: string;
  orchId: string;
  ticket: string | null;
  prNumber: number | null;
  prState: string | null;
  finalStatus: string | null;
  durationMs: number;
  costUsd: number;
  hasSummary: boolean;
  hasRollupFragment: boolean;
  archivedAt: string;
}

export interface ArchivedArtifact {
  artifactId: number;
  orchId: string;
  workerId: string | null;
  kind: string;
  path: string;
  bytes: number;
  sha256: string | null;
  createdAt: string;
}

export interface ArchiveListQuery {
  since?: string;
  until?: string;
  ticket?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ArchiveListResult {
  entries: ArchivedOrchestrator[];
  total: number;
}

export interface ArchiveDetailResult {
  orch: ArchivedOrchestrator;
  workers: ArchivedWorker[];
  artifacts: ArchivedArtifact[];
}

function openReadonly(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err) {
    console.error(`[archive-reader] open failed for ${dbPath}:`, err);
    return null;
  }
}

interface OrchRow {
  orch_id: string;
  name: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  waves_count: number;
  workers_count: number;
  prs_merged_count: number;
  tickets_touched: string | null;
  archive_path: string;
  has_rollup: number;
  archived_at: string;
}

function rowToOrch(row: OrchRow): ArchivedOrchestrator {
  let tickets: string[] = [];
  if (row.tickets_touched) {
    try {
      const parsed: unknown = JSON.parse(row.tickets_touched);
      if (Array.isArray(parsed)) {
        tickets = parsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      // malformed JSON — leave tickets empty
    }
  }
  return {
    orchId: row.orch_id,
    name: row.name,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    wavesCount: row.waves_count,
    workersCount: row.workers_count,
    prsMergedCount: row.prs_merged_count,
    ticketsTouched: tickets,
    archivePath: row.archive_path,
    hasRollup: row.has_rollup === 1,
    archivedAt: row.archived_at,
  };
}

export function listArchivedOrchestrators(
  dbPath: string,
  query: ArchiveListQuery,
): ArchiveListResult {
  const db = openReadonly(dbPath);
  if (!db) return { entries: [], total: 0 };

  try {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (query.since) {
      clauses.push("started_at >= ?");
      params.push(query.since);
    }
    if (query.until) {
      clauses.push("started_at <= ?");
      params.push(query.until);
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query.ticket) {
      clauses.push("tickets_touched LIKE ?");
      params.push(`%${query.ticket}%`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const countRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM orchestrators ${where}`)
      .get(...params) as { cnt: number };
    const total = countRow?.cnt ?? 0;

    const limit =
      typeof query.limit === "number" && Number.isFinite(query.limit)
        ? `LIMIT ${Math.max(0, Math.floor(query.limit))}`
        : "";
    const offset =
      typeof query.offset === "number" && query.offset > 0
        ? `OFFSET ${Math.floor(query.offset)}`
        : "";

    const rows = db
      .prepare(
        `SELECT orch_id, name, started_at, completed_at, status,
                waves_count, workers_count, prs_merged_count,
                tickets_touched, archive_path, has_rollup, archived_at
         FROM orchestrators
         ${where}
         ORDER BY started_at DESC
         ${limit} ${offset}`,
      )
      .all(...params) as OrchRow[];

    return { entries: rows.map(rowToOrch), total };
  } finally {
    db.close();
  }
}

interface WorkerRow {
  worker_id: string;
  orch_id: string;
  ticket: string | null;
  pr_number: number | null;
  pr_state: string | null;
  final_status: string | null;
  duration_ms: number;
  cost_usd: number;
  has_summary: number;
  has_rollup_fragment: number;
  archived_at: string;
}

function rowToWorker(row: WorkerRow): ArchivedWorker {
  return {
    workerId: row.worker_id,
    orchId: row.orch_id,
    ticket: row.ticket,
    prNumber: row.pr_number,
    prState: row.pr_state,
    finalStatus: row.final_status,
    durationMs: row.duration_ms,
    costUsd: row.cost_usd,
    hasSummary: row.has_summary === 1,
    hasRollupFragment: row.has_rollup_fragment === 1,
    archivedAt: row.archived_at,
  };
}

interface ArtifactRow {
  artifact_id: number;
  orch_id: string;
  worker_id: string | null;
  kind: string;
  path: string;
  bytes: number;
  sha256: string | null;
  created_at: string;
}

function rowToArtifact(row: ArtifactRow): ArchivedArtifact {
  return {
    artifactId: row.artifact_id,
    orchId: row.orch_id,
    workerId: row.worker_id,
    kind: row.kind,
    path: row.path,
    bytes: row.bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export function getArchivedOrchestrator(
  dbPath: string,
  orchId: string,
): ArchiveDetailResult | null {
  const db = openReadonly(dbPath);
  if (!db) return null;

  try {
    const orchRow = db
      .prepare(
        `SELECT orch_id, name, started_at, completed_at, status,
                waves_count, workers_count, prs_merged_count,
                tickets_touched, archive_path, has_rollup, archived_at
         FROM orchestrators WHERE orch_id = ?`,
      )
      .get(orchId) as OrchRow | null;

    if (!orchRow) return null;

    const workers = db
      .prepare(
        `SELECT worker_id, orch_id, ticket, pr_number, pr_state, final_status,
                duration_ms, cost_usd, has_summary, has_rollup_fragment, archived_at
         FROM archived_workers WHERE orch_id = ?
         ORDER BY ticket`,
      )
      .all(orchId) as WorkerRow[];

    const artifacts = db
      .prepare(
        `SELECT artifact_id, orch_id, worker_id, kind, path, bytes, sha256, created_at
         FROM archived_artifacts WHERE orch_id = ?
         ORDER BY worker_id NULLS FIRST, kind, path`,
      )
      .all(orchId) as ArtifactRow[];

    return {
      orch: rowToOrch(orchRow),
      workers: workers.map(rowToWorker),
      artifacts: artifacts.map(rowToArtifact),
    };
  } finally {
    db.close();
  }
}

export function getArchivePath(dbPath: string, orchId: string): string | null {
  const db = openReadonly(dbPath);
  if (!db) return null;
  try {
    const row = db
      .prepare(`SELECT archive_path FROM orchestrators WHERE orch_id = ?`)
      .get(orchId) as { archive_path: string } | null;
    return row?.archive_path ?? null;
  } finally {
    db.close();
  }
}
