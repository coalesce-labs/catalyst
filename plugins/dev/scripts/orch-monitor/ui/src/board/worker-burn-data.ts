// worker-burn-data.ts — PURE logic for the worker Burn Strip (CTL-917 /
// DETAIL6). React-/DOM-free so it unit-tests directly under `bun test` (the same
// discipline as worker-detail-data.ts / ticket-page-model.ts). It owns the
// query_range → sparkline-tile shaping, the resident-scalar FALLBACK decision
// (a just-spawned worker with a flat/empty series degrades to BoardWorker
// scalars with a "(live in …)" hint — NEVER a blank chart), and the idle-ratio
// math (active_time ÷ runtimeMs — the stuck-tell). Every value is a real series
// point, a real BoardWorker scalar, or an honest NEEDS-PLUMBING marker — never
// fabricated (design §5.2 BURN STRIP).
//
// The four Burn-Strip tiles (design §5.2 wireframe):
//   COST / TOKENS / ACTIVE  → REAL query_range sparklines keyed session_id=$UUID.
//   COMMITS                 → git-sourced (no session_id Prometheus series) →
//                             NEEDS-PLUMBING, never a fabricated count (Scenario:
//                             "Counters stay honest to their source").

import type { BoardWorker } from "./types";

/** One [epochSeconds, value] point — mirrors the server's SparklinePoint. */
export type SparklinePoint = [number, number];

/** The four burn series the `/api/otel/burn/<sessionId>` endpoint returns. */
export interface WorkerBurnSeries {
  cost: SparklinePoint[];
  tokens: SparklinePoint[];
  tokensByType: Record<string, SparklinePoint[]>;
  activeSeconds: SparklinePoint[];
}

/** How a tile is sourced — drives the skin's REAL-vs-fallback treatment. */
export type BurnTileSource = "sparkline" | "scalar-fallback" | "needs-plumbing";

/** One rendered Burn-Strip tile. `points` is the sparkline series (possibly
 *  empty); `scalar` is the resident-scalar fallback value; `source` says which
 *  the skin should foreground. */
export interface BurnTile {
  /** Tile label — COST / TOKENS / ACTIVE / COMMITS. */
  label: string;
  /** The query_range series (empty for a scalar-fallback / needs-plumbing tile). */
  points: SparklinePoint[];
  /** The current (last) value of the series, or the resident scalar when the
   *  series is empty — the headline number the tile shows. null when neither
   *  source has a value. */
  value: number | null;
  source: BurnTileSource;
  /** Set on a scalar-fallback tile: the honest "(live in …)" hint the design
   *  mandates so the operator knows the sparkline is coming, never blank. */
  hint?: string;
}

/** A series is "live" once it carries at least one point with a positive value.
 *  A just-spawned worker (~1min, a flat all-zero or empty series) is NOT live,
 *  so the tile falls back to the resident scalar (design Scenario 2). */
export function seriesIsLive(points: SparklinePoint[]): boolean {
  return points.some(([, v]) => Number.isFinite(v) && v > 0);
}

/** The last (current/cumulative) value of a series, or null when empty. */
export function seriesLast(points: SparklinePoint[]): number | null {
  if (points.length === 0) return null;
  const last = points[points.length - 1];
  return last ? last[1] : null;
}

/** Build ONE cost/tokens/active tile, choosing the sparkline when the series is
 *  live or the resident scalar fallback (with a "(live in …)" hint) otherwise. */
function buildSeriesTile(
  label: string,
  points: SparklinePoint[],
  scalar: number | null,
): BurnTile {
  if (seriesIsLive(points)) {
    return { label, points, value: seriesLast(points), source: "sparkline" };
  }
  // Just-spawned / flat series → fall back to the resident scalar, never blank.
  return {
    label,
    points: [],
    value: scalar,
    source: "scalar-fallback",
    hint: "live in ~1m",
  };
}

/** Build the four Burn-Strip tiles from the fetched series (or null when the
 *  endpoint is unavailable / the worker has no session id) and the resident
 *  BoardWorker scalars. The COMMITS tile is always NEEDS-PLUMBING (git-sourced,
 *  no session_id Prometheus series) — an honest dim, never a fabricated count. */
export function buildBurnTiles(
  series: WorkerBurnSeries | null,
  worker: BoardWorker | undefined,
): BurnTile[] {
  const costScalar = worker?.costUSD ?? null;
  // BoardWorker carries no resident `tokens` scalar (only costUSD), so the TOKENS
  // tile's fallback is honestly null until the live series lands — never faked.
  return [
    buildSeriesTile("COST", series?.cost ?? [], costScalar),
    buildSeriesTile("TOKENS", series?.tokens ?? [], null),
    buildSeriesTile("ACTIVE", series?.activeSeconds ?? [], null),
    // COMMITS / PR / LoC are git-sourced — no session_id-keyed Prometheus series.
    { label: "COMMITS", points: [], value: null, source: "needs-plumbing" },
  ];
}

// ── idle-ratio (the stuck-tell) ─────────────────────────────────────────────
// active_time ÷ wall-clock runtime as a filled-vs-muted bar. A SHRINKING active
// fraction reads as a stuck worker (the agent is alive but doing nothing). The
// active series is cumulative SECONDS; runtimeMs is wall-clock MILLIS.

export interface IdleRatio {
  /** active_time ÷ runtimeMs, clamped to [0,1]; null when either input is
   *  missing (the bar dims honestly — no fabricated ratio). */
  fraction: number | null;
  /** Active seconds (the numerator) — null when no active series. */
  activeSeconds: number | null;
  /** Wall-clock runtime seconds (the denominator) — null when no runtime. */
  wallSeconds: number | null;
}

