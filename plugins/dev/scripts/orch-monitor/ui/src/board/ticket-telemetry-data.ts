// ticket-telemetry-data.ts — PURE logic for the ticket TELEMETRY strip (CTL-917
// / DETAIL6). React-/DOM-free so it unit-tests directly under `bun test`. It owns
// the query_range → tile/bar shaping, the resident-scalar FALLBACK (a ticket
// with no live series yet does an instant no-sparkline paint off
// BoardTicket.{costUSD,tokens,turns} + phaseCosts — never blank), and the
// cost-by-phase / cost-by-model bar derivation. Every value is a real series
// point, a real BoardTicket scalar, or an honest NEEDS-PLUMBING marker — never
// fabricated (design §4.2 TELEMETRY strip).
//
// Honest-to-source (Scenario 4): cost & tokens carry the labels we query
// (linear_key/type/task_type/model) → REAL sparklines + bars. commits & LoC are
// git-sourced (no Prometheus series) → NEEDS-PLUMBING tiles, never a fabricated
// count. cost-by-phase falls back to BoardTicket.phaseCosts for an instant paint.

import type { BoardTicket } from "./types";
import type { SparklinePoint } from "./worker-burn-data";
import { seriesIsLive, seriesLast } from "./worker-burn-data";

export type { SparklinePoint };

/** The series the `/api/otel/ticket-telemetry/<linearKey>` endpoint returns. */
export interface TicketTelemetrySeries {
  cost: SparklinePoint[];
  tokens: SparklinePoint[];
  tokensByType: Record<string, SparklinePoint[]>;
  costByPhase: Record<string, SparklinePoint[]>;
  costByModel: Record<string, SparklinePoint[]>;
}

export type TelemetryTileSource = "sparkline" | "scalar-fallback" | "needs-plumbing";

/** One headline telemetry tile (total cost / tokens / commits / LoC). */
export interface TelemetryTile {
  label: string;
  points: SparklinePoint[];
  value: number | null;
  source: TelemetryTileSource;
}

function buildSeriesTile(
  label: string,
  points: SparklinePoint[],
  scalar: number | null,
): TelemetryTile {
  if (seriesIsLive(points)) {
    return { label, points, value: seriesLast(points), source: "sparkline" };
  }
  // Instant-paint fallback to the resident scalar (no sparkline) — never blank.
  return { label, points: [], value: scalar, source: "scalar-fallback" };
}

/** Build the four headline tiles (COST / TOKENS / COMMITS / LoC). cost & tokens
 *  are REAL sparklines (fallback to BoardTicket scalars); commits & LoC are
 *  git-sourced NEEDS-PLUMBING — honest dim, never a fabricated count. */
export function buildTelemetryTiles(
  series: TicketTelemetrySeries | null,
  ticket: BoardTicket | undefined,
): TelemetryTile[] {
  return [
    buildSeriesTile("COST", series?.cost ?? [], ticket?.costUSD ?? null),
    buildSeriesTile("TOKENS", series?.tokens ?? [], ticket?.tokens ?? null),
    { label: "COMMITS", points: [], value: null, source: "needs-plumbing" },
    { label: "LoC", points: [], value: null, source: "needs-plumbing" },
  ];
}

// ── breakdown bars (cost-by-phase / cost-by-model) ──────────────────────────

/** One breakdown bar: a label (phase or model) and its current cost value. */
export interface BreakdownBar {
  label: string;
  value: number;
}

/** Whether a breakdown bar group is REAL (off the live `sum by(...)` series) or
 *  an instant-paint fallback off the resident phaseCosts (cost-by-phase only). */
export type BreakdownSource = "sparkline" | "scalar-fallback" | "unavailable";

export interface BreakdownBars {
  bars: BreakdownBar[];
  source: BreakdownSource;
}

/** Collapse a `sum by(label)` series map to one current-value bar per label,
 *  sorted descending by value (biggest spend first — the bar-chart reading). */
function barsFromSeriesMap(map: Record<string, SparklinePoint[]>): BreakdownBar[] {
  const bars: BreakdownBar[] = [];
  for (const [label, pts] of Object.entries(map)) {
    const v = seriesLast(pts);
    if (v != null && v > 0) bars.push({ label, value: v });
  }
  return bars.sort((a, b) => b.value - a.value);
}

/**
 * Resolve the cost-by-PHASE bars (design §4.2 — `sum by(task_type)`). When the
 * live series has bars, use them (REAL). Otherwise fall back to the resident
 * `BoardTicket.phaseCosts[phase].costUSD` for an instant no-sparkline paint
 * (Scenario 3). `unavailable` only when neither source has a value.
 */
export function resolveCostByPhase(
  series: TicketTelemetrySeries | null,
  ticket: BoardTicket | undefined,
): BreakdownBars {
  const live = barsFromSeriesMap(series?.costByPhase ?? {});
  if (live.length > 0) return { bars: live, source: "sparkline" };

  const phaseCosts = ticket?.phaseCosts ?? null;
  if (phaseCosts) {
    const bars: BreakdownBar[] = [];
    for (const [phase, c] of Object.entries(phaseCosts)) {
      if (c && c.costUSD > 0) bars.push({ label: phase, value: c.costUSD });
    }
    if (bars.length > 0) {
      return { bars: bars.sort((a, b) => b.value - a.value), source: "scalar-fallback" };
    }
  }
  return { bars: [], source: "unavailable" };
}

/**
 * Resolve the cost-by-MODEL bars (design §4.2 — `sum by(model)`). There is NO
 * resident per-model scalar fallback (the resident phaseCosts carry no model
 * split), so this is REAL-or-unavailable: live bars when the series has them,
 * else `unavailable` (the skin dims the bar group) — NEVER a fabricated split.
 */
export function resolveCostByModel(
  series: TicketTelemetrySeries | null,
): BreakdownBars {
  const live = barsFromSeriesMap(series?.costByModel ?? {});
  if (live.length > 0) return { bars: live, source: "sparkline" };
  return { bars: [], source: "unavailable" };
}
