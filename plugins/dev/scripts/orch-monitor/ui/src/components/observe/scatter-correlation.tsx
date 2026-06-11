// scatter-correlation.tsx — a thin, render-only wrapper around the Recharts
// ScatterChart inside our vendored ChartContainer (OBS-1). Used by DevOps P3
// (cost-vs-points). No shadcn scatter block exists, so this is original.
//
// Render-only: it does NOT fetch data. The caller passes pre-shaped rows plus
// the keys to read off each row. Colors come from var(--chart-N) tokens via the
// ChartContainer config (design §5 #8 — never hardcode hex in JSX).

import {
  CartesianGrid,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { DataKey } from "recharts/types/util/types";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";

// Scatter rows hold plottable scalars (numbers for the axes, optional strings
// for category/color keys). Constraining values to `string | number` is what
// lets the keys satisfy Recharts' `TypedDataKey<T>` dataKey type.
export type ScatterRow = Record<string, string | number>;

export interface ScatterCorrelationProps<T extends ScatterRow> {
  data: T[];
  /** Row key for the X (numeric) axis. */
  xKey: keyof T & string;
  /** Row key for the Y (numeric) axis. */
  yKey: keyof T & string;
  /** Row key whose value distinguishes point color/series (optional). */
  colorKey?: keyof T & string;
  xLabel?: string;
  yLabel?: string;
  /** Fill token for the points. Default brand blue. */
  colorVar?: string;
  className?: string;
}

export function ScatterCorrelation<T extends ScatterRow>({
  data,
  xKey,
  yKey,
  colorKey,
  xLabel,
  yLabel,
  colorVar = "var(--chart-1)",
  className,
}: ScatterCorrelationProps<T>) {
  const config: ChartConfig = {
    [yKey]: {
      label: yLabel ?? yKey,
      color: colorVar,
    },
  };

  return (
    <ChartContainer config={config} className={cn("min-h-[200px]", className)}>
      <ScatterChart margin={{ top: 8, right: 8, bottom: 24, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          type="number"
          dataKey={xKey as DataKey<T>}
          name={xLabel ?? xKey}
          tickLine={false}
          axisLine={false}
          label={
            xLabel
              ? { value: xLabel, position: "insideBottom", offset: -12 }
              : undefined
          }
        />
        <YAxis
          type="number"
          dataKey={yKey as DataKey<T>}
          name={yLabel ?? yKey}
          tickLine={false}
          axisLine={false}
          width={40}
          label={
            yLabel
              ? { value: yLabel, angle: -90, position: "insideLeft" }
              : undefined
          }
        />
        <ZAxis type="number" range={[60, 60]} />
        <ChartTooltip
          cursor={{ strokeDasharray: "3 3" }}
          content={<ChartTooltipContent />}
        />
        <Scatter
          data={data}
          fill={colorVar}
          {...(colorKey ? { dataKey: colorKey as DataKey<T> } : {})}
        />
      </ScatterChart>
    </ChartContainer>
  );
}
