#!/usr/bin/env bun
/**
 * catalyst-archive — persist completed orchestrator artifacts to durable archive.
 *
 * Writes filesystem blobs first, THEN SQLite rows. Reconciliation via `sync` repairs drift.
 * See CTL-110 and ADR-009 for the hybrid storage rationale.
 */
import { Database } from "bun:sqlite";
import {
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join, resolve, basename, relative, dirname } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Config

export interface ArchiveConfig {
  root: string;
  syncToThoughts: boolean;
  retention: { days: number | null };
  runsDir: string;
  dbPath: string;
  commsDir: string;
  thoughtsDir: string | null;
}

const HOME = process.env.HOME ?? "/tmp";
const DEFAULT_CATALYST_DIR = process.env.CATALYST_DIR ?? `${HOME}/catalyst`;

export function resolveConfig(
  overrides: Partial<ArchiveConfig> = {},
  configDir: string = process.env.CATALYST_CONFIG_DIR ??
    `${HOME}/.config/catalyst`,
): ArchiveConfig {
  const fileConfig = loadGlobalConfigArchiveBlock(configDir);

  const root =
    overrides.root ??
    process.env.CATALYST_ARCHIVE_ROOT ??
    fileConfig.root ??
    `${DEFAULT_CATALYST_DIR}/archives`;

  const syncToThoughts =
    overrides.syncToThoughts ?? fileConfig.syncToThoughts ?? false;

  const retentionDays =
    overrides.retention?.days ?? fileConfig.retention?.days ?? null;

  const runsDir =
    overrides.runsDir ??
    process.env.CATALYST_RUNS_DIR ??
    `${DEFAULT_CATALYST_DIR}/runs`;

  const dbPath =
    overrides.dbPath ??
    process.env.CATALYST_DB_FILE ??
    `${DEFAULT_CATALYST_DIR}/catalyst.db`;

  const commsDir =
    overrides.commsDir ??
    process.env.CATALYST_COMMS_DIR ??
    `${DEFAULT_CATALYST_DIR}/comms/channels`;

  const thoughtsDir = overrides.thoughtsDir ?? null;

  return {
    root: resolve(expandHome(root)),
    syncToThoughts,
    retention: { days: retentionDays },
    runsDir: resolve(expandHome(runsDir)),
    dbPath: resolve(expandHome(dbPath)),
    commsDir: resolve(expandHome(commsDir)),
    thoughtsDir: thoughtsDir ? resolve(expandHome(thoughtsDir)) : null,
  };
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

interface GlobalArchiveBlock {
  root?: string;
  syncToThoughts?: boolean;
  retention?: { days?: number | null };
}

function loadGlobalConfigArchiveBlock(configDir: string): GlobalArchiveBlock {
  const filePath = join(configDir, "config.json");
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && "archive" in parsed) {
      const block = (parsed as { archive?: unknown }).archive;
      if (block && typeof block === "object") {
        return block as GlobalArchiveBlock;
      }
    }
  } catch {
    // config file malformed — ignore, caller falls back to defaults
  }
  return {};
}

// ---------------------------------------------------------------------------
// Types

export type ArtifactKind =
  | "state"
  | "summary"
  | "rollup"
  | "briefing"
  | "phase-log"
  | "signal"
  | "tasks"
  | "comms"
  | "metadata";

export interface ArtifactWrite {
  sourcePath: string | null; // null = synthesized in-memory (metadata.json)
  relativeDest: string;
  kind: ArtifactKind;
  workerId: string | null;
  content?: Buffer | string; // only for synthesized
}

export interface SweepSummary {
  orchId: string;
  archivePath: string;
  archivedArtifacts: number;
  skippedArtifacts: string[];
  workers: number;
  hasRollup: boolean;
  startedAt: string;
  completedAt: string | null;
  wavesCount: number;
  prsMergedCount: number;
  ticketsTouched: string[];
}

