// utilization-hero.tsx — the UTILIZATION surface's ONE hero answer (OBS-16,
// layout spec §2). "Am I getting value from the slots I'm paying for?"
//
//   ◯ 0% UTILIZED · 0/6 slots busy · queue 3 · 0 idle-between-phases    [board]
//
// The big number is the slot-occupancy percent (inFlight / AUTOTUNED maxParallel),
// rendered via KpiNumber as a count-up. There is NO delta — a historical comparison
// would need the OBS-15 event-log read-model (not built), and a fabricated delta
// would be a lie (Principle 6); the number stands alone.
//
// The status dot left of the number is the calm utilization BAND (idle/partial/
// full), NOT the pathology — the loud STARVED/JAMMED signal is the badge BELOW the
// hero, so the two don't compete. Live: a calm grey ◯ 0% while the JAMMED badge
// screams (correct division of labor — design §3.2).

import { KpiNumber } from "@/components/observe/kpi-number";
import { occupancyBand, type OccupancyBand } from "./utilization-kit";

/** The band → CSS-var color for the hero dot. Idle is neutral grey (honest, not
 *  alarming on its own); partial is cyan; full is green (fully utilized). These are
 *  utilization-band tokens, NOT the pathology status colors (those live in the
 *  badge). */
const BAND_VAR: Record<OccupancyBand, string> = {
  idle: "var(--color-muted)",
  partial: "var(--chart-5)",
  full: "var(--chart-2)",
};

/** A small steady status dot painted with the band's CSS var (no hardcoded hex). */
function BandDot({ band }: { band: OccupancyBand }) {
  const color = BAND_VAR[band];
  return (
    <span
      className="relative inline-block h-2.5 w-2.5"
      role="img"
      aria-label="utilization"
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
      />
    </span>
  );
}

export interface UtilizationHeroProps {
  /** Slot occupancy percent (already derived via occupancyPct from the autotuned
   *  maxParallel) — the hero's big number. */
  occupancyPct: number;
  /** Busy slots (config.inFlight). */
  inFlight: number;
  /** AUTOTUNED total capacity (config.maxParallel). */
  maxParallel: number;
  /** Waiting queue depth (board.queue.length). */
  queueLen: number;
  /** Idle-between-phases count (the CTL-928 lane list length). */
  idleCount: number;
}

export function UtilizationHero({
  occupancyPct,
  inFlight,
  maxParallel,
  queueLen,
  idleCount,
}: UtilizationHeroProps) {
  const band = occupancyBand(occupancyPct);

  return (
    <div className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
      <BandDot band={band} />
      {/* The hero number: occupancy %, count-up, no delta (no honest historical
          source live — OBS-15). */}
      <KpiNumber value={occupancyPct} unit="%" deltaDirection="up-good" />
      <span className="text-sm font-semibold tracking-wide text-fg">UTILIZED</span>
      <span className="flex items-center gap-1.5 text-[12px] text-muted tabular-nums">
        <span className="text-muted/60">·</span>
        <span>
          {inFlight}/{maxParallel} slots busy
        </span>
        <span className="text-muted/60">·</span>
        <span>queue {queueLen}</span>
        <span className="text-muted/60">·</span>
        <span>{idleCount} idle-between-phases</span>
      </span>
      <span className="ml-auto font-mono text-[10px] tracking-wide text-muted/70">
        [board]
      </span>
    </div>
  );
}
