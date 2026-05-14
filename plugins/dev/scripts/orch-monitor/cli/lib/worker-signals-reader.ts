// worker-signals-reader.ts — scan ~/catalyst/runs/<orchId>/workers/*.json for the
// HUD dashboard (CTL-392). Each worker writes its lifecycle state to a single
// file named `<TICKET>.json`. The dashboard surfaces a filtered view of all
// currently-known workers: in-flight workers always show; terminal-state
// workers stay visible for 24 hours after their last update.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface WorkerPR {
  number: number;
  url: string;
  ciStatus?: string;
  prOpenedAt?: string;
  mergedAt?: string | null;
  mergeCommitSha?: string;
}

export interface WorkerSignal {
  ticket: string;
  orchestrator: string;
  wave: number | null;
  workerName: string;
  label: string | null;
  status: string;
  phase: number | null;
  phaseTimestamps: Record<string, string>;
  lastHeartbeat: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  worktreePath: string | null;
  pr: WorkerPR | null;
  linearState: string | null;
  definitionOfDone: unknown;
  raw: unknown;
}

export const WORKER_RECENT_WINDOW_MS = 24 * 3_600_000;

const TERMINAL_STATUSES = new Set(["done", "failed", "stalled", "deploy-failed"]);

export function runsDirPath(): string {
  const dir = process.env.CATALYST_DIR ?? resolve(homedir(), "catalyst");
  return resolve(dir, "runs");
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parsePr(v: unknown): WorkerPR | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.number !== "number") return null;
  const out: WorkerPR = {
    number: o.number,
    url: typeof o.url === "string" ? o.url : "",
  };
  if (typeof o.ciStatus === "string") out.ciStatus = o.ciStatus;
  if (typeof o.prOpenedAt === "string") out.prOpenedAt = o.prOpenedAt;
  if (typeof o.mergedAt === "string") {
    out.mergedAt = o.mergedAt;
  } else if (o.mergedAt === null) {
    out.mergedAt = null;
  }
  if (typeof o.mergeCommitSha === "string") out.mergeCommitSha = o.mergeCommitSha;
  return out;
}

function parsePhaseTimestamps(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function parseSignal(raw: unknown): WorkerSignal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ticket = asString(r.ticket);
  const orchestrator = asString(r.orchestrator);
  const workerName = asString(r.workerName);
  const status = asString(r.status);
  if (!ticket || !orchestrator || !workerName || !status) return null;
  return {
    ticket,
    orchestrator,
    wave: asNumber(r.wave),
    workerName,
    label: asString(r.label),
    status,
    phase: asNumber(r.phase),
    phaseTimestamps: parsePhaseTimestamps(r.phaseTimestamps),
    lastHeartbeat: asString(r.lastHeartbeat),
    startedAt: asString(r.startedAt),
    updatedAt: asString(r.updatedAt),
    completedAt: asString(r.completedAt),
    worktreePath: asString(r.worktreePath),
    pr: parsePr(r.pr),
    linearState: asString(r.linearState),
    definitionOfDone: r.definitionOfDone ?? null,
    raw,
  };
}

function isRecentEnough(sig: WorkerSignal, now: number): boolean {
  if (!TERMINAL_STATUSES.has(sig.status)) return true;
  const ts = sig.updatedAt ?? sig.completedAt;
  if (!ts) return false;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return false;
  return now - ms <= WORKER_RECENT_WINDOW_MS;
}

function scanOrchestratorWorkersDir(workersDir: string): WorkerSignal[] {
  if (!existsSync(workersDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(workersDir);
  } catch {
    return [];
  }
  const out: WorkerSignal[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.endsWith("-rollup.json")) continue;
    const full = resolve(workersDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    const sig = parseSignal(parsed);
    if (sig) out.push(sig);
  }
  return out;
}

export function scanOrchestratorWorkers(orchDir: string): WorkerSignal[] {
  return scanOrchestratorWorkersDir(resolve(orchDir, "workers"));
}

export function readWorkerSignals(runsDir?: string, now: number = Date.now()): WorkerSignal[] {
  const dir = runsDir ?? runsDirPath();
  if (!existsSync(dir)) return [];
  let orchDirs: string[];
  try {
    orchDirs = readdirSync(dir);
  } catch {
    return [];
  }
  const seen = new Map<string, WorkerSignal>();
  for (const orchName of orchDirs) {
    const orchDir = resolve(dir, orchName);
    try {
      if (!statSync(orchDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const sig of scanOrchestratorWorkers(orchDir)) {
      if (!isRecentEnough(sig, now)) continue;
      seen.set(sig.workerName, sig);
    }
  }
  return Array.from(seen.values());
}