export interface OrchestratorState {
  orchestrator?: string;
  name?: string;
  startedAt?: string;
  completedAt?: string;
  status?: string;
  totalWaves?: number;
  waves?: { wave: number; status: string; tickets?: string[] }[];
  workers?: Record<string, unknown>;
}

export interface WorkerSignal {
  ticket?: string;
  workerName?: string;
  status?: string;
  worktreePath?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  pr?: {
    number?: number;
    url?: string;
    ciStatus?: string;
    mergedAt?: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Filesystem helpers

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function atomicWrite(destPath: string, content: Buffer | string): void {
  ensureDir(dirname(destPath));
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, destPath);
}

function atomicCopy(sourcePath: string, destPath: string): void {
  const content = readFileSync(sourcePath);
  atomicWrite(destPath, content);
}

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Source discovery

function readOrchestratorState(
  runsDir: string,
  orchId: string,
): OrchestratorState | null {
  const p = join(runsDir, orchId, "state.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as OrchestratorState;
  } catch {
    return null;
  }
}

function readWorkerSignal(path: string): WorkerSignal | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkerSignal;
  } catch {
    return null;
  }
}

function listWaveBriefings(orchDir: string): string[] {
  if (!existsSync(orchDir)) return [];
  return readdirSync(orchDir)
    .filter((f) => /^wave-\d+-briefing\.md$/.test(f))
    .map((f) => join(orchDir, f))
    .sort();
}

function listWorkerSignalFiles(orchDir: string): string[] {
  const workersDir = join(orchDir, "workers");
  if (!existsSync(workersDir)) return [];
  return readdirSync(workersDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(workersDir, f))
    .sort();
}

function findWorkerSummary(
  workerId: string,
  signal: WorkerSignal | null,
  thoughtsDir: string | null,
  orchName: string,
): string | null {
  if (signal?.worktreePath) {
    const p = join(signal.worktreePath, "SUMMARY.md");
    if (existsSync(p)) return p;
  }
  if (thoughtsDir) {
    const handoffsDir = join(thoughtsDir, "shared", "handoffs", orchName);
    if (existsSync(handoffsDir)) {
      const matches = readdirSync(handoffsDir).filter((f) =>
        f.includes(workerId),
      );
      for (const m of matches) {
        const full = join(handoffsDir, m);
        if (m.includes("SUMMARY") || m.endsWith(".md")) return full;
      }
    }
  }
  return null;
}

function findWorkerRollupFragment(
  signal: WorkerSignal | null,
): string | null {
  if (!signal?.worktreePath) return null;
  const p = join(signal.worktreePath, "rollup-fragment.md");
  return existsSync(p) ? p : null;
}

function findWorkerPhaseLog(orchDir: string, workerId: string): string | null {
  const p = join(orchDir, "workers", "output", `${workerId}-stream.jsonl`);
  return existsSync(p) ? p : null;
}

