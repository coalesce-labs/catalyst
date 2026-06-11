// fleetops-hero.tsx — the FLEETOPS surface's ONE hero answer (OBS-18, layout
// spec §3). "Is my hardware healthy and do I need to intervene?"
//
//   ● ALL SYSTEMS GO · 1/1 hosts live · 0 stuck · 0 dead              [events+board]
//
// Worst-state-first: the dot, label, and tone reflect the SINGLE most-degraded
// signal across {host liveness, stuck, dead}, computed by the pure fleetHero()
// helper. There is NO KpiNumber count-up here — the hero "number" is a worst-state
// SENTENCE, not a scalar, so a 0-dead green state never animates a misleading
// digit (plain text). Live = the calm green ALL SYSTEMS GO line — that is correct
// and the SUCCESS case, NOT an empty-state.
//
// Honest degraded source: when /api/cluster is unreachable the hero renders a grey
// ◌ HOST STATUS UNAVAILABLE rather than fabricating "all live" (Principle 6).

import type { FleetHero } from "./fleetops-kit";
import { FLEET_TONE_VAR } from "./fleetops-kit";

/** A steady status dot painted with the worst-state tone's CSS var (no hardcoded
 *  hex). A live-green dot pulses (matches the rest of the app's live-signal idiom);
 *  warn/alert/unavailable are steady so the page doesn't strobe on a problem. */
function FleetDot({ hero }: { hero: FleetHero }) {
  const color = FLEET_TONE_VAR[hero.tone];
  return (
    <span
      className="relative inline-block h-3 w-3 shrink-0"
      role="img"
      aria-label={hero.label}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
      />
    </span>
  );
}

export interface FleetOpsHeroProps {
  /** The worst-state-first roll-up, already derived via fleetHero(). */
  hero: FleetHero;
}

export function FleetOpsHero({ hero }: FleetOpsHeroProps) {
  const color = FLEET_TONE_VAR[hero.tone];
  return (
    <div className="flex w-full shrink-0 items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
      <FleetDot hero={hero} />
      {/* The worst-state SENTENCE — bold lead label, tone-colored. Plain text (no
          count-up): the answer is a sentence, not an animated digit. */}
      <span
        className="text-sm font-semibold tracking-wide"
        style={{ color }}
      >
        {hero.label}
      </span>
      {/* The muted tabular-nums detail run (L/T hosts live · S stuck · D dead). */}
      <span className="flex items-center gap-1.5 text-[12px] text-muted tabular-nums">
        <span className="text-muted/60">·</span>
        <span>{hero.detail}</span>
      </span>
      <span className="ml-auto font-mono text-[10px] tracking-wide text-muted/70">
        [events+board]
      </span>
    </div>
  );
}
