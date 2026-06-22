// capacity-timeline.ts — CTL-1092 Phase 5. Pure transform from the
// /api/capacity-history response (per-host CapStep[]) to chart-ready stepped
// series (per-host CapChartPoint[]). No React, no fetch — fully unit-testable.

/** One capacity change record from the /api/capacity-history response. */
export interface CapStep {
  ts: string;
  old: number;
  new: number;
  reason: string;
}

/** One chart point: `value` is the maxParallel AFTER this step. */
export interface CapChartPoint {
  ts: string;
  value: number;
  old: number;
  reason: string;
}

/** A per-host history map, keyed by pinned host name. */
export type CapHistory = Record<string, CapStep[]>;

/** A per-host stepped chart series, keyed by pinned host name. */
export type CapSeries = Record<string, CapChartPoint[]>;

/**
 * toCapacitySteps — map a CapHistory (from /api/capacity-history) to a
 * per-host stepped line series suitable for a chart. Each step maps to one
 * chart point where `value` is the new maxParallel.
 *
 * Pure function — no side effects, no I/O.
 */
export function toCapacitySteps(history: CapHistory): CapSeries {
  const series: CapSeries = {};
  for (const [host, steps] of Object.entries(history)) {
    series[host] = steps.map((s) => ({
      ts: s.ts,
      value: s.new,
      old: s.old,
      reason: s.reason,
    }));
  }
  return series;
}
