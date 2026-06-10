// hero-state.ts — the PURE state machine behind the TELEMETRY hero (OBS-6).
//
// The Telemetry surface's one hero line answers "is work actually flowing right
// now?" with exactly one of four states. The state decision is a pure function
// of three live signals so it is unit-testable in isolation and the React skin
// owns no branching logic:
//
//   • lokiReachable — from /api/health/otel (the 10s-TTL real probe, NOT
//     /api/otel/status which lies via a no-TTL circuit breaker, build-plan §8).
//   • freshnessMs   — age of the newest Loki line in {service_name=~"claude-code.*"}
//     (from /api/otel/tail). null ⇒ no recent events in the window.
//   • errorRate     — count(api_error)/count(api_request) over 15m (from
//     /api/otel/errors joined with the request count).
//
// The four states and their EXACT triggers (design §3.1, layout spec §1):
//   DARK      — Loki unreachable (the ChartCard ladder also goes amber/STALE).
//   ERRORING  — error-rate > 2% over 15m.
//   FLOWING   — Loki reachable, freshness ≤ ~60s, error-rate ≤ 2%.
//   QUIET     — Loki reachable, no recent events (freshness null or stale) but
//               this is HONEST, not a fault: the board simply has no active
//               worker right now. QUIET is NEVER painted amber (§5 violation #1);
//               amber is reserved strictly for DARK/STALE (a reachability fault).
//
// Color = STATUS only (Principle 3): the dot derives from health tokens
// (--chart-2 green / muted neutral / --chart-4 red / amber), never a categorical
// --chart-N decoration.

export type HeroState = "FLOWING" | "QUIET" | "ERRORING" | "DARK";

/** Freshness threshold (ms) under which the stream is "live". The design says
 *  "~60s"; a worker emits at least one line per turn, so a 60s gap with workers
 *  idle is QUIET, not a stall. */
export const FRESHNESS_FLOWING_MS = 60_000;

/** Error-rate threshold above which the hero is ERRORING. >2% over 15m (design
 *  §3.1 "rate >2%"). */
export const ERROR_RATE_ERRORING = 0.02;

export interface HeroStateArgs {
  /** Loki reachability from /api/health/otel. null = not yet probed → optimistic
   *  (we don't flash DARK on first paint before the probe resolves). */
  lokiReachable: boolean | null;
  /** Whether the OTEL stack is configured at all (health.configured). When false
   *  the surface collapses to the unconfigured ladder card — the hero is DARK so
   *  it never claims FLOWING on a no-stack install. */
  configured?: boolean;
  /** Age (ms) of the newest claude-code Loki line, or null when none in window. */
  freshnessMs: number | null;
  /** errors / requests over 15m, in [0,1]. null when the request count is unknown
   *  (treated as 0 — we never fabricate an error rate to escalate). */
  errorRate: number | null;
}

/**
 * The single source of truth for the hero state. Decision order (most-degraded
 * first), so a reachability fault always wins over a stale/error read:
 *   1. Not configured OR Loki explicitly unreachable → DARK.
 *   2. error-rate > 2% → ERRORING.
 *   3. fresh (≤60s) → FLOWING.
 *   4. otherwise (reachable, no/old events, low error) → QUIET (honest idle).
 *
 * `lokiReachable === null` (probe not yet resolved) is treated as reachable so we
 * don't flash DARK on first paint; the real state lands on the next 10s probe.
 */
export function heroState({
  lokiReachable,
  configured = true,
  freshnessMs,
  errorRate,
}: HeroStateArgs): HeroState {
  // Unconfigured or a confirmed reachability fault → DARK (amber/STALE).
  if (!configured) return "DARK";
  if (lokiReachable === false) return "DARK";

  const rate = errorRate ?? 0;
  if (rate > ERROR_RATE_ERRORING) return "ERRORING";

  // Fresh events flowing → FLOWING. A null freshness (no lines in window) falls
  // through to QUIET — honest idle, not an error.
  if (freshnessMs !== null && freshnessMs <= FRESHNESS_FLOWING_MS) return "FLOWING";

  return "QUIET";
}

/** The tone each hero state maps to. `ok` = green (--chart-2), `neutral` = muted
 *  (QUIET — NOT amber), `err` = red (--chart-4), `stale` = amber (DARK only).
 *  Centralized so the dot color and the STALE badge can't drift apart. */
export type HeroTone = "ok" | "neutral" | "err" | "stale";

export const HERO_TONE: Record<HeroState, HeroTone> = {
  FLOWING: "ok",
  QUIET: "neutral",
  ERRORING: "err",
  DARK: "stale",
};

/** Human, glanceable freshness label: "4s ago", "3m ago", "—" when unknown. The
 *  hero renders `last event <this>`. */
export function freshnessLabel(freshnessMs: number | null): string {
  if (freshnessMs === null || !Number.isFinite(freshnessMs)) return "—";
  const s = Math.max(0, Math.round(freshnessMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

/** Format an error-rate fraction as a percent string with one decimal: 0.004 →
 *  "0.4%". null/NaN → "0%" (we never show a fabricated rate). */
export function errorRateLabel(errorRate: number | null): string {
  if (errorRate === null || !Number.isFinite(errorRate)) return "0%";
  return `${(errorRate * 100).toFixed(1)}%`;
}
