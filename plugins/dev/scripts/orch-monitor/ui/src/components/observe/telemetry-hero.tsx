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
  /** Last-good timestamp (epoch ms) shown only in DARK so the operator sees how
   *  stale the surface is. null when unknown. */
  lastGoodMs?: number | null;
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
  lastGoodMs,
}: TelemetryHeroProps) {
  const tone = HERO_TONE[state];
  const color = TONE_VAR[tone];

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
          <span className={cn(state === "ERRORING" && "text-red")}>
            {errorCount} API {errorCount === 1 ? "error" : "errors"} /15m (
            {errorRateLabel(errorRate)})
          </span>
        </span>
      )}

      <span className="ml-auto font-mono text-[10px] tracking-wide text-muted/70">
        [loki]
      </span>
    </div>
  );
}
