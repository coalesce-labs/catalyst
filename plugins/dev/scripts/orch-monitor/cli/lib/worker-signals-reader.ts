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
  // Per-phase mode current phase name (e.g. "implement", "monitor-merge"). Null for legacy
  // oneshot-legacy workers that only carry the integer `phase`.
  phaseName: string | null;
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
    phaseName: asString(r.phaseName),
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

// Per-phase signal file overlay — written by phase-agent-dispatch under
// workers/<TICKET>/phase-<name>.json. Only phase-agents mode produces these.
interface PerPhaseOverlay {
  ticket: string;
  orchestrator: string;
  phaseName: string;
  status: string;
  updatedAt: string | null;
}

// Status values that indicate a phase has finished. Superset of what
// phase-agent-dispatch writes ("dispatched", "running") so the selection
// logic stays correct if/when phase agents stamp completion themselves.
const PER_PHASE_TERMINAL = new Set(["done", "failed", "complete", "skipped"]);

function parsePerPhaseFile(raw: unknown): PerPhaseOverlay | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ticket = asString(r.ticket);
  const orchestrator = asString(r.orchestrator);
  const phaseName = asString(r.phase);
  const status = asString(r.status);
  if (!ticket || !orchestrator || !phaseName || !status) return null;
  return { ticket, orchestrator, phaseName, status, updatedAt: asString(r.updatedAt) };
}

function scanPerPhaseDir(perPhaseDir: string): PerPhaseOverlay | null {
  let entries: string[];
  try {
    entries = readdirSync(perPhaseDir);
  } catch {
    return null;
  }
  const overlays: PerPhaseOverlay[] = [];
  for (const name of entries) {
    if (!name.startsWith("phase-") || !name.endsWith(".json")) continue;
    const full = resolve(perPhaseDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    const ov = parsePerPhaseFile(parsed);
    if (ov) overlays.push(ov);
  }
  if (overlays.length === 0) return null;
  // Prefer most-recent non-terminal phase; fall back to most-recent overall.
  const nonTerm = overlays.filter((o) => !PER_PHASE_TERMINAL.has(o.status));
  const pool = nonTerm.length > 0 ? nonTerm : overlays;
  pool.sort((a, b) => {
    const am = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bm = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bm - am;
  });
  return pool[0];
}

function synthesizeFromOverlay(overlay: PerPhaseOverlay): WorkerSignal {
  return {
    ticket: overlay.ticket,
    orchestrator: overlay.orchestrator,
    wave: null,
    workerName: `${overlay.orchestrator}-${overlay.ticket}`,
    label: null,
    status: overlay.status,
    phase: null,
    phaseName: overlay.phaseName,
    phaseTimestamps: {},
    lastHeartbeat: overlay.updatedAt,
    startedAt: null,
    updatedAt: overlay.updatedAt,
    completedAt: null,
    worktreePath: null,
    pr: null,
    linearState: null,
    definitionOfDone: null,
    raw: overlay,
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

  const flatByTicket = new Map<string, WorkerSignal>();
  const overlayByTicket = new Map<string, PerPhaseOverlay>();

  for (const name of entries) {
    const full = resolve(workersDir, name);
    let entryIsDir: boolean;
    try {
      entryIsDir = statSync(full).isDirectory();
    } catch {
      continue;
    }

    if (entryIsDir) {
      const overlay = scanPerPhaseDir(full);
      if (overlay) overlayByTicket.set(overlay.ticket, overlay);
      continue;
    }

    if (!name.endsWith(".json") || name.endsWith("-rollup.json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    const sig = parseSignal(parsed);
    if (sig) flatByTicket.set(sig.ticket, sig);
  }

  // Apply per-phase overlays. In phase-agents mode the flat file's status/phase
  // go stale by design — the per-phase file is the authoritative live state, so
  // we replace `status`/`updatedAt`/`lastHeartbeat` when overlaying.
  for (const [ticket, overlay] of overlayByTicket) {
    const existing = flatByTicket.get(ticket);
    if (existing) {
      existing.phaseName = overlay.phaseName;
      existing.status = overlay.status;
      if (overlay.updatedAt) {
        existing.updatedAt = overlay.updatedAt;
        existing.lastHeartbeat = overlay.updatedAt;
      }
    } else {
      flatByTicket.set(ticket, synthesizeFromOverlay(overlay));
    }
  }

  return Array.from(flatByTicket.values());
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
