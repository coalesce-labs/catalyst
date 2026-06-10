// activity-timeline.tsx — the worker-detail v2 idle-vs-working timeline (CTL-925 /
// WORKER-DETAIL v2 Pass B §5B). The idle-ratio bar (worker-detail-body.tsx) is the
// at-a-glance scalar stuck-tell; THIS is the over-time shape — a compact stacked
// timeline of working (cyan / --chart-1) vs idle (muted / --chart-3) seconds per
// bucket over the worker's life, so the operator sees WHEN a worker stalled.
//
// REUSES the OBSERVE chart-kit (ChartContainer + the vendored recharts + the
// --chart-N tokens), wrapped in ChartCard (dataSource "[prom]") so the 4-state
// honesty ladder is free: unconfigured → "Configure Prometheus"; unreachable →
// STALE banner; no working time → "no data in range"; live → the timeline. The
// bucket math is the PURE deriveActivityBuckets (worker-burn-data.ts), unit-tested
// — it clamps each bucket's active seconds to the wall width (the live series
// over-reports), so a bar never reads >100% and idle is never fabricated.

import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ChartCard } from "@/components/observe/chart-card";
import type { OtelHealth } from "@/lib/types";
import {
  deriveActivityBuckets,
  activityHasData,
  type WorkerBurnSeries,
} from "./worker-burn-data";
import { fmtBucketLabel } from "./worker-now-data";

const CHART_CONFIG = {
  working: { label: "Working", color: "var(--chart-1)" },
  idle: { label: "Idle", color: "var(--chart-3)" },
} satisfies ChartConfig;

/** One stacked-bar row: working + idle seconds at a bucket, with its HH:MM label. */
interface TimelineRow {
  t: number;
  label: string;
  working: number;
  idle: number;
}

/** Compact "Ns" / "Nm Ns" for the Y axis + tooltip (seconds within a 60s bucket). */
function fmtSecAxis(v: number): string {
  const s = Math.round(v);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

function fmtSecTip(v: number): string {
  const s = Math.round(v);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function ActivityTimeline({
  series,
  health,
}: {
  series: WorkerBurnSeries | null;
  /** /api/health/otel snapshot — drives the ChartCard honesty ladder. */
  health: OtelHealth | null;
}) {
  const activeSeconds = series?.activeSeconds ?? null;
  const rows = useMemo<TimelineRow[]>(
    () =>
      deriveActivityBuckets(activeSeconds).map((b) => ({
        t: b.t,
        label: fmtBucketLabel(b.t),
        working: b.workingSeconds,
        idle: b.idleSeconds,
      })),
    [activeSeconds],
  );
  const hasData = activityHasData(activeSeconds);

  return (
    <div data-worker-activity-timeline style={{ minWidth: 0 }}>
      <ChartCard
        title="Working vs idle · over time"
        dataSource="[prom]"
        health={health}
        hasData={hasData}
        bodyClassName="relative min-h-[180px] p-3"
      >
        <ChartContainer config={CHART_CONFIG} className="h-full w-full">
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
              tickLine={false}
              axisLine={false}
              width={36}
              fontSize={10}
              tickFormatter={fmtSecAxis}
            />
            <ChartTooltip
              cursor={{ fill: "var(--surface-2, rgba(255,255,255,0.04))" }}
              content={
                <ChartTooltipContent
                  labelKey="label"
                  formatter={(value, name) => `${name}: ${fmtSecTip(Number(value))}`}
                />
              }
            />
            {/* stacked: working (cyan) atop idle (muted) — one bar per bucket. */}
            <Bar
              dataKey="working"
              name="working"
              stackId="activity"
              fill="var(--color-working)"
              radius={[0, 0, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="idle"
              name="idle"
              stackId="activity"
              fill="var(--color-idle)"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ChartContainer>
      </ChartCard>
    </div>
  );
}
