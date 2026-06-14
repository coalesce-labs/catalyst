// spend-over-time-panel.tsx — the FINOPS P-A panel body (OBS-10, layout spec §2).
//
// Hourly spend bars over the window (24h/7d) with the SPIKING hours flagged. A
// spike is scored server-side (scoreSpikes: hour > max(2× trailing median, μ+2σ))
// and rendered as a `--chart-4` (red) FILL on that one bar plus a red dot above it
// — the ONE status-color use in this panel (Principle 3). Every other bar is the
// categorical `--chart-1` (brand blue). Spike detection reads better on discrete
// hourly bars than a filled area, so P-A is a bar (layout spec §4.4).
//
// Drill (progressive disclosure): clicking a spiking bar fires onSpikeClick with
// that hour's epoch-second timestamp so the caller can re-query that hour's
// by-ticket / by-model split (one re-query, layout spec §2 P-A).
//
// The spike dot + fill are drawn by a custom Bar `shape` (a self-contained
// rect + dot keyed off the bar's own payload.isSpike) rather than recharts'
// deprecated <Customized> layer — it is version-stable across recharts 3.x and
// needs no access to the chart's internal computed-geometry array.
//
// This renders the LIVE state's children — the surrounding ChartCard
// (dataSource="[prom]") owns the unconfigured / unreachable / empty honesty states.

import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { toSpendBars, type SpendBar, formatUsd } from "./finops-panels";
import type { CostSeriesPoint } from "@/lib/types";

const CHART_CONFIG = {
  usd: { label: "Spend", color: "var(--chart-1)" },
} satisfies ChartConfig;

export interface SpendOverTimePanelProps {
  /** /api/otel/cost-series points (already spike-scored server-side). */
  points: CostSeriesPoint[];
  /** Drill: click a SPIKING bar → that hour's by-ticket/by-model split. Receives
   *  the bar's epoch-SECOND timestamp (the re-query window key). */
  onSpikeClick?: (epochSeconds: number) => void;
}

/** The geometry + payload recharts injects into a Bar `shape`. We only read the
 *  rect box + the row's payload (the SpendBar) — kept minimal so it is stable
 *  across recharts 3.x point shapes. */
interface BarShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: SpendBar;
}

/** Custom bar shape: the rect (categorical --chart-1, or --chart-4 when this hour
 *  spiked) plus a --chart-4 dot floating just above a spiking bar (the one
 *  status-color use in this panel, Principle 3). Non-spiking hours render just the
 *  blue rect. */
function SpendBarShape({ x = 0, y = 0, width = 0, height = 0, payload }: BarShapeProps) {
  const isSpike = payload?.isSpike ?? false;
  const fill = isSpike ? "var(--chart-4)" : "var(--chart-1)";
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={2} ry={2} fill={fill} />
      {isSpike && (
        <circle
          cx={x + width / 2}
          cy={Math.max(4, y - 6)}
          r={3.5}
          fill="var(--chart-4)"
        />
      )}
    </g>
  );
}

export function SpendOverTimePanel({
  points,
  onSpikeClick,
}: SpendOverTimePanelProps) {
  const bars = useMemo(() => toSpendBars(points), [points]);

  return (
    <ChartContainer config={CHART_CONFIG} className="h-full w-full">
      <BarChart
        accessibilityLayer
        data={bars}
        margin={{ top: 12, right: 8, left: 0, bottom: 0 }}
      >
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={24}
          fontSize={10}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          fontSize={10}
          tickFormatter={(v: number) => formatUsd(v)}
        />
        <ChartTooltip
          cursor={{ fill: "var(--surface-2, rgba(255,255,255,0.04))" }}
          content={
            <ChartTooltipContent
              labelKey="label"
              formatter={(value) => formatUsd(Number(value))}
            />
          }
        />
        <Bar
          dataKey="usd"
          shape={<SpendBarShape />}
          // Click a spiking bar → drill into that hour (layout spec §2 P-A).
          onClick={(data: { payload?: SpendBar }) => {
            const bar = data?.payload;
            if (bar?.isSpike && onSpikeClick) onSpikeClick(bar.t);
          }}
          // pointer only over spiking bars — recharts applies this at the series
          // level; the shape's dot makes the spiking bar the obvious affordance.
          cursor={onSpikeClick ? "pointer" : "default"}
        />
      </BarChart>
    </ChartContainer>
  );
}
