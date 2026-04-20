import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import { checkProcessAlive } from "./liveness";
import { parseOutputJson, analyticsPath, type WorkerAnalytics } from "./output-parser";
import { readWorkerActivity, type WorkerActivity } from "./stream-reader";
import {
  readSessionStore,
  sessionStoreAvailable,
  type SessionState,
  type SessionQuery,
} from "./session-store";

export type { SessionState, SessionQuery } from "./session-store";

export interface DefinitionOfDone {
  testsWrittenFirst?: boolean;
  unitTests?: { exists?: boolean; count?: number };
  apiTests?: { exists?: boolean; count?: number; reason?: string };
  functionalTests?: { exists?: boolean; count?: number; reason?: string };
  typeCheck?: { passed?: boolean };
  securityReview?: { passed?: boolean };
  codeReview?: { passed?: boolean; findings?: number };
  rewardHackingScan?: { passed?: boolean; violations?: number };
}

export interface WorkerCost {
  costUSD: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface WorkerState {
  ticket: string;
  label: string | null;
  status: string;
  phase: number;
  wave: number | null;
  pid: number | null;
  alive: boolean;
  pr: {
    number: number;
    url: string;
    state?: string;
    title?: string;
    ciStatus?: string;
    prOpenedAt?: string;
    autoMergeArmedAt?: string;
    mergedAt?: string;
    mergeStateStatus?: string;
    isDraft?: boolean;
  } | null;
  startedAt: string;
  updatedAt: string;
  timeSinceUpdate: number;
  lastHeartbeat: string | null;
  definitionOfDone: DefinitionOfDone;
  phaseTimestamps?: Record<string, string>;
  completedAt?: string | null;
  cost?: WorkerCost | null;
  parseError?: string;
  prState?: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
  prMergedAt?: string | null;
  fixupCommit?: string;
  followUpTo?: string;
  previews?: Array<{
    url: string;
    provider: string;
    status: string;
    source: string;
  }>;
  activity?: WorkerActivity | null;
}

export type { WorkerActivity } from "./stream-reader";

interface OrchestratorAnalytics {
  id: string;
  workers: Record<string, WorkerAnalytics | null>;
}

interface AnalyticsSnapshot {
  generatedAt: string;
  orchestrators: OrchestratorAnalytics[];
}

interface SessionDetail {
  orchId: string;
  orchStartedAt: string;
  worker: WorkerState;
  analytics: WorkerAnalytics | null;
}

export interface Wave {
  wave: number;
  status: string;
  tickets: string[];
  completedAt?: string;
  dependsOn?: number[];
}

export interface OrchestratorState {
  id: string;
  path: string;
  workspace: string;
  startedAt: string;
  currentWave: number;
  totalWaves: number;
  waves: Wave[];
  workers: Record<string, WorkerState>;
  dashboard: string | null;
  briefings: Record<number, string>;
  attention: unknown[];
}

interface WorkspaceStats {
  sessionCount: number;
  activeCount: number;
  totalCost: number;
  lastActivity: string;
}

interface WorkspaceGroup {
  workspace: string;
  orchestrators: OrchestratorState[];
  stats: WorkspaceStats;
}

export interface MonitorSnapshot {
  timestamp: string;
  orchestrators: OrchestratorState[];
  sessions: SessionState[];
  sessionStoreAvailable: boolean;
}

export interface BuildSnapshotOptions {
  dbPath?: string | null;
  sessionQuery?: SessionQuery;
  /**
   * When set, discovery also scans this runs directory in addition to baseDir
   * (the legacy worktree dir). Orchestrators found under runsDir take
   * precedence for duplicate ids (see `scanAllOrchestrators`).
   */
  runsDir?: string | null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

function asNumber(x: unknown, fallback = 0): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function isOrchestratorDir(candidate: string): boolean {
  try {
    if (!statSync(candidate).isDirectory()) return false;
  } catch {
    return false;
  }
  const workersDir = join(candidate, "workers");
  try {
    return existsSync(workersDir) && statSync(workersDir).isDirectory();
  } catch {
    return false;
  }
}

interface ScannedOrchestrator {
  path: string;
  workspace: string;
  /**
   * Where the orchestrator was discovered:
   *   - "runs": ~/catalyst/runs/<id>/  (CTL-59 layout — state survives worktree cleanup)
   *   - "wt":   ~/catalyst/wt/.../     (legacy — state lives inside the git worktree)
   */
  source?: "runs" | "wt";
}

/**
 * Scan for orch-* directories under baseDir.
 *
 * Supports both layouts used by the orchestrate skill:
 *   (1) baseDir/orch-*                  (flat)        → workspace = "default"
 *   (2) baseDir/<projectKey>/orch-*    (nested)       → workspace = <projectKey>
 */
export function scanOrchestrators(baseDir: string): ScannedOrchestrator[] {
  if (!existsSync(baseDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch (err) {
    console.error(`[state-reader] readdir failed for ${baseDir}:`, err);
    return [];
  }

  const matches: ScannedOrchestrator[] = [];
  for (const name of entries) {
    const full = join(baseDir, name);
    if (isOrchestratorDir(full)) {
      matches.push({ path: full, workspace: "default" });
      continue;
    }
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    let children: string[];
    try {
      children = readdirSync(full);
    } catch {
      continue;
    }
    for (const child of children) {
      const childPath = join(full, child);
      if (isOrchestratorDir(childPath)) matches.push({ path: childPath, workspace: name });
    }
  }
  return matches;
}

export interface ScanAllOptions {
  /** Per-orchestrator state root: ~/catalyst/runs/ */
  runsDir: string;
  /** Legacy worktree root: ~/catalyst/wt/ */
  wtDir: string;
}

/**
 * Discover orchestrators from both the CTL-59 runs directory and the legacy
 * worktree layout. Runs-based entries take precedence when an orch-id appears
 * in both locations (migration is not destructive — old worktree state stays
 * readable until the orchestrator is archived).
 */
export function scanAllOrchestrators(
  { runsDir, wtDir }: ScanAllOptions,
): ScannedOrchestrator[] {
  const runsScan = scanOrchestrators(runsDir).map((e) => ({
    ...e,
    source: "runs" as const,
  }));
  const wtScan = scanOrchestrators(wtDir).map((e) => ({
    ...e,
    source: "wt" as const,
  }));

  const seen = new Set(runsScan.map((e) => basename(e.path)));
  const result: ScannedOrchestrator[] = [...runsScan];
  for (const entry of wtScan) {
    if (seen.has(basename(entry.path))) continue;
    result.push(entry);
    seen.add(basename(entry.path));
  }
  return result;
}

interface ReadResult<T> {
  value: T | null;
  error?: NodeJS.ErrnoException;
}

function readJson(path: string): ReadResult<unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return { value: null };
    console.error(`[state-reader] read failed for ${path}:`, errno.message);
    return { value: null, error: errno };
  }
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    console.error(`[state-reader] parse failed for ${path}:`, errno.message);
    return { value: null, error: errno };
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return null;
    console.error(`[state-reader] read failed for ${path}:`, errno.message);
    return null;
  }
}

function toWorkerState(signal: Record<string, unknown>): WorkerState {
  const pidRaw = signal.pid;
  const pid =
    typeof pidRaw === "number" && Number.isFinite(pidRaw) ? pidRaw : null;

  const updatedAt = asString(signal.updatedAt);
  let timeSinceUpdate = 0;
  if (updatedAt) {
    const parsed = Date.parse(updatedAt);
    if (!Number.isNaN(parsed)) {
      timeSinceUpdate = Math.max(0, (Date.now() - parsed) / 1000);
    }
  }

  let pr: WorkerState["pr"] = null;
  if (isRecord(signal.pr) && typeof signal.pr.number === "number") {
    pr = {
      number: signal.pr.number,
      url: asString(signal.pr.url),
    };
    if (typeof signal.pr.state === "string") pr.state = signal.pr.state;
    if (typeof signal.pr.title === "string") pr.title = signal.pr.title;
    if (typeof signal.pr.ciStatus === "string") pr.ciStatus = signal.pr.ciStatus;
    if (typeof signal.pr.prOpenedAt === "string") pr.prOpenedAt = signal.pr.prOpenedAt;
    if (typeof signal.pr.autoMergeArmedAt === "string") pr.autoMergeArmedAt = signal.pr.autoMergeArmedAt;
    if (typeof signal.pr.mergedAt === "string") pr.mergedAt = signal.pr.mergedAt;
    if (typeof signal.pr.mergeStateStatus === "string") pr.mergeStateStatus = signal.pr.mergeStateStatus;
    if (typeof signal.pr.isDraft === "boolean") pr.isDraft = signal.pr.isDraft;
  }

  const definitionOfDone = isRecord(signal.definitionOfDone)
    ? (signal.definitionOfDone as DefinitionOfDone)
    : {};

  let phaseTimestamps: Record<string, string> | undefined;
  if (isRecord(signal.phaseTimestamps)) {
    phaseTimestamps = {};
    for (const [k, v] of Object.entries(signal.phaseTimestamps)) {
      if (typeof v === "string") phaseTimestamps[k] = v;
    }
  }

  const completedAt = asString(signal.completedAt) || null;

  let cost: WorkerCost | null = null;
  if (isRecord(signal.cost)) {
    const c = signal.cost;
    cost = {
      costUSD: asNumber(c.costUSD),
      inputTokens: asNumber(c.inputTokens),
      outputTokens: asNumber(c.outputTokens),
      cacheReadTokens: asNumber(c.cacheReadTokens),
    };
  }

  const labelRaw = signal.label;
  const label = typeof labelRaw === "string" && labelRaw.length > 0 ? labelRaw : null;

  const fixupCommit =
    typeof signal.fixupCommit === "string" && signal.fixupCommit.length > 0
      ? signal.fixupCommit
      : undefined;
  const followUpTo =
    typeof signal.followUpTo === "string" && signal.followUpTo.length > 0
      ? signal.followUpTo
      : undefined;

  return {
    ticket: asString(signal.ticket),
    label,
    status: asString(signal.status, "unknown"),
    phase: asNumber(signal.phase),
    wave: null,
    pid,
    alive: checkProcessAlive(pid),
    pr,
    startedAt: asString(signal.startedAt),
    updatedAt,
    timeSinceUpdate,
    lastHeartbeat: asString(signal.lastHeartbeat) || null,
    definitionOfDone,
    phaseTimestamps,
    completedAt,
    cost,
    fixupCommit,
    followUpTo,
  };
}

function corruptWorkerPlaceholder(filename: string, error: string): WorkerState {
  return {
    ticket: filename.replace(/\.json$/, ""),
    label: null,
    status: "signal_corrupt",
    phase: 0,
    wave: null,
    pid: null,
    alive: false,
    pr: null,
    startedAt: "",
    updatedAt: "",
    timeSinceUpdate: 0,
    lastHeartbeat: null,
    definitionOfDone: {},
    parseError: error,
  };
}

export function readOrchestratorState(orchDir: string, workspace = "default"): OrchestratorState {
  const id = basename(orchDir);
  const statePath = join(orchDir, "state.json");
  const stateRead = readJson(statePath);
  const state = isRecord(stateRead.value) ? stateRead.value : {};

  const workers: Record<string, WorkerState> = {};
  const workersDir = join(orchDir, "workers");
  if (existsSync(workersDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(workersDir);
    } catch (err) {
      console.error(`[state-reader] readdir failed for ${workersDir}:`, err);
    }
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      if (file.endsWith("-output.json")) continue;
      const fullPath = join(workersDir, file);
      const result = readJson(fullPath);
      if (result.error || !isRecord(result.value)) {
        if (result.error) {
          const key = file.replace(/\.json$/, "");
          workers[key] = corruptWorkerPlaceholder(file, result.error.message);
        }
        continue;
      }
      const signal = result.value;
      const key = asString(signal.ticket) || file.replace(/\.json$/, "");
      try {
        const w = toWorkerState(signal);
        w.activity = readWorkerActivity(orchDir, key, w.pid);
        workers[key] = w;
      } catch (err) {
        console.error(`[state-reader] toWorkerState failed for ${fullPath}:`, err);
        workers[key] = corruptWorkerPlaceholder(
          file,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  const dashboard = readText(join(orchDir, "DASHBOARD.md"));
  const rawWaves = (state as { waves?: unknown }).waves;
  const waves: Wave[] = Array.isArray(rawWaves)
    ? (rawWaves.filter(isRecord) as unknown as Wave[])
    : [];

  for (const wave of waves) {
    const waveNum = asNumber(wave.wave);
    const tickets = Array.isArray(wave.tickets) ? wave.tickets : [];
    for (const ticket of tickets) {
      if (typeof ticket !== "string") continue;
      const w = workers[ticket];
      if (w) w.wave = waveNum;
    }
  }

  const briefings: Record<number, string> = {};
  try {
    for (const f of readdirSync(orchDir)) {
      const m = /^wave-(\d+)-briefing\.md$/.exec(f);
      if (!m) continue;
      const n = Number(m[1]);
      const body = readText(join(orchDir, f));
      if (body !== null) briefings[n] = body;
    }
  } catch {
    /* no briefings */
  }

  const rawAttention = (state as { attention?: unknown }).attention;
  const attention: unknown[] = Array.isArray(rawAttention) ? rawAttention : [];

  return {
    id: asString((state as { id?: unknown }).id, id),
    path: orchDir,
    workspace,
    startedAt: asString((state as { startedAt?: unknown }).startedAt),
    currentWave: asNumber((state as { currentWave?: unknown }).currentWave),
    totalWaves: asNumber(
      (state as { totalWaves?: unknown }).totalWaves,
      waves.length,
    ),
    waves,
    workers,
    dashboard,
    briefings,
    attention,
  };
}

export function buildAnalyticsSnapshot(
  baseDir: string,
  options: { runsDir?: string | null } = {},
): AnalyticsSnapshot {
  const scanned = options.runsDir
    ? scanAllOrchestrators({ runsDir: options.runsDir, wtDir: baseDir })
    : scanOrchestrators(baseDir);
  const orchestrators: OrchestratorAnalytics[] = [];
  for (const { path: orchDir } of scanned) {
    const id = basename(orchDir);
    const workers: Record<string, WorkerAnalytics | null> = {};
    const workersDir = join(orchDir, "workers");
    if (existsSync(workersDir)) {
      let entries: string[] = [];
      try {
        entries = readdirSync(workersDir);
      } catch (err) {
        console.error(`[state-reader] readdir failed for ${workersDir}:`, err);
      }
      for (const file of entries) {
        if (!file.endsWith(".json")) continue;
        if (file.endsWith("-output.json")) continue;
        const ticket = file.replace(/\.json$/, "");
        const analytics = parseOutputJson(analyticsPath(orchDir, ticket));
        if (analytics) analytics.ticket = ticket;
        workers[ticket] = analytics;
      }
    }
    orchestrators.push({ id, workers });
  }
  return {
    generatedAt: new Date().toISOString(),
    orchestrators,
  };
}

export function buildSnapshot(
  baseDir: string,
  options: BuildSnapshotOptions = {},
): MonitorSnapshot {
  const scanned = options.runsDir
    ? scanAllOrchestrators({ runsDir: options.runsDir, wtDir: baseDir })
    : scanOrchestrators(baseDir);
  const orchestrators: OrchestratorState[] = [];
  for (const { path, workspace } of scanned) {
    try {
      orchestrators.push(readOrchestratorState(path, workspace));
    } catch (err) {
      console.error(`[state-reader] readOrchestratorState failed for ${path}:`, err);
    }
  }

  let sessions: SessionState[] = [];
  let storeAvailable = false;
  const dbPath = options.dbPath ?? null;
  if (dbPath) {
    storeAvailable = sessionStoreAvailable(dbPath);
    if (storeAvailable) {
      sessions = readSessionStore(dbPath, options.sessionQuery ?? {}).sessions;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    orchestrators,
    sessions,
    sessionStoreAvailable: storeAvailable,
  };
}

export function buildSessionDetail(
  baseDir: string,
  orchId: string,
  ticket: string,
  options: { runsDir?: string | null } = {},
): SessionDetail | null {
  const scanned = options.runsDir
    ? scanAllOrchestrators({ runsDir: options.runsDir, wtDir: baseDir })
    : scanOrchestrators(baseDir);
  const entry = scanned.find((d) => basename(d.path) === orchId);
  if (!entry) return null;

  const orch = readOrchestratorState(entry.path, entry.workspace);
  const worker = orch.workers[ticket];
  if (!worker) return null;

  const analytics = parseOutputJson(analyticsPath(entry.path, ticket));
  if (analytics) analytics.ticket = ticket;

  return {
    orchId: orch.id,
    orchStartedAt: orch.startedAt,
    worker,
    analytics,
  };
}

const DONE_STATUSES = new Set(["done", "merged", "failed", "stalled", "signal_corrupt"]);

export function groupByWorkspace(snapshot: MonitorSnapshot): WorkspaceGroup[] {
  const map = new Map<string, OrchestratorState[]>();
  for (const orch of snapshot.orchestrators) {
    const ws = orch.workspace;
    const list = map.get(ws);
    if (list) list.push(orch);
    else map.set(ws, [orch]);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [workspace, orchestrators] of map) {
    let sessionCount = 0;
    let activeCount = 0;
    let totalCost = 0;
    let lastActivity = "";

    for (const orch of orchestrators) {
      for (const worker of Object.values(orch.workers)) {
        sessionCount++;
        if (!DONE_STATUSES.has(worker.status)) activeCount++;
        if (worker.cost?.costUSD) totalCost += worker.cost.costUSD;
        if (worker.updatedAt && worker.updatedAt > lastActivity) {
          lastActivity = worker.updatedAt;
        }
      }
    }

    groups.push({
      workspace,
      orchestrators,
      stats: { sessionCount, activeCount, totalCost, lastActivity },
    });
  }

  groups.sort((a, b) => a.workspace.localeCompare(b.workspace));
  return groups;
}

