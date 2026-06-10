// observe-store.ts — the OBSERVE surface store (OBS-5).
//
// The five OBSERVE surfaces share ONE global time-range selector (build-plan §2.5
// / §2.2). Lifting it into a jotai atom — rather than per-surface useState — means
// the range the operator picks on Telemetry persists when they jump to FinOps or
// DevOps, and every panel on a surface reads the SAME range without prop-drilling.
//
// jotai is already in-grain in this package (board/nav-store.ts owns the detail
// chrome atoms; the kibo-ui gantt also consumes it), so this introduces no new
// runtime — just one more atom.
//
// Per-surface DEFAULT ranges differ (build-plan §2.5: Telemetry=NOW,
// Utilization=NOW, FinOps=TODAY, FleetOps=NOW-pinned, DevOps=CYCLE). Those
// per-surface defaults are applied by each surface when it mounts (a future OBS
// ticket); this atom only owns the live, shared selection and seeds it to NOW —
// the right default for the only live surface tonight (Telemetry).
import { atom } from "jotai";

/** The global time window every OBSERVE panel reads.
 *  NOW    — the live moment (Telemetry / Utilization / FleetOps default)
 *  TODAY  — since local midnight (FinOps default)
 *  24H    — trailing 24 hours
 *  7D     — trailing 7 days
 *  CYCLE  — the current Linear cycle (DevOps default — a correlation surface
 *           needs at least one cycle of merged tickets, build-plan §8)
 *  30D    — trailing 30 days */
export type TimeRange = "NOW" | "TODAY" | "24H" | "7D" | "CYCLE" | "30D";

/** Every range in picker order — the single source the time-range control iterates. */
export const TIME_RANGES: readonly TimeRange[] = [
  "NOW",
  "TODAY",
  "24H",
  "7D",
  "CYCLE",
  "30D",
] as const;

/** Human label per range (the segmented time-range control renders these). */
export const TIME_RANGE_LABEL: Record<TimeRange, string> = {
  NOW: "Now",
  TODAY: "Today",
  "24H": "24h",
  "7D": "7d",
  CYCLE: "Cycle",
  "30D": "30d",
};

/** The shared OBSERVE time window. Seeded to NOW (Telemetry's default — the only
 *  live OBSERVE surface tonight). Per-surface defaults are applied on mount by
 *  each surface in its own OBS ticket. */
export const timeRangeAtom = atom<TimeRange>("NOW");

// ── range → Loki query-range string (OBS-6) ──────────────────────────────────
// The Loki/Prometheus query helpers take a duration string ("15m", "1h", …). The
// telemetry tail maps the operator's TimeRange selection to that duration. NOW is
// the live moment — a tight 15m scan keeps the tail fresh and cheap; the longer
// ranges widen the window for back-scroll.
export const TIME_RANGE_TO_LOKI: Record<TimeRange, string> = {
  NOW: "15m",
  TODAY: "24h",
  "24H": "24h",
  "7D": "7d",
  CYCLE: "7d",
  "30D": "7d", // Loki retention is short; cap the tail scan at 7d.
};

/** Auto-refresh cadence (ms) for the live (NOW) range — the design's "15-60s
 *  auto-refresh". NOW polls fast (15s) so the hero/tail feel live; the longer,
 *  historical ranges refresh lazily (60s) since they move slowly. */
export function refreshIntervalMs(range: TimeRange): number {
  return range === "NOW" ? 15_000 : 60_000;
}
