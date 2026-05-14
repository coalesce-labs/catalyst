// orch-state-reader.ts — scan ~/catalyst/runs/<orchId>/state.json for the HUD
// dashboard (CTL-392). Computes active-worker counts by reading the same
// per-worker signal files used by worker-signals-reader.ts.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { runsDirPath, scanOrchestratorWorkers } from "./worker-signals-reader.ts";

const TERMINAL_STATUSES = new Set(["done", "failed", "stalled", "deploy-failed"]);

export interface OrchState {
  id: string;
  orchestrator: string | null;
  currentWave: number | null;
  totalWaves: number | null;
  queueLength: number;
  maxParallel: number | null;
  baseBranch: string | null;
  startedAt: string | null;
  workersCount: { active: number; total: number };
  raw: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseState(id: string, raw: unknown, orchDir: string): OrchState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const queue = Array.isArray(r.queue) ? r.queue : [];
  const workers = scanOrchestratorWorkers(orchDir);
  const active = workers.filter((w) => !TERMINAL_STATUSES.has(w.status)).length;
  return {
    id,
    orchestrator: asString(r.orchestrator),
    currentWave: asNumber(r.currentWave),
    totalWaves: asNumber(r.totalWaves),
    queueLength: queue.length,
    maxParallel: asNumber(r.maxParallel),
    baseBranch: asString(r.baseBranch),
    startedAt: asString(r.startedAt),
    workersCount: { active, total: workers.length },
    raw,
  };
}

export function readOrchStates(runsDir?: string): OrchState[] {
  const dir = runsDir ?? runsDirPath();
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: OrchState[] = [];
  for (const name of entries) {
    const orchDir = resolve(dir, name);
    try {
      if (!statSync(orchDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const stateFile = resolve(orchDir, "state.json");
    if (!existsSync(stateFile)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
      continue;
    }
    const st = parseState(name, parsed, orchDir);
    if (st) out.push(st);
  }
  return out;
}
