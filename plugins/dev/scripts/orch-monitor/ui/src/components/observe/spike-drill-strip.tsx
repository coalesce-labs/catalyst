// spike-drill-strip.tsx — the FINOPS P-A spike-click drill (OBS-10, layout spec
// §2 P-A: "spike bar click → that hour's by-ticket + by-model split").
//
// When the operator clicks a spiking hour in the spend-over-time chart, this strip
// appears below it showing WHO (by-ticket) and WHICH MODEL drove that hour's
// spend — both ranked descending, both zero-filtered server-side. It is the
// "one re-query with the hour window" the design calls for (/api/otel/cost-at-hour
// with the clicked bar's epoch second). Dismissable; honest empty state when the
// hour had no attributed spend.
//
// Bars are CSS-width metric rows (NOT a recharts chart) filled with the
// categorical --chart-1 token (Principle 8) — the same idiom as tool-mix-panel.

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { compactUsd } from "./finops-panels";
import { barPercent } from "./telemetry-panels";
import type { CostAtHour } from "@/lib/types";

export interface SpikeDrillStripProps {
  /** /api/otel/cost-at-hour payload for the clicked hour. null while loading. */
  data: CostAtHour | null;
  /** The hour label being drilled (e.g. "14:00"), for the strip header. */
  hourLabel: string;
  /** Dismiss the drill. */
  onClose: () => void;
}

/** Sort a label→USD map into ranked [label, usd] rows, descending, dropping any
 *  zero (server already zero-filters; this is belt-and-braces). */
function rankRows(map: Record<string, number>): Array<[string, number]> {
  return Object.entries(map)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
}

function DrillColumn({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, number]>;
}) {
  const max = rows.length > 0 ? rows[0]![1] : 0;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted/70">
        {title}
      </span>
      {rows.length === 0 ? (
        <span className="py-1 text-[11px] text-muted/60">no attributed spend</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          {rows.slice(0, 6).map(([label, usd]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-24 shrink-0 truncate font-mono text-[11px] text-fg">
                {label}
              </span>
              <span className="relative h-2 flex-1 overflow-hidden rounded-sm bg-surface-3">
                <span
                  className="absolute inset-y-0 left-0 rounded-sm"
                  style={{
                    width: `${barPercent(usd, max)}%`,
                    backgroundColor: "var(--chart-1)",
                  }}
                />
              </span>
              <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">
                {compactUsd(usd)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SpikeDrillStrip({
  data,
  hourLabel,
  onClose,
}: SpikeDrillStripProps) {
  const byTicket = useMemo(() => rankRows(data?.byTicket ?? {}), [data]);
  const byModel = useMemo(() => rankRows(data?.byModel ?? {}), [data]);

  return (
    <div
      className={cn(
        "mt-2 rounded-md border border-border bg-surface-1/60 p-3",
        "flex flex-col gap-3",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-fg">
          Spike at {hourLabel}
          <span className="ml-2 font-normal text-muted/70">
            who + which model drove this hour
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-fg"
          aria-label="Close spike drill"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
        <DrillColumn title="by ticket" rows={byTicket} />
        <DrillColumn title="by model" rows={byModel} />
      </div>
    </div>
  );
}
