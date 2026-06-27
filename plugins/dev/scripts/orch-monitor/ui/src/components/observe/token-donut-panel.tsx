// token-donut-panel.tsx — the FINOPS P-E panel body (OBS-11, layout spec §2 + §4):
// the four-bucket token-type donut. This is the ONE sanctioned donut on the surface
// (Principle 9 carve-out): a fixed, small (4), mutually-exclusive, sums-to-100%
// partition (input / output / cacheRead / cacheCreation) where the part-of-whole
// relationship IS the message and the center hole carries the cache hit-rate number.
//
// HONESTY (design §2): the four buckets are NEVER collapsed — toTokenSlices always
// returns all four, each its own --chart-1..4 category. Collapsing cacheRead into
// input over-reports cost 35-50% on this cache-heavy workload (cacheRead is ~96% of
// tokens live). The center text is the cache hit-rate (99.5% live), the headline
// that motivates the cache-ROI story in the hero.
//
// Renders the LIVE state's children — the surrounding ChartCard (dataSource="[prom]")
// owns the unconfigured / unreachable / empty honesty states.

import { useMemo } from "react";
import { Label, Pie, PieChart } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  toTokenSlices,
  compactTokens,
  tokenBucketLabel,
  formatHitRate,
  type TokenBucket,
} from "./finops-breakdowns";

// Each bucket → its own categorical chart token (Principle 8: via ChartConfig, no
// hex in JSX). cacheRead/cacheCreation get the green/yellow accents so the cache
// story reads as the win, input/output the blue/cyan neutrals.
const CHART_CONFIG = {
  input: { label: "input", color: "var(--chart-1)" },
  output: { label: "output", color: "var(--chart-5)" },
  cacheRead: { label: "cache read", color: "var(--chart-2)" },
  cacheCreation: { label: "cache write", color: "var(--chart-3)" },
} satisfies ChartConfig;

const BUCKET_COLOR: Record<TokenBucket, string> = {
  input: "var(--chart-1)",
  output: "var(--chart-5)",
  cacheRead: "var(--chart-2)",
  cacheCreation: "var(--chart-3)",
};

export interface TokenDonutPanelProps {
  /** /api/otel/tokens `tokens` map (type → token count). Shaped into the four
   *  fixed slices via toTokenSlices (never collapsed). */
  tokens: Record<string, number> | null;
  /** /api/otel/tokens `cacheHitRate` (0..1), rendered in the donut center. */
  cacheHitRate: number | null;
}

export function TokenDonutPanel({ tokens, cacheHitRate }: TokenDonutPanelProps) {
  const slices = useMemo(() => toTokenSlices(tokens), [tokens]);

  // recharts pie data: name + value + per-slice fill (the categorical token).
  const pieData = useMemo(
    () =>
      slices
        .filter((s) => s.tokens > 0)
        .map((s) => ({
          bucket: s.bucket,
          label: tokenBucketLabel(s.bucket),
          tokens: s.tokens,
          fill: BUCKET_COLOR[s.bucket],
        })),
    [slices],
  );

  const hitLabel = formatHitRate(cacheHitRate);

  return (
    <div className="flex h-full min-h-0 items-center gap-4">
      <ChartContainer
        config={CHART_CONFIG}
        className="aspect-square h-full max-h-[180px] min-w-[160px]"
      >
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                nameKey="label"
                formatter={(value) => `${compactTokens(Number(value))} tokens`}
              />
            }
          />
          <Pie
            data={pieData}
            dataKey="tokens"
            nameKey="label"
            innerRadius={52}
            outerRadius={78}
            strokeWidth={2}
            paddingAngle={2}
            // CTL-1372: disable per-refresh animation. This panel re-renders on
            // the 15s OBSERVE poll cadence; recharts' react-smooth animation
            // manager allocates tween state + retains the prior SVG subtree on
            // every re-animation, which over a long-lived (overnight) session
            // ratchets renderer memory. Matches the board charts' hardening
            // (activity-timeline.tsx / worker-burn-chart.tsx).
            isAnimationActive={false}
          >
            <Label
              content={({ viewBox }) => {
                if (!viewBox || !("cx" in viewBox)) return null;
                const { cx, cy } = viewBox as { cx: number; cy: number };
                return (
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan
                      x={cx}
                      y={cy - 6}
                      className="fill-fg font-mono text-lg font-bold"
                    >
                      {hitLabel}
                    </tspan>
                    <tspan
                      x={cx}
                      y={cy + 12}
                      className="fill-muted text-[10px]"
                    >
                      cache hit
                    </tspan>
                  </text>
                );
              }}
            />
          </Pie>
        </PieChart>
      </ChartContainer>

      {/* Legend: all four buckets, each with its real token count + share. The
          legend ALWAYS lists four rows so an absent bucket reads as 0, never hidden
          (the four-bucket honesty rule, even in the legend). */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {slices.map((s) => (
          <div key={s.bucket} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: BUCKET_COLOR[s.bucket] }}
              aria-hidden
            />
            <span className="w-20 shrink-0 truncate text-[11px] text-fg">
              {tokenBucketLabel(s.bucket)}
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">
              {compactTokens(s.tokens)}
            </span>
            <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted/70">
              {Math.round(s.share * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
