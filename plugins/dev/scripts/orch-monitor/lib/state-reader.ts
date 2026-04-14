import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, basename, resolve as resolvePath } from "path";
import { execSync } from "child_process";
import { checkProcessAlive } from "./liveness";
import { parseOutputJson, analyticsPath, type WorkerAnalytics } from "./output-parser";

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
}

export interface OrchestratorAnalytics {
  id: string;
  workers: Record<string, WorkerAnalytics | null>;
}

export interface AnalyticsSnapshot {
  generatedAt: string;
  orchestrators: OrchestratorAnalytics[];
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
  startedAt: string;
  currentWave: number;
  totalWaves: number;
  waves: Wave[];
  workers: Record<string, WorkerState>;
  dashboard: string | null;
  briefings: Record<number, string>;
  attention: unknown[];
}

export interface MonitorSnapshot {
  timestamp: string;
  orchestrators: OrchestratorState[];
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

/**
 * Scan for orch-* directories under baseDir.
 *
 * Supports both layouts used by the orchestrate skill:
 *   (1) baseDir/orch-*                  (flat)
 *   (2) baseDir/<projectKey>/orch-*    (nested by project — current default)
 */
export function scanOrchestrators(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch (err) {
    console.error(`[state-reader] readdir failed for ${baseDir}:`, err);
    return [];
  }

  const matches: string[] = [];
  for (const name of entries) {
    const full = join(baseDir, name);
    if (name.startsWith("orch-")) {
      if (isOrchestratorDir(full)) matches.push(full);
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
      if (!child.startsWith("orch-")) continue;
      const childPath = join(full, child);
      if (isOrchestratorDir(childPath)) matches.push(childPath);
    }
  }
  return matches;
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

export function readOrchestratorState(orchDir: string): OrchestratorState {
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
        workers[key] = toWorkerState(signal);
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

export function buildAnalyticsSnapshot(baseDir: string): AnalyticsSnapshot {
  const dirs = scanOrchestrators(baseDir);
  const orchestrators: OrchestratorAnalytics[] = [];
  for (const orchDir of dirs) {
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

export function buildSnapshot(baseDir: string): MonitorSnapshot {
  const dirs = scanOrchestrators(baseDir);
  const orchestrators: OrchestratorState[] = [];
  for (const d of dirs) {
    try {
      orchestrators.push(readOrchestratorState(d));
    } catch (err) {
      console.error(`[state-reader] readOrchestratorState failed for ${d}:`, err);
    }
  }
  return {
    timestamp: new Date().toISOString(),
    orchestrators,
  };
}

function assertWorktreeInside(baseDir: string, worktreePath: string): void {
  const absBase = resolvePath(baseDir);
  const absPath = resolvePath(worktreePath);
  if (!absPath.startsWith(absBase + "/") && absPath !== absBase) {
    throw new Error(
      `worktreePath ${worktreePath} escapes baseDir ${baseDir}`,
    );
  }
}

export function getLastCommit(
  worktreePath: string,
  options: { baseDir?: string } = {},
): string | null {
  if (options.baseDir) assertWorktreeInside(options.baseDir, worktreePath);
  try {
    return execSync("git log --oneline -1", {
      cwd: worktreePath,
      timeout: 3000,
    })
      .toString()
      .trim();
  } catch (err) {
    console.error(`[state-reader] git log failed for ${worktreePath}:`, err);
    return null;
  }
}

export function getUncommittedChanges(
  worktreePath: string,
  options: { baseDir?: string } = {},
): number {
  if (options.baseDir) assertWorktreeInside(options.baseDir, worktreePath);
  try {
    const out = execSync("git status --short", {
      cwd: worktreePath,
      timeout: 3000,
    });
    return out.toString().trim().split("\n").filter(Boolean).length;
  } catch (err) {
    console.error(`[state-reader] git status failed for ${worktreePath}:`, err);
    return 0;
  }
}
