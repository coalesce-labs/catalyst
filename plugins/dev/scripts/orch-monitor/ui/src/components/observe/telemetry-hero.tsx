// telemetry-hero.tsx — the TELEMETRY surface's ONE hero line (OBS-6). This IS
// the surface; everything below supports it (layout spec §1, Principle 1).
//
// One full-width line, top of page, visible before any scroll:
//   ● FLOWING · last event 4s ago · 2 API errors /15m (0.4%)        [loki]
//
// Color = STATUS only (Principle 3). The dot color derives from health tokens via
// inline `var(--…)` — NOT a categorical --chart-N decoration and NOT a Tailwind
// color class on the SVG (Principle 8). The four tones:
//   FLOWING  → --chart-2 (green)   ERRORING → --chart-4 (red)
//   QUIET    → --color-muted (neutral, NEVER amber — §5 violation #1)
//   DARK     → --color-yellow (amber/STALE — reserved strictly for reachability)

import { cn } from "@/lib/utils";
import {
  type HeroState,
  type HeroTone,
  HERO_TONE,
  errorChipCopy,
  errorRateLabel,
  freshnessLabel,
} from "./hero-state";

/** Token (a CSS var) each tone paints with. Centralized so the dot, the state
 *  word, and the STALE badge all read from ONE place. */
const TONE_VAR: Record<HeroTone, string> = {
  ok: "var(--chart-2)",
  neutral: "var(--color-muted)",
  err: "var(--chart-4)",
  stale: "var(--color-yellow)",
};

/** A glow-pulsing status dot whose color is the tone's CSS var (no hardcoded hex,
 *  no Tailwind color class on the element — Principle 8). FLOWING pulses; the
 *  other states are steady. */
function HeroDot({ tone }: { tone: HeroTone }) {
  const color = TONE_VAR[tone];
  return (
    <span className="relative inline-block h-2.5 w-2.5" role="img" aria-label="status">
      <span
        className="absolute inset-0 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
      />
      {tone === "ok" && (
        <span
          className="absolute inset-0 rounded-full animate-live-pulse"
          style={{ backgroundColor: color }}
        />
      )}
    </span>
  );
}

export interface TelemetryHeroProps {
  state: HeroState;
  /** Age (ms) of the newest Loki line, or null. */
  freshnessMs: number | null;
  /** Count of api_error events over 15m (for the "<N> API errors" copy). */
  errorCount: number;
  /** errors / requests over 15m (for the "(<rate>%)" copy). */
  errorRate: number | null;
  /** CTL-1039: api_error count since local midnight — the NOTED "N errors today"
   *  neutral chip (every count states its window). */
  errorCountToday?: number;
  /** CTL-1039: api_error count in the last 15m — pairs with today in the chip. */
  errorCount15m?: number;
  /** CTL-1039: a degraded source shows a muted "reconnecting…" hint (never DARK).
   *  The hero keeps its last data-driven state. */
  reconnecting?: boolean;
  /** Last-good timestamp (epoch ms) shown only in DARK so the operator sees how
   *  stale the surface is. null when unknown. */
  lastGoodMs?: number | null;
  /** CTL-1039: epoch ms Loki entered DARK (≥3 consecutive failures) — drives the
   *  "Loki unreachable since HH:MM" copy. null when unknown. */
  darkSinceMs?: number | null;
}

/** Local HH:MM for the DARK "since" copy. */
function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const STATE_COPY: Record<HeroState, string> = {
  FLOWING: "FLOWING",
  QUIET: "QUIET",
  ERRORING: "ERRORING",
  DARK: "DARK",
};

export function TelemetryHero({
  state,
  freshnessMs,
  errorCount,
  errorRate,
  errorCountToday,
  errorCount15m,
  reconnecting = false,
  lastGoodMs,
  darkSinceMs,
}: TelemetryHeroProps) {
  const tone = HERO_TONE[state];
  const color = TONE_VAR[tone];

  // CTL-1039: the error clause. ERRORING (red) keeps the rate-bearing "N errors
  // in last 15m (X%)" copy. Every other state shows the NEUTRAL, muted NOTED chip
  // with EXPLICIT windows ("today" / "last 15m") — no red anywhere. Falls back to
  // the legacy 15m count when the windowed counts aren't supplied.
  const today = errorCountToday ?? errorCount;
  const last15m = errorCount15m ?? errorCount;

  return (
    <div className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
      <HeroDot tone={tone} />
      <span
        className="font-mono text-sm font-semibold tracking-wide"
        style={{ color }}
      >
        {STATE_COPY[state]}
      </span>

      {/* DARK: don't claim a freshness/error number we can't trust — say STALE +
          last-good age. Other states: the freshness + error copy. */}
      {state === "DARK" ? (
        <span className="flex items-center gap-2 text-[12px] text-muted">
          <span
            className="rounded border px-1.5 py-0.5 font-mono text-[10px]"
            style={{ borderColor: color, color }}
          >
            STALE
          </span>
          <span>
            Loki unreachable
            {typeof darkSinceMs === "number" && <> since {hhmm(darkSinceMs)}</>}
            {typeof lastGoodMs === "number" && (
              <> · last good {freshnessLabel(Date.now() - lastGoodMs)}</>
            )}
          </span>
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[12px] text-muted tabular-nums">
          <span className="text-muted/60">·</span>
          <span>last event {freshnessLabel(freshnessMs)}</span>
          <span className="text-muted/60">·</span>
          {state === "ERRORING" ? (
            // ERRORING (red, both gates met): the systemic-failure copy with the
            // window + rate stated explicitly.
            <span className="text-red">
              {last15m} {last15m === 1 ? "error" : "errors"} in last 15m (
              {errorRateLabel(errorRate)})
            </span>
          ) : (
            // NOTED (neutral): the muted error chip with explicit windows — NO red
            // anywhere even when errors exist (the proportional fix).
            <span className="text-muted-foreground">
              {errorChipCopy(today, last15m)}
            </span>
          )}
          {/* CTL-1039: a degraded source → a muted, italic reconnecting hint next
              to the source line (never a banner / DARK). */}
          {reconnecting && (
            <>
              <span className="text-muted/60">·</span>
              <span className="italic text-muted-foreground">reconnecting…</span>
            </>
          )}
        </span>
      )}

      <span className="ml-auto font-mono text-[10px] tracking-wide text-muted/70">
        [loki]
      </span>
    </div>
  );
}
