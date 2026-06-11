// finops-panels.ts — PURE data-shaping + formatters for the OBS-10 FINOPS hero and
// the P-A spend-over-time bars. DOM-/React-free so every numeric decision (the
// dollar formatting, the delta sign, the cache-ROI multiplier, the spike-bar
// shaping) unit-tests directly under the ui package's `bun test` (the same
// discipline telemetry-panels.ts follows). The panel components are the skin only.
//
// FinOps's soul is HONESTY: a null delta renders "—" (never a fabricated 0%); a
// missing multiplier drops the "(Nx)" rather than dividing by zero; an empty
// series is an empty bar set the ChartCard degrades, never a fabricated bar.

import type { CostSeriesPoint } from "@/lib/types";

// ── dollar / percent formatters ──────────────────────────────────────────────

/** Format a USD amount the way the hero/P-A read it: no cents above $100 (the
 *  hero is a glance number — "$470", not "$469.85"), one decimal below $100, and a
 *  thousands separator. A non-finite input → "$0" (honest, never "NaN"). */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0";
  const abs = Math.abs(usd);
  const fractionDigits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `$${usd.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

/** A compact USD for dense per-model rows: "$1.6k" / "$588" / "$22". A non-finite
 *  input → "$0". */
export function compactUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0";
  const abs = Math.abs(usd);
  if (abs >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
  return `$${Math.round(usd)}`;
}

/** Format a delta FRACTION (e.g. -0.103) as a signed percent string for the hero's
 *  delta label, e.g. "+38%" / "-10%". null → "—" (no baseline → no comparison,
 *  honest, never a fabricated 0%). PURE. */
export function formatDeltaPercent(deltaFraction: number | null): string {
  if (deltaFraction === null || !Number.isFinite(deltaFraction)) return "—";
  const pct = Math.round(deltaFraction * 100);
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct}%`;
}

/** The hero's delta MAGNITUDE as a whole-percent number for KpiNumber's `delta`
 *  prop (which renders the arrow + abs value). null → undefined (KpiNumber then
 *  shows no delta pill at all — the honest "no baseline" rendering). PURE. */
export function deltaPercentValue(deltaFraction: number | null): number | undefined {
  if (deltaFraction === null || !Number.isFinite(deltaFraction)) return undefined;
  return Math.round(deltaFraction * 100);
}

/** Format the cache-ROI multiplier as the "(4.1×)" suffix on the headline. null →
 *  "" (no actual spend to divide by → drop the multiplier, never "(NaN×)" or a
 *  fabricated "(1×)"). PURE. */
export function formatMultiplier(multiplier: number | null): string {
  if (multiplier === null || !Number.isFinite(multiplier)) return "";
  return `${multiplier.toFixed(1)}×`;
}

// ── P-A: spend-over-time bars ─────────────────────────────────────────────────

/** One bar in the P-A chart, shaped from a CostSeriesPoint for the recharts
 *  BarChart. `label` is the hour-of-day tick ("14:00"); `usd` is the bar height;
 *  `isSpike` flags the `--chart-4` dot + the spike fill; `t` is kept as the
 *  epoch-second key the spike-click drill re-queries on. */
export interface SpendBar {
  /** Epoch seconds — the drill re-query key (the clicked hour's window). */
  t: number;
  /** Hour-of-day tick label, e.g. "14:00" (local time). */
  label: string;
  /** The hour's spend, USD. */
  usd: number;
  /** True when this hour scored a spike (set by scoreSpikes server-side). */
  isSpike: boolean;
}

/** A two-digit-hour local label for an epoch-SECONDS timestamp, e.g. "09:00".
 *  PURE-ish (reads the host's local zone, the operator's wall clock — the same
 *  anchoring costToday uses for "today"). */
export function hourLabel(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  return `${hh}:00`;
}

/** Shape a CostSeriesPoint[] (from /api/otel/cost-series) into P-A bars. PURE: an
 *  empty input is an empty array (the ChartCard renders the honest empty state;
 *  this never fabricates a bar). The points are already spike-scored server-side
 *  (scoreSpikes) — we only add the display label + carry the fields through. */
export function toSpendBars(points: CostSeriesPoint[]): SpendBar[] {
  return points.map((p) => ({
    t: p.t,
    label: hourLabel(p.t),
    usd: p.usd,
    isSpike: p.isSpike,
  }));
}

/** The count of spiking hours in the series (for the P-A header "(n spikes)"
 *  annotation). PURE. */
export function spikeCount(points: CostSeriesPoint[]): number {
  return points.reduce((n, p) => (p.isSpike ? n + 1 : n), 0);
}
