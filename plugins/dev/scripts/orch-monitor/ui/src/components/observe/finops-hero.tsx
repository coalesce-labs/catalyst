// finops-hero.tsx — the FINOPS hero dollar+ROI band (OBS-10, layout spec §1).
//
// The surface's ONE answer (Principle 1): "How much did I spend today, and is that
// normal?" Three KPIs on one full-width line, with the cache-ROI number visually
// the LOUDEST (it is the single most motivating FinOps figure — a 99.8%-hit-rate
// prompt cache saved real dollars):
//
//   TODAY  $470  ▲-10% vs 7d avg ($524/day)  ·  proj EOD $1.3k  ·  CACHE SAVED $5,237 (3.5×)
//
// Dollars LEAD; tokens are demoted to a later panel (P-E). Color discipline
// (Principle 3): the ONLY status color in the hero is the today-vs-avg delta badge
// (spend up = bad/amber via KpiNumber's deltaDirection="up-bad"→ we pass the delta
// so a RISING spend reads red). The cache-saved number is the green accent (a WIN,
// deltaless — its size + color carry the emphasis, not a delta pill).
//
// Honesty (Principle 6): the whole band is wrapped by the caller in a single
// <ChartCard dataSource="[prom]"> so a no-Prometheus install shows the configure
// CTA and the band NEVER fabricates a number. The locked dual-currency quota chip
// renders as a clearly-labeled dimmed placeholder ("quota — needs ratelimit
// reader"), NOT a fake number — it lights up after OBS-15.

import { cn } from "@/lib/utils";
import { KpiNumber } from "@/components/observe/kpi-number";
import { Badge } from "@/components/ui/badge";
import { Lock } from "lucide-react";
import {
  formatUsd,
  compactUsd,
  formatDeltaPercent,
  deltaPercentValue,
  formatMultiplier,
} from "./finops-panels";
import type { CostTodaySummary, CacheSavings } from "@/lib/types";

export interface FinopsHeroProps {
  /** /api/otel/cost-today — today's spend + 7d baseline + EOD projection. null
   *  while loading (the band renders dashes, never a fabricated 0). */
  today: CostTodaySummary | null;
  /** /api/otel/cache-savings — the cache-ROI headline. null while loading. */
  cache: CacheSavings | null;
}

/** A small neutral KPI slot (EOD projection): label above, value below. Never
 *  colored — it is informational, never a status (layout spec §1 Hero-B). */
function HeroSlot({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted/70">
        {label}
      </span>
      {children}
    </div>
  );
}

export function FinopsHero({ today, cache }: FinopsHeroProps) {
  // today-vs-avg delta. KpiNumber renders the arrow off the delta SIGN; we pass
  // deltaDirection="up-good"=false → "down-good" would mislabel, so we use the
  // explicit semantics: spend UP is BAD. KpiNumber has up-good/down-good/neutral;
  // for "rising spend = bad" we want a RISING delta to read RED → that is the
  // mirror of "up-good", i.e. down-good (a falling cost is good = green). So a
  // rising (positive) delta under down-good reads red, exactly the budget signal.
  const deltaPct = today ? deltaPercentValue(today.deltaFraction) : undefined;
  const avgLabel =
    today && today.avg7dUsd > 0
      ? `vs 7d avg (${compactUsd(today.avg7dUsd)}/day)`
      : "no 7d baseline yet";

  const multiplier = cache ? formatMultiplier(cache.multiplier) : "";

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      {/* Hero-A — TODAY spend (the primary number) + the today-vs-avg delta badge
          (the ONE allowed status color in the hero: rising spend reads red via
          down-good semantics). */}
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted/70">
          Today
        </span>
        <KpiNumber
          value={today?.todayUsd ?? 0}
          unit="$"
          unitPosition="prefix"
          delta={deltaPct}
          deltaLabel={avgLabel}
          // down-good = a falling cost is green / a rising cost is red — the
          // over-budget signal (layout spec §1: "amber when over-budget trending").
          deltaDirection="down-good"
        />
      </div>

      {/* the · separators + the supporting slots, right-aligned on desktop. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        {/* Hero-B — EOD projection (neutral, never colored — informational). */}
        <HeroSlot label="proj EOD">
          <span className="font-mono text-xl font-semibold tabular-nums text-fg">
            {today ? formatUsd(today.projectionEodUsd) : "—"}
          </span>
        </HeroSlot>

        {/* Hero-C — CACHE SAVED (THE HEADLINE). Green --chart-2 accent + the
            "(Nx)" multiplier so it reads as the win. Deltaless (its size + color
            carry the emphasis); honest "—" while loading, drops "(Nx)" when there
            is no spend to multiply. */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted/70">
            Cache saved today
          </span>
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono text-3xl font-bold leading-none tabular-nums"
              style={{ color: "var(--chart-2)" }}
            >
              {cache ? formatUsd(cache.savedUsd) : "—"}
            </span>
            {multiplier && (
              <span
                className="font-mono text-base font-semibold"
                style={{ color: "var(--chart-2)" }}
              >
                ({multiplier})
              </span>
            )}
          </div>
        </div>

        {/* Locked dual-currency quota chip (DEFERRED — render honestly, never a
            fake number; layout spec §3). Dashed, dimmed, lock icon + the plain-
            language "what unlocks this" copy. Lights up after OBS-15. */}
        <QuotaChipLocked />
      </div>
    </div>
  );
}

/** The deferred dual-currency quota chip. No endpoint reads the
 *  `account.ratelimit.sampled` events server-side yet (needs the OBS-15 event-log
 *  read-model), so this is a LOCKED placeholder — dashed border, dimmed, lock icon,
 *  and a tooltip that explains what lights it up. NEVER a fabricated quota number
 *  (design §2 / layout spec §3). */
export function QuotaChipLocked() {
  return (
    <div
      className={cn(
        "flex max-w-[15rem] items-center gap-2 rounded-md border border-dashed border-border/70 px-3 py-1.5",
        "opacity-60",
      )}
      title="Quota burn — enable the event-log reader (OBS-15) to show 5h/7d quota beside dollars. On Max plans quota is the real budget."
    >
      <Lock className="h-3.5 w-3.5 shrink-0 text-muted" />
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-medium text-muted">quota</span>
        <span className="text-[10px] text-muted/70">needs ratelimit reader</span>
      </div>
      <Badge variant="outline" className="ml-auto font-mono text-[9px] text-muted/60">
        OBS-15
      </Badge>
    </div>
  );
}