function findCommsChannels(commsDir: string, orchId: string): string[] {
  if (!existsSync(commsDir)) return [];
  const matches: string[] = [];
  for (const f of readdirSync(commsDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const full = join(commsDir, f);
    if (fileContainsOrchId(full, orchId)) matches.push(full);
  }
  return matches.sort();
}

function fileContainsOrchId(path: string, orchId: string): boolean {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj: unknown = JSON.parse(line);
        if (obj && typeof obj === "object" && "orch" in obj) {
          const v = (obj as { orch?: unknown }).orch;
          if (v === orchId) return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core sweep logic

export function buildArtifactManifest(
  orchId: string,
  config: ArchiveConfig,
): ArtifactWrite[] {
  const orchDir = join(config.runsDir, orchId);
  if (!existsSync(orchDir)) {
    throw new Error(`Orchestrator dir not found: ${orchDir}`);
  }
  const state = readOrchestratorState(config.runsDir, orchId);
  const orchName = state?.orchestrator ?? state?.name ?? orchId;

  const manifest: ArtifactWrite[] = [];

  const statePath = join(orchDir, "state.json");
  if (existsSync(statePath)) {
    manifest.push({
      sourcePath: statePath,
      relativeDest: "orch-state.json",
      kind: "state",
      workerId: null,
    });
  }

  const summaryPath = join(orchDir, "SUMMARY.md");
  if (existsSync(summaryPath)) {
    manifest.push({
      sourcePath: summaryPath,
      relativeDest: "SUMMARY.md",
      kind: "summary",
      workerId: null,
    });
  }

  const rollupPath = join(orchDir, "rollup-briefing.md");
  if (existsSync(rollupPath)) {
    manifest.push({
      sourcePath: rollupPath,
      relativeDest: "rollup-briefing.md",
      kind: "rollup",
      workerId: null,
    });
  }

  for (const briefing of listWaveBriefings(orchDir)) {
    manifest.push({
      sourcePath: briefing,
      relativeDest: join("briefings", basename(briefing)),
      kind: "briefing",
      workerId: null,
    });
  }

  for (const signalPath of listWorkerSignalFiles(orchDir)) {
    const workerId = basename(signalPath, ".json");
    const signal = readWorkerSignal(signalPath);

    manifest.push({
      sourcePath: signalPath,
      relativeDest: join("workers", workerId, "signal-final.json"),
      kind: "signal",
      workerId,
    });

    const phaseLog = findWorkerPhaseLog(orchDir, workerId);
    if (phaseLog) {
      manifest.push({
        sourcePath: phaseLog,
        relativeDest: join("workers", workerId, "phase-log.jsonl"),
        kind: "phase-log",
        workerId,
      });
    }

    const summary = findWorkerSummary(
      workerId,
      signal,
      config.thoughtsDir,
      orchName,
    );
    if (summary) {
      manifest.push({
        sourcePath: summary,
        relativeDest: join("workers", workerId, "SUMMARY.md"),
        kind: "summary",
        workerId,
      });
    }

    const rollupFragment = findWorkerRollupFragment(signal);
    if (rollupFragment) {
      manifest.push({
        sourcePath: rollupFragment,
        relativeDest: join("workers", workerId, "rollup-fragment.md"),
        kind: "rollup",
        workerId,
      });
    }
  }

  for (const channel of findCommsChannels(config.commsDir, orchId)) {
    manifest.push({
      sourcePath: channel,
      relativeDest: join("comms", basename(channel)),
      kind: "comms",
      workerId: null,
    });
  }

  return manifest;
}

interface SweepOptions {
  dryRun?: boolean;
}

export function sweep(
  orchId: string,
  config: ArchiveConfig,
  options: SweepOptions = {},
): SweepSummary {
  const orchDir = join(config.runsDir, orchId);
  if (!existsSync(orchDir)) {
    throw new Error(`Orchestrator dir not found: ${orchDir}`);
  }

  const state = readOrchestratorState(config.runsDir, orchId);
  const orchName = state?.orchestrator ?? state?.name ?? orchId;
  const archivePath = join(config.root, orchId);

  if (!options.dryRun) ensureDir(archivePath);

  const manifest = buildArtifactManifest(orchId, config);
  const writtenArtifacts: {
    kind: ArtifactKind;
    workerId: string | null;
    path: string;
    bytes: number;
    sha256: string;
  }[] = [];
  const skipped: string[] = [];

  for (const item of manifest) {
    const destAbs = join(archivePath, item.relativeDest);

    if (!item.sourcePath && !item.content) {
      skipped.push(`${item.kind}:${item.relativeDest}`);
      continue;
    }

    if (item.sourcePath && !existsSync(item.sourcePath)) {
      skipped.push(`${item.kind}:${item.sourcePath}`);
      continue;
    }

    try {
      if (options.dryRun) {
        const bytes = item.sourcePath
          ? statSync(item.sourcePath).size
          : (item.content as Buffer | string).length;
        writtenArtifacts.push({
          kind: item.kind,
          workerId: item.workerId,
          path: item.relativeDest,
          bytes,
          sha256: "",
        });
        continue;
      }

      const buf = item.sourcePath
        ? readFileSync(item.sourcePath)
        : (() => {
            const c = item.content as Buffer | string;
            return typeof c === "string" ? Buffer.from(c) : c;
          })();
      atomicWrite(destAbs, buf);
      writtenArtifacts.push({
        kind: item.kind,
        workerId: item.workerId,
        path: item.relativeDest,
        bytes: buf.length,
        sha256: sha256Hex(buf),
      });
    } catch (err) {
      skipped.push(
        `${item.kind}:${item.relativeDest} (${(err as Error).message})`,
      );
    }
  }

  const workerSummaries = deriveWorkerSummaries(orchDir, writtenArtifacts);

  const wavesCount = state?.totalWaves ?? state?.waves?.length ?? 0;
  const ticketsTouched = collectTickets(state);
  const prsMergedCount = workerSummaries.filter((w) => w.prState === "merged")
    .length;
  const hasRollup = writtenArtifacts.some(
    (a) => a.kind === "rollup" && a.workerId === null,
  );
  const startedAt =
    state?.startedAt ?? nowIso(); // synthesize if state missing
  const completedAt = state?.completedAt ?? null;

  const metadata = {
    orchId,
    name: orchName,
    startedAt,
    completedAt,
    status: state?.status ?? "completed",
    wavesCount,
    workersCount: workerSummaries.length,
    prsMergedCount,
    ticketsTouched,
    archivedAt: nowIso(),
  };

  if (!options.dryRun) {
    const metadataPath = join(archivePath, "metadata.json");
    const metadataBuf = Buffer.from(JSON.stringify(metadata, null, 2));
    atomicWrite(metadataPath, metadataBuf);
    writtenArtifacts.push({
      kind: "metadata",
      workerId: null,
      path: "metadata.json",
      bytes: metadataBuf.length,
      sha256: sha256Hex(metadataBuf),
    });

    writeSqlite(
      config.dbPath,
      metadata,
      archivePath,
      hasRollup,
      workerSummaries,
      writtenArtifacts,
    );
  }

  return {
    orchId,
    archivePath,
    archivedArtifacts: writtenArtifacts.length,
    skippedArtifacts: skipped,
    workers: workerSummaries.length,
    hasRollup,
    startedAt,
    completedAt,
    wavesCount,
    prsMergedCount,
    ticketsTouched,
  };
}

interface WorkerRow {
  workerId: string;
  ticket: string | null;
  prNumber: number | null;
  prState: string | null;
  finalStatus: string | null;
  durationMs: number;
  costUsd: number;
  hasSummary: boolean;
  hasRollupFragment: boolean;
}

function deriveWorkerSummaries(
  orchDir: string,
  writtenArtifacts: {
    kind: ArtifactKind;
    workerId: string | null;
    path: string;
  }[],
): WorkerRow[] {
  const rows: WorkerRow[] = [];
  const workerIds = new Set<string>();
  for (const a of writtenArtifacts) {
    if (a.workerId) workerIds.add(a.workerId);
  }

  for (const workerId of workerIds) {
    const signalPath = join(orchDir, "workers", `${workerId}.json`);
    const signal = readWorkerSignal(signalPath);
    const hasSummary = writtenArtifacts.some(
      (a) => a.workerId === workerId && a.kind === "summary",
    );
    const hasRollupFragment = writtenArtifacts.some(
      (a) => a.workerId === workerId && a.kind === "rollup",
    );

    const startedMs = signal?.startedAt
      ? Date.parse(signal.startedAt)
      : Number.NaN;
    const endedMs =
      signal?.completedAt && signal.completedAt !== ""
        ? Date.parse(signal.completedAt)
        : signal?.updatedAt
          ? Date.parse(signal.updatedAt)
          : Number.NaN;
    const durationMs =
      Number.isFinite(startedMs) && Number.isFinite(endedMs)
        ? Math.max(0, endedMs - startedMs)
        : 0;

    rows.push({
      workerId,
      ticket: signal?.ticket ?? null,
      prNumber: signal?.pr?.number ?? null,
      prState:
        signal?.pr?.ciStatus === "merged"
          ? "merged"
          : (signal?.pr?.ciStatus ?? null),
      finalStatus: signal?.status ?? null,
      durationMs,
      costUsd: 0, // sourced from session_metrics in a later iteration
      hasSummary,
      hasRollupFragment,
    });
  }

  return rows;
}

function collectTickets(state: OrchestratorState | null): string[] {
  const out = new Set<string>();
  if (state?.waves) {
    for (const w of state.waves) {
      for (const t of w.tickets ?? []) out.add(t);
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// SQLite writes

function writeSqlite(
  dbPath: string,
  metadata: {
    orchId: string;
    name: string;
    startedAt: string;
    completedAt: string | null;
    status: string;
    wavesCount: number;
    workersCount: number;
    prsMergedCount: number;
    ticketsTouched: string[];
    archivedAt: string;
  },
  archivePath: string,
  hasRollup: boolean,
  workers: WorkerRow[],
  artifacts: {
    kind: ArtifactKind;
    workerId: string | null;
    path: string;
    bytes: number;
    sha256: string;
  }[],
): void {
  if (!existsSync(dbPath)) {
    throw new Error(
      `SQLite DB not found at ${dbPath}. Run catalyst-db migrations first.`,
    );
  }

  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("BEGIN");
    try {
      db.run(
        `INSERT INTO orchestrators (
           orch_id, name, started_at, completed_at, status,
           waves_count, workers_count, prs_merged_count,
           tickets_touched, archive_path, has_rollup, archived_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(orch_id) DO UPDATE SET
           name = excluded.name,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           status = excluded.status,
           waves_count = excluded.waves_count,
           workers_count = excluded.workers_count,
           prs_merged_count = excluded.prs_merged_count,
           tickets_touched = excluded.tickets_touched,
           archive_path = excluded.archive_path,
           has_rollup = excluded.has_rollup,
           archived_at = excluded.archived_at`,
        [
          metadata.orchId,
          metadata.name,
          metadata.startedAt,
          metadata.completedAt,
          metadata.status,
          metadata.wavesCount,
          metadata.workersCount,
          metadata.prsMergedCount,
          JSON.stringify(metadata.ticketsTouched),
          archivePath,
          hasRollup ? 1 : 0,
          metadata.archivedAt,
        ],
      );

      const workerStmt = db.prepare(
        `INSERT INTO archived_workers (
           worker_id, orch_id, ticket, pr_number, pr_state, final_status,
           duration_ms, cost_usd, has_summary, has_rollup_fragment, archived_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(orch_id, worker_id) DO UPDATE SET
           ticket = excluded.ticket,
           pr_number = excluded.pr_number,
           pr_state = excluded.pr_state,
           final_status = excluded.final_status,
           duration_ms = excluded.duration_ms,
           cost_usd = excluded.cost_usd,
           has_summary = excluded.has_summary,
           has_rollup_fragment = excluded.has_rollup_fragment,
           archived_at = excluded.archived_at`,
      );

      for (const w of workers) {
        workerStmt.run(
          w.workerId,
          metadata.orchId,
          w.ticket,
          w.prNumber,
          w.prState,
          w.finalStatus,
          w.durationMs,
          w.costUsd,
          w.hasSummary ? 1 : 0,
          w.hasRollupFragment ? 1 : 0,
          metadata.archivedAt,
        );
      }

      const artifactStmt = db.prepare(
        `INSERT INTO archived_artifacts (
           orch_id, worker_id, kind, path, bytes, sha256, created_at
         ) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(orch_id, path) DO UPDATE SET
           worker_id = excluded.worker_id,
           kind = excluded.kind,
           bytes = excluded.bytes,
           sha256 = excluded.sha256,
           created_at = excluded.created_at`,
      );

      for (const a of artifacts) {
        artifactStmt.run(
          metadata.orchId,
          a.workerId,
          a.kind,
          a.path,
          a.bytes,
          a.sha256,
          metadata.archivedAt,
        );
      }

      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Sync / prune / list / show

export interface SyncReport {
  missingFiles: { orchId: string; path: string }[];
  orphanDirs: string[];
  rowsChecked: number;
}

export function syncArchive(config: ArchiveConfig): SyncReport {
  const report: SyncReport = {
    missingFiles: [],
    orphanDirs: [],
    rowsChecked: 0,
  };
  if (!existsSync(config.dbPath)) return report;

  const db = new Database(config.dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT a.orch_id, a.path, o.archive_path
         FROM archived_artifacts a
         JOIN orchestrators o ON o.orch_id = a.orch_id`,
      )
      .all() as {
      orch_id: string;
      path: string;
      archive_path: string;
    }[];

    report.rowsChecked = rows.length;
    for (const r of rows) {
      const abs = join(r.archive_path, r.path);
      if (!existsSync(abs)) {
        report.missingFiles.push({ orchId: r.orch_id, path: abs });
      }
    }

    const orchIds = new Set(
      (
        db.prepare(`SELECT orch_id FROM orchestrators`).all() as {
          orch_id: string;
        }[]
      ).map((r) => r.orch_id),
    );

    if (existsSync(config.root)) {
      for (const entry of readdirSync(config.root)) {
        if (!orchIds.has(entry)) {
          const fullPath = join(config.root, entry);
          if (statSync(fullPath).isDirectory()) {
            report.orphanDirs.push(fullPath);
          }
        }
      }
    }
  } finally {
    db.close();
  }

  return report;
}

export interface PruneReport {
  removed: string[];
  keptCount: number;
}

export function prune(
  config: ArchiveConfig,
  olderThanDays: number,
): PruneReport {
  const report: PruneReport = { removed: [], keptCount: 0 };
  if (!existsSync(config.dbPath)) return report;

  const thresholdMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  const db = new Database(config.dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const rows = db
      .prepare(`SELECT orch_id, archive_path, archived_at FROM orchestrators`)
      .all() as {
      orch_id: string;
      archive_path: string;
      archived_at: string;
    }[];

    for (const r of rows) {
      const archivedMs = Date.parse(r.archived_at);
      if (!Number.isFinite(archivedMs) || archivedMs >= thresholdMs) {
        report.keptCount++;
        continue;
      }
      try {
        if (existsSync(r.archive_path)) {
          rmSync(r.archive_path, { recursive: true, force: true });
        }
        db.run(`DELETE FROM orchestrators WHERE orch_id = ?`, [r.orch_id]);
        report.removed.push(r.orch_id);
      } catch (err) {
        console.error(
          `[prune] failed to remove ${r.orch_id}: ${(err as Error).message}`,
        );
      }
    }
  } finally {
    db.close();
  }

  return report;
}

export interface ArchivedListEntry {
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
}

export function listArchived(config: ArchiveConfig): ArchivedListEntry[] {
  if (!existsSync(config.dbPath)) return [];
  const db = new Database(config.dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT orch_id, name, started_at, completed_at, status,
                waves_count, workers_count, prs_merged_count,
                tickets_touched, archive_path, has_rollup
         FROM orchestrators
         ORDER BY started_at DESC`,
      )
      .all() as {
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
    }[];

    return rows.map((r) => ({
      orchId: r.orch_id,
      name: r.name,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      status: r.status,
      wavesCount: r.waves_count,
      workersCount: r.workers_count,
      prsMergedCount: r.prs_merged_count,
      ticketsTouched: r.tickets_touched
        ? (JSON.parse(r.tickets_touched) as string[])
        : [],
      archivePath: r.archive_path,
      hasRollup: r.has_rollup === 1,
    }));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point

function usage(): never {
  console.error(
    `Usage: catalyst-archive <command> [options]

Commands:
  sweep <orch-id>              Archive artifacts for a completed orchestrator
  sync                         Reconcile filesystem ↔ SQLite mismatches
  prune --older-than <days>    Remove archives older than N days
  list [--json]                List archived orchestrators
  show <orch-id> [--json]      Show one archived orchestrator

Options:
  --dry-run                    Dry run (sweep only)
  --json                       JSON output (list, show)`,
  );
  process.exit(1);
}

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 2;
      } else {
        flags[name] = true;
        i += 1;
      }
    } else {
      positional.push(a);
      i += 1;
    }
  }
  return { command, positional, flags };
}

function cmdSweep(args: {
  positional: string[];
  flags: Record<string, string | boolean>;
}): void {
  const orchId = args.positional[0];
  if (!orchId) {
    console.error("sweep requires an orch-id");
    process.exit(1);
  }
  const dryRun = Boolean(args.flags["dry-run"]);
  const config = resolveConfig();
  const summary = sweep(orchId, config, { dryRun });

  const output = {
    ...summary,
    dryRun,
  };
  console.info(JSON.stringify(output, null, 2));
  if (summary.skippedArtifacts.length > 0) {
    for (const s of summary.skippedArtifacts) {
      console.error(`SKIP: ${s}`);
    }
  }
}

function cmdSync(): void {
  const config = resolveConfig();
  const report = syncArchive(config);
  console.info(JSON.stringify(report, null, 2));
  if (report.missingFiles.length > 0 || report.orphanDirs.length > 0) {
    process.exitCode = 2;
  }
}

function cmdPrune(args: { flags: Record<string, string | boolean> }): void {
  const raw = args.flags["older-than"];
  if (typeof raw !== "string") {
    console.error("prune requires --older-than <days>");
    process.exit(1);
  }
  const days = Number.parseInt(raw, 10);
  if (!Number.isFinite(days) || days < 0) {
    console.error("--older-than must be a non-negative integer");
    process.exit(1);
  }
  const config = resolveConfig();
  const report = prune(config, days);
  console.info(JSON.stringify(report, null, 2));
}

function cmdList(args: { flags: Record<string, string | boolean> }): void {
  const config = resolveConfig();
  const entries = listArchived(config);
  if (args.flags.json) {
    console.info(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.info("(no archived orchestrators)");
    return;
  }
  for (const e of entries) {
    console.info(
      `${e.startedAt}  ${e.orchId.padEnd(20)}  waves=${e.wavesCount}  workers=${e.workersCount}  prs=${e.prsMergedCount}  ${e.hasRollup ? "rollup" : ""}`,
    );
  }
}

function cmdShow(args: {
  positional: string[];
  flags: Record<string, string | boolean>;
}): void {
  const orchId = args.positional[0];
  if (!orchId) {
    console.error("show requires an orch-id");
    process.exit(1);
  }
  const config = resolveConfig();
  const entries = listArchived(config);
  const match = entries.find((e) => e.orchId === orchId);
  if (!match) {
    console.error(`No archive found for ${orchId}`);
    process.exit(1);
  }
  if (args.flags.json) {
    console.info(JSON.stringify(match, null, 2));
    return;
  }
  console.info(JSON.stringify(match, null, 2));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const args = parseArgs(argv);
  switch (args.command) {
    case "sweep":
      cmdSweep(args);
      break;
    case "sync":
      cmdSync();
      break;
    case "prune":
      cmdPrune(args);
      break;
    case "list":
      cmdList(args);
      break;
    case "show":
      cmdShow(args);
      break;
    default:
      usage();
  }
}

// Exports for tests (prevent unused-lint on lower-level helpers)
export const __test = {
  sha256Hex,
  atomicWrite,
  atomicCopy,
  fileContainsOrchId,
  expandHome,
  unlinkSync, // re-export so tests can simulate deletions
  relative,
};
