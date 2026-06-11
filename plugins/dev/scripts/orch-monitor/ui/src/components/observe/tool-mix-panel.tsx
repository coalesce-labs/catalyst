// tool-mix-panel.tsx — the TELEMETRY P3 panel body (OBS-7): a ranked bar-row table
// of tool usage SORTED BY TOTAL TIME (count × p95), not call count — a slow tool
// used 10× beats a fast tool used 1000× for surfacing bottlenecks (design §3.1 /
// plan §3 principle 2). Each row: tool · count · p95 · a horizontal bar scaled to
// the row's total time.
//
// This is a metric-row "bar-horizontal" (Principle 9: Telemetry = line/bar/metric-
// rows; Principle 10: table-driven by default), NOT a Recharts chart — the bar is a
// CSS-width div filled with var(--chart-1) (Principle 8: chart colors via token, no
// hardcoded hex / no Tailwind color class on the fill).
//
// Renders the LIVE state's children — the surrounding ChartCard (dataSource="[loki]")
// owns the unconfigured / unreachable / empty honesty states. A tool with no latency
// sample renders its count with a dimmed "—" p95 (never fabricated, never dropped).

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  toolMixByTotalTime,
  barPercent,
  compactCount,
  latencyLabel,
  type ToolMixRow,
} from "./telemetry-panels";

export interface ToolMixPanelProps {
  /** /api/otel/tools call counts (tool → count). */
  counts: Record<string, number>;
  /** /api/otel/tool-latency p50/p95 (tool → {p50Ms, p95Ms}); {} when no samples. */
  latency: Record<string, { p50Ms: number | null; p95Ms: number | null }>;
  /** Drill: click a tool row → filter the P1 tail to that tool. */
  onSelectTool?: (tool: string) => void;
}

function ToolRow({
  row,
  maxTotal,
  onSelect,
}: {
  row: ToolMixRow;
  maxTotal: number;
  onSelect?: () => void;
}) {
  const width = barPercent(row.totalTimeMs, maxTotal);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-3 px-3 py-1.5 text-left",
        "border-b border-border/40 last:border-b-0 hover:bg-surface-1",
      )}
    >
      <span className="w-28 shrink-0 truncate font-mono text-[11px] text-fg group-hover:text-accent">
        {row.tool}
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">
        {compactCount(row.count)}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted/80">
        p95 {latencyLabel(row.p95Ms)}
      </span>
      {/* The bar — CSS width, filled with the categorical chart token (Principle 8). */}
      <span className="relative h-2.5 flex-1 overflow-hidden rounded-sm bg-surface-3">
        <span
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{ width: `${width}%`, backgroundColor: "var(--chart-1)" }}
        />
      </span>
    </button>
  );
}

export function ToolMixPanel({ counts, latency, onSelectTool }: ToolMixPanelProps) {
  const rows = useMemo(() => toolMixByTotalTime(counts, latency), [counts, latency]);
  const maxTotal = useMemo(
    () => rows.reduce((m, r) => (r.totalTimeMs > m ? r.totalTimeMs : m), 0),
    [rows],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex items-center justify-between px-3 text-[10px] text-muted/70">
        <span>tool · calls · p95</span>
        <span>sorted by total time</span>
      </div>
      <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-surface-0">
        {rows.map((row) => (
          <ToolRow
            key={row.tool}
            row={row}
            maxTotal={maxTotal}
            onSelect={onSelectTool ? () => onSelectTool(row.tool) : undefined}
          />
        ))}
      </ScrollArea>
    </div>
  );
}
