// worker-burn-chart.tsx — the worker-detail v2 cost+tokens-over-time chart
// (CTL-925 / WORKER-DETAIL v2 Pass A §5A). Replaces the cramped Burn-Strip
// sparkline tiles' headline with a real dual-axis time-series chart, REUSING the
// OBSERVE chart-kit: the 4-state honesty ladder is the ChartCard (dataSource
// "[prom]") and the plot is the vendored recharts <LineChart> + the --chart-N
// design tokens (the SAME kit spend-over-time-panel.tsx uses).
//
// Two series on a shared X (the burn endpoint returns cost + tokens on one
// query_range grid): cost ($, --chart-1, LEFT axis) and tokens (--chart-2, RIGHT
// axis). The scalar COST/TOKENS/ACTIVE headline numbers stay BELOW the chart as a
// compact strip (the existing buildBurnTiles values), with the COMMITS tile held
// honest "— ↯" (deferred git plumbing). The ChartCard owns the unconfigured /
// unreachable / empty states so the chart never renders blank or fabricated.

import { useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ChartCard } from "@/components/observe/chart-card";
import type { OtelHealth } from "@/lib/types";
import type { BoardWorker } from "./types";
import { buildBurnTiles, type BurnTile, type WorkerBurnSeries } from "./worker-burn-data";
import { buildBurnChartData, burnSeriesHasData } from "./worker-now-data";
import { fmtCost, fmtTokens } from "@/lib/formatters";

const CHART_CONFIG = {
  cost: { label: "Cost", color: "var(--chart-1)" },
  tokens: { label: "Tokens", color: "var(--chart-2)" },
} satisfies ChartConfig;

const C = {
  s3: "#1c222b",
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** Compact $ for the left (cost) Y axis — sub-dollar reads in cents. */
function fmtCostAxis(v: number): string {
  if (v >= 1) return `$${v.toFixed(v >= 10 ? 0 : 1)}`;
  return `$${v.toFixed(2)}`;
}

/** Compact token count for the right (tokens) Y axis (k / M). */
function fmtTokenAxis(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(Math.round(v));
}

function tileValue(tile: BurnTile): string {
  if (tile.value == null) return "—";
  switch (tile.label) {
    case "COST":
      return fmtCost(tile.value);
    case "TOKENS":
      return fmtTokens(tile.value);
    case "ACTIVE": {
      const s = Math.round(tile.value);
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }
    default:
      return String(tile.value);
  }
}

/** The compact scalar strip below the chart — keeps the COST/TOKENS/ACTIVE
 *  headline numbers (and the honest COMMITS "— ↯") from the original Burn Strip. */
function ScalarStrip({ tiles }: { tiles: BurnTile[] }) {
  return (
    <div
      data-worker-burn-scalars
      style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}
    >
      {tiles.map((t) => {
        const plumbed = t.source !== "needs-plumbing" && t.value != null;
        return (
          <div
            key={t.label}
            data-burn-scalar={t.label}
            data-plumbed={plumbed}
            style={{
              flex: "1 1 0",
              minWidth: 110,
              background: C.s3,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: "8px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            <span style={{ font: `9px ${C.mono}`, letterSpacing: "0.08em", color: C.fgMuted }}>
              {t.label}
            </span>
            <span
              data-burn-scalar-value
              style={{ font: `14px ${C.mono}`, color: plumbed ? C.fg : C.fgDim, fontWeight: 600 }}
            >
              {t.source === "needs-plumbing" ? (
                <span title="git-sourced, not telemetry">— ↯</span>
              ) : (
                tileValue(t)
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function WorkerBurnChart({
  series,
  worker,
  health,
}: {
  series: WorkerBurnSeries | null;
  worker: BoardWorker | undefined;
  /** /api/health/otel snapshot — drives the ChartCard honesty ladder. */
  health: OtelHealth | null;
}) {
  const data = useMemo(() => buildBurnChartData(series), [series]);
  const tiles = useMemo(() => buildBurnTiles(series, worker), [series, worker]);
  const hasData = burnSeriesHasData(series);

  return (
    <div data-worker-burn-chart style={{ minWidth: 0 }}>
      <ChartCard
        title="Cost & Tokens · over time"
        dataSource="[prom]"
        health={health}
        hasData={hasData}
        bodyClassName="relative min-h-[200px] p-3"
      >
        <ChartContainer config={CHART_CONFIG} className="h-full w-full">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              minTickGap={28}
              fontSize={10}
            />
            <YAxis
              yAxisId="cost"
              tickLine={false}
              axisLine={false}
              width={46}
              fontSize={10}
              tickFormatter={fmtCostAxis}
            />
            <YAxis
              yAxisId="tokens"
              orientation="right"
              tickLine={false}
              axisLine={false}
              width={40}
              fontSize={10}
              tickFormatter={fmtTokenAxis}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--surface-2, rgba(255,255,255,0.08))" }}
              content={
                <ChartTooltipContent
                  labelKey="label"
                  formatter={(value, name) =>
                    name === "cost"
                      ? fmtCost(Number(value))
                      : fmtTokens(Number(value))
                  }
                />
              }
            />
            <Line
              yAxisId="cost"
              dataKey="cost"
              name="cost"
              type="monotone"
              stroke="var(--color-cost)"
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              yAxisId="tokens"
              dataKey="tokens"
              name="tokens"
              type="monotone"
              stroke="var(--color-tokens)"
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      </ChartCard>
      <ScalarStrip tiles={tiles} />
    </div>
  );
}
