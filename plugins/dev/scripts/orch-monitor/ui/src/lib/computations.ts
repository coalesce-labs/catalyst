import type {
  OrchestratorState,
  WorkerState,
  WorkerAnalytics,
  Wave,
} from "./types";

export interface OrchestratorStats {
  /** Effective denominator: workers counted toward completion (excludes abandoned). */
  total: number;
  /** Merged workers (status in {done, merged}). */
  done: number;
  /** Failed workers (status === "failed"). Not abandoned — still in denominator. */
  failed: number;
  /** Abandoned / no-longer-required workers (status in {superseded, canceled}). Excluded from denominator. */
  abandoned: number;
  active: number;
  pct: number;
  totalCost: number;
  wallMs: number;
  totalDurationMs: number;
  parallelism: number;
  minStartMs: number;
  maxEndMs: number;
}

const MERGED_STATUSES = new Set(["done", "merged"]);
const ABANDONED_STATUSES = new Set(["superseded", "canceled"]);

export function isMerged(status: string): boolean {
  return MERGED_STATUSES.has(status);
}

export function isAbandoned(status: string): boolean {
  return ABANDONED_STATUSES.has(status);
}

export function isSettled(status: string): boolean {
  return isMerged(status) || isAbandoned(status) || status === "failed";
}

export function effectiveCost(
  worker: WorkerState,
  analytics: WorkerAnalytics | null | undefined,
): number {
  const live = worker.cost?.costUSD || 0;
  const analytic = analytics?.costUSD || 0;
  return Math.max(live, analytic);
}

export function totalTokens(
  worker: WorkerState,
  analytics: WorkerAnalytics | null | undefined,
): number {
  if (analytics) {
    const sum =
      (analytics.inputTokens || 0) +
      (analytics.outputTokens || 0) +
      (analytics.cacheReadTokens || 0);
    if (sum > 0) return sum;
  }
  if (worker.cost) {
    return (
      (worker.cost.inputTokens || 0) +
      (worker.cost.outputTokens || 0) +
      (worker.cost.cacheReadTokens || 0)
    );
  }
  return 0;
}

export function ticketToWaveMap(o: OrchestratorState): Record<string, number> {
  const map: Record<string, number> = {};
  if (Array.isArray(o.waves)) {
    for (const w of o.waves) {
      if (!Array.isArray(w.tickets)) continue;
      for (const t of w.tickets) map[t] = w.wave;
    }
  }
  return map;
}

export function computeOrchestratorStats(
  orch: OrchestratorState,
  analyticsMap: Record<string, WorkerAnalytics | null>,
): OrchestratorStats {
  const entries = Object.entries(orch.workers);
  let done = 0;
  let failed = 0;
  let abandoned = 0;
  let active = 0;
  let totalCost = 0;
  let totalDurationMs = 0;
  let minStartMs = Infinity;
  let maxEndMs = -Infinity;

  for (const [ticket, w] of entries) {
    if (isMerged(w.status)) done++;
    else if (isAbandoned(w.status)) abandoned++;
    else if (w.status === "failed") failed++;
    if (w.alive) active++;
    totalCost += effectiveCost(w, analyticsMap[ticket]);
    const a = analyticsMap[w.ticket || ticket];
    if (a?.durationMs && Number.isFinite(a.durationMs)) {
      totalDurationMs += a.durationMs;
    }
    const sMs = w.startedAt ? Date.parse(w.startedAt) : NaN;
    const eMs = w.completedAt ? Date.parse(w.completedAt) : NaN;
    if (Number.isFinite(sMs)) minStartMs = Math.min(minStartMs, sMs);
    if (Number.isFinite(eMs)) maxEndMs = Math.max(maxEndMs, eMs);
  }

  const total = entries.length - abandoned;
  const orchStartMs = orch.startedAt ? Date.parse(orch.startedAt) : NaN;
  const startMs = Number.isFinite(orchStartMs)
    ? orchStartMs
    : minStartMs === Infinity
      ? NaN
      : minStartMs;
  const endMs =
    maxEndMs === -Infinity
      ? Date.now()
      : Math.max(maxEndMs, Date.now());
  const wallMs =
    Number.isFinite(startMs) && endMs > startMs ? endMs - startMs : 0;
  const parallelism =
    wallMs > 0 && totalDurationMs > 0 ? totalDurationMs / wallMs : 0;

  return {
    total,
    done,
    failed,
    abandoned,
    active,
    pct: total > 0 ? Math.round((done / total) * 100) : 0,
    totalCost,
    wallMs,
    totalDurationMs,
    parallelism,
    minStartMs: Number.isFinite(minStartMs) ? minStartMs : 0,
    maxEndMs: Number.isFinite(maxEndMs) ? maxEndMs : 0,
  };
}

export function waveDoneCount(
  wave: Wave,
  workers: Record<string, WorkerState>,
): number {
  const tickets = Array.isArray(wave.tickets) ? wave.tickets : [];
  return tickets.filter((t) => isMerged(workers[t]?.status || "")).length;
}
