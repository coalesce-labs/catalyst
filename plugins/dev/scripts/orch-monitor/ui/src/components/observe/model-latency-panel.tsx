// model-latency-panel.tsx — the TELEMETRY P4 panel body (OBS-7): per-model
// api_request latency (p50/p95) + error%, ranked slowest-p95 first (the bottleneck
// model leads). Each row: model · p50 · p95 (a horizontal bar scaled to the panel
// max-p95) · error% label.
//
// A metric-row "bar-horizontal" (Principle 9/10), NOT a Recharts chart — the bar is
// a CSS-width div filled with var(--chart-1). The error% is a STATUS axis: a model
// over the 2% threshold tints its label with the health red token (Principle 3 —
// color = status), independent of the latency bar's categorical color (Principle 8).
//
// Renders the LIVE state's children — the surrounding ChartCard (dataSource="[loki]")
// owns the unconfigured / unreachable / empty honesty states. A model with no p95
// sample renders its row with a dimmed "—" (never fabricated, never dropped).

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ModelLatencyRow } from "@/lib/types";
import {
  barPercent,
  latencyLabel,
  errorPercentLabel,
  maxModelP95,
} from "./telemetry-panels";

/** error-rate > 2% is the hero's ERRORING threshold — reuse it for the per-model
 *  error% tint so the two read consistently. */
const ERROR_RATE_ALERT = 0.02;

export interface ModelLatencyPanelProps {
  rows: ModelLatencyRow[];
  /** Drill: click a model row → filter the P1 tail to that model. */
  onSelectModel?: (model: string) => void;
}

function ModelRow({
  row,
  maxP95,
  onSelect,
}: {
  row: ModelLatencyRow;
  maxP95: number;
  onSelect?: () => void;
}) {
  const width = barPercent(row.p95Ms ?? 0, maxP95);
  const erroring = row.errorRate !== null && row.errorRate > ERROR_RATE_ALERT;
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
        {row.model}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted/80">
        p50 {latencyLabel(row.p50Ms)}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted">
        p95 {latencyLabel(row.p95Ms)}
      </span>
      <span className="relative h-2.5 flex-1 overflow-hidden rounded-sm bg-surface-3">
        <span
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{ width: `${width}%`, backgroundColor: "var(--chart-1)" }}
        />
      </span>
      {/* error% — a STATUS axis: red token only when over the 2% threshold. */}
      <span
        className={cn(
          "w-14 shrink-0 text-right font-mono text-[10px] tabular-nums",
          erroring ? "text-red" : "text-muted/70",
        )}
      >
        {errorPercentLabel(row.errorRate)}E
      </span>
    </button>
  );
}

export function ModelLatencyPanel({ rows, onSelectModel }: ModelLatencyPanelProps) {
  const maxP95 = useMemo(() => maxModelP95(rows), [rows]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex items-center justify-between px-3 text-[10px] text-muted/70">
        <span>model · p50 · p95</span>
        <span>error%</span>
      </div>
      <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-surface-2">
        {rows.map((row) => (
          <ModelRow
            key={row.model}
            row={row}
            maxP95={maxP95}
            onSelect={onSelectModel ? () => onSelectModel(row.model) : undefined}
          />
        ))}
      </ScrollArea>
    </div>
  );
}
