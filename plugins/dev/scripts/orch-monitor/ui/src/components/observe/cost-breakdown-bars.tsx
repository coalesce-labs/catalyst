// cost-breakdown-bars.tsx — the shared FINOPS ranked bar-row body for P-B
// (cost by pipeline stage) and P-D (cost by model / agent), OBS-11.
//
// A metric-row "bar-horizontal" (Principle 9: FinOps = bar + donut + table;
// Principle 10: table-driven), NOT a Recharts chart — each bar is a CSS-width div
// whose fill is a categorical --chart-N token round-robin (Principle 8: chart
// colors via token, never a hex/Tailwind color class on the fill). Rows are ranked
// descending by spend (the operator's real question is "which stage/model costs
// most" = ordering, not part-of-whole — that is why this is a bar, not a pie).
//
// Renders the LIVE state's children — the surrounding ChartCard (dataSource="[prom]")
// owns the unconfigured / unreachable / empty honesty states. An empty rows array
// never reaches here (the ChartCard's hasData gate shows the empty state first).

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { compactUsd } from "./finops-panels";
import { barPercent } from "./telemetry-panels";
import { rankCostMap, maxUsd, type CostRow } from "./finops-breakdowns";

/** The six categorical chart tokens, round-robined across the ranked rows (NOT a
 *  status color — these are categories, Principle 3). The top spender leads with
 *  --chart-1 (brand blue). */
const CHART_VARS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

export interface CostBreakdownBarsProps {
  /** The label→USD cost map (e.g. /api/otel/cost-by-stage, or /api/otel/cost
   *  grouped by model/agent). Zero-filtered + ranked here via rankCostMap. */
  data: Record<string, number> | null;
  /** Column header for the label, e.g. "stage" / "model" / "agent". */
  labelHeader: string;
  /** Optional click-to-drill on a row (the label is passed back). */
  onSelect?: (label: string) => void;
  /** Cap the rendered rows (default 12 — by-stage has ~12 task_types, by-model ~6). */
  limit?: number;
  /** CTL-1040: per-label fill override (e.g. typeSymbol(label).color). When
   *  omitted, rows keep the --chart-N round-robin (P-B / P-D unchanged). */
  colorFor?: (label: string) => string;
}

function BreakdownRow({
  row,
  max,
  colorVar,
  total,
  onSelect,
}: {
  row: CostRow;
  max: number;
  colorVar: string;
  total: number;
  onSelect?: () => void;
}) {
  const width = barPercent(row.usd, max);
  const sharePct = total > 0 ? Math.round((row.usd / total) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!onSelect}
      className={cn(
        "group flex w-full items-center gap-3 px-3 py-1.5 text-left",
        "border-b border-border/40 last:border-b-0",
        onSelect ? "hover:bg-surface-1" : "cursor-default",
      )}
    >
      <span className="w-32 shrink-0 truncate font-mono text-[11px] text-fg group-hover:text-accent">
        {row.label}
      </span>
      <span className="relative h-2.5 flex-1 overflow-hidden rounded-sm bg-surface-3">
        <span
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{ width: `${width}%`, backgroundColor: colorVar }}
        />
      </span>
      <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg">
        {compactUsd(row.usd)}
      </span>
      <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted/70">
        {sharePct}%
      </span>
    </button>
  );
}

export function CostBreakdownBars({
  data,
  labelHeader,
  onSelect,
  limit = 12,
  colorFor,
}: CostBreakdownBarsProps) {
  const rows = useMemo(() => rankCostMap(data).slice(0, limit), [data, limit]);
  const max = useMemo(() => maxUsd(rows), [rows]);
  const total = useMemo(() => rows.reduce((s, r) => s + r.usd, 0), [rows]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex items-center justify-between px-3 text-[10px] text-muted/70">
        <span>{labelHeader} · spend</span>
        <span>ranked ↓</span>
      </div>
      <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-surface-2">
        {rows.map((row, i) => (
          <BreakdownRow
            key={row.label}
            row={row}
            max={max}
            total={total}
            colorVar={colorFor ? colorFor(row.label) : CHART_VARS[i % CHART_VARS.length]!}
            onSelect={onSelect ? () => onSelect(row.label) : undefined}
          />
        ))}
      </ScrollArea>
    </div>
  );
}