/** Derive the idle-ratio from the active-seconds series and the resident
 *  runtimeMs. Pure: a missing series OR a missing/zero runtime yields a null
 *  fraction (the bar dims) rather than a divide-by-zero or a fabricated 0/1. */
export function deriveIdleRatio(
  activeSeconds: SparklinePoint[] | null | undefined,
  runtimeMs: number | null | undefined,
): IdleRatio {
  const active = activeSeconds ? seriesLast(activeSeconds) : null;
  const wallSeconds =
    runtimeMs != null && Number.isFinite(runtimeMs) && runtimeMs > 0
      ? runtimeMs / 1000
      : null;
  if (active == null || wallSeconds == null) {
    return { fraction: null, activeSeconds: active, wallSeconds };
  }
  const raw = active / wallSeconds;
  const fraction = Math.max(0, Math.min(1, raw));
  return { fraction, activeSeconds: active, wallSeconds };
}

// ── idle-vs-working timeline (CTL-925 / WORKER-DETAIL v2 Pass B §5B) ─────────
// A per-bucket "working vs idle over the worker's life" stacked timeline, derived
// from the SAME activeSeconds series the idle-ratio summary uses. The idle-ratio
// is the at-a-glance scalar; THIS is the over-time shape (when did it stall?).
//
// GROUND-TRUTH (verified against the live /api/otel/burn endpoint, 2026-06-10):
// the burn endpoint's `activeSeconds` series is a `sum(claude_code_active_time_
// seconds_total{session_id})` query_range at step=60s, but in practice it is
// NON-MONOTONIC — each bucket carries the active-seconds attributable to THAT
// 60s window (a worker's multiple session streams reset/restart, so the summed
// `*_total` reads per-bucket, not a clean cumulative counter). Observed buckets
// like 19s, 79s, 132s, 197s against a 60s wall width confirm it: a clean
// cumulative diff (activeSeconds[i] − activeSeconds[i-1]) would go NEGATIVE and
// fabricate garbage. So we treat each bucket's value as that bucket's active
// seconds DIRECTLY and CLAMP it to [0, bucketWidth] — an over-count (a summed
// reading above the wall width) clamps to "fully working", never reads >100% and
// never invents idle. This is honest: we down-clamp an over-report, we never
// up-fill a gap.

/** One bucket of the idle-vs-working timeline: a 60s (or endpoint-step) window
 *  split into working vs idle seconds, both clamped so working+idle === width. */
export interface ActivityBucket {
  /** Epoch SECONDS — the bucket's start timestamp (the series' native unit). */
  t: number;
  /** Active (working) seconds in this bucket, clamped to [0, widthSeconds]. */
  workingSeconds: number;
  /** Idle seconds in this bucket = widthSeconds − workingSeconds (clamped ≥0). */
  idleSeconds: number;
  /** The bucket's wall width in seconds (the series step; 60s by default). */
  widthSeconds: number;
}

/** The default bucket width when a series has too few points to infer the step
 *  (the burn endpoint's fixed query_range step — otel-queries.ts rangeWindow). */
export const DEFAULT_BUCKET_WIDTH_SECONDS = 60;

/**
 * Infer the bucket width (seconds) from a series' first adjacent timestamp gap.
 * Returns DEFAULT_BUCKET_WIDTH_SECONDS when the series has <2 points or the gap
 * is non-finite/non-positive (never a divide-by-zero or a fabricated width).
 */
export function inferBucketWidthSeconds(points: SparklinePoint[]): number {
  if (points.length < 2) return DEFAULT_BUCKET_WIDTH_SECONDS;
  const a = points[0]?.[0];
  const b = points[1]?.[0];
  if (a == null || b == null) return DEFAULT_BUCKET_WIDTH_SECONDS;
  const gap = b - a;
  return Number.isFinite(gap) && gap > 0 ? gap : DEFAULT_BUCKET_WIDTH_SECONDS;
}

/**
 * Derive the idle-vs-working timeline buckets from the activeSeconds series. Each
 * series point [t, activeSecondsInBucket] becomes one ActivityBucket: working is
 * the point's value CLAMPED to [0, bucketWidth] (an over-report — a summed reading
 * above the wall width — down-clamps to fully-working, never reads >100%), and
 * idle is the remaining wall seconds. Pure: an empty/absent series yields [] so
 * the timeline degrades honestly (the ChartCard shows "no data in range") rather
 * than fabricating flat bars. Non-finite values are skipped, not zero-filled.
 */
export function deriveActivityBuckets(
  activeSeconds: SparklinePoint[] | null | undefined,
): ActivityBucket[] {
  if (!activeSeconds || activeSeconds.length === 0) return [];
  const width = inferBucketWidthSeconds(activeSeconds);
  const buckets: ActivityBucket[] = [];
  for (const [t, raw] of activeSeconds) {
    if (!Number.isFinite(t) || !Number.isFinite(raw)) continue;
    const working = Math.max(0, Math.min(width, raw));
    buckets.push({
      t,
      workingSeconds: working,
      idleSeconds: Math.max(0, width - working),
      widthSeconds: width,
    });
  }
  return buckets;
}

/** Whether the activity timeline has any bucket carrying positive working time —
 *  drives the ChartCard `hasData` flag so a never-active worker degrades to the
 *  honest "no data in range" state rather than an all-idle bar wall. */
export function activityHasData(
  activeSeconds: SparklinePoint[] | null | undefined,
): boolean {
  return deriveActivityBuckets(activeSeconds).some((b) => b.workingSeconds > 0);
}
