// runs-reader.ts — build a flat RunRow[] hierarchy for the HUD Runs tab (CTL-426).
// Each orchestrator contributes one OrchRunRow followed by WorkerRunRow entries for
// its recent workers. Orchs are sorted newest-first; workers within each orch are
// sorted active-first (by phase desc), then terminal (by updatedAt desc).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { runsDirPath, scanOrchestratorWorkers } from "./worker-signals-reader.ts";
import type { WorkerPR } from "./worker-signals-reader.ts";

export interface OrchRunRow {
  kind: "orch";
  orchId: string;
  orchestrator: string | null;
  currentWave: number | null;
  totalWaves: number | null;
  workersCount: { active: number; total: number };
  startedAt: string | null;
  raw: unknown;
}

export interface WorkerRunRow {
  kind: "worker";
  orchId: string;
  ticket: string;
  label: string | null;
  status: string;
  phase: number | null;
  pr: WorkerPR | null;
  updatedAt: string | null;
  raw: unknown;
}

export type RunRow = OrchRunRow | WorkerRunRow;

const TERMINAL_STATUSES = new Set(["done", "failed", "stalled", "deploy-failed"]);
const RECENT_WINDOW_MS = 24 * 3_600_000;

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readRunRows(runsDir?: string, now: number = Date.now()): RunRow[] {
  const dir = runsDir ?? runsDirPath();
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const orchInfos: Array<{ name: string; startedAt: string | null; raw: Record<string, unknown> }> = [];

  for (const name of entries) {
    const orchDir = resolve(dir, name);
    try {
      if (!statSync(orchDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const stateFile = resolve(orchDir, "state.json");
    let raw: Record<string, unknown> = {};
    if (existsSync(stateFile)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
        if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
      } catch {
        // leave raw empty
      }
    }
    orchInfos.push({ name, startedAt: asString(raw.startedAt), raw });
  }

  orchInfos.sort((a, b) => {
    const ta = a.startedAt ? Date.parse(a.startedAt) : 0;
    const tb = b.startedAt ? Date.parse(b.startedAt) : 0;
    return tb - ta;
  });

  const rows: RunRow[] = [];

  for (const { name, raw } of orchInfos) {
    const orchDir = resolve(dir, name);
    const workers = scanOrchestratorWorkers(orchDir).filter((w) => {
      if (!TERMINAL_STATUSES.has(w.status)) return true;
      const ts = w.updatedAt ?? w.completedAt;
      if (!ts) return false;
      const ms = Date.parse(ts);
      return Number.isFinite(ms) && now - ms <= RECENT_WINDOW_MS;
    });

    if (workers.length === 0) continue;

    const active = workers.filter((w) => !TERMINAL_STATUSES.has(w.status)).length;

    rows.push({
      kind: "orch",
      orchId: name,
      orchestrator: asString(raw.orchestrator) ?? name,
      currentWave: asNumber(raw.currentWave),
      totalWaves: asNumber(raw.totalWaves),
      workersCount: { active, total: workers.length },
      startedAt: asString(raw.startedAt),
      raw,
    });

    const sorted = [...workers].sort((a, b) => {
      const aT = TERMINAL_STATUSES.has(a.status);
      const bT = TERMINAL_STATUSES.has(b.status);
      if (aT !== bT) return aT ? 1 : -1;
      if (!aT) return (b.phase ?? 0) - (a.phase ?? 0);
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });

    for (const w of sorted) {
      rows.push({
        kind: "worker",
        orchId: name,
        ticket: w.ticket,
        label: w.label,
        status: w.status,
        phase: w.phase,
        pr: w.pr,
        updatedAt: w.updatedAt,
        raw: w.raw,
      });
    }
  }

  return rows;
}
