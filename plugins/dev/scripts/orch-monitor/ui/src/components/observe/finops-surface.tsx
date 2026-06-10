// finops-surface.tsx — the OBSERVE FinOps surface (OBS-10).
//
// "How much did I spend today, and is that normal?" The surface leads with ONE
// full-width dollar+ROI hero band (today's spend vs the 7d baseline + EOD
// projection + the cache-ROI headline) over the P-A spend-over-time bars with
// spike markers. Dollars LEAD; tokens are demoted to OBS-11's breakdown panels.
//
// FinOps is Prometheus-anchored: EVERY panel is wrapped in <ChartCard
// dataSource="[prom]"> so a no-Prometheus install shows the "Configure
// Prometheus — catalyst-otel" state and NEVER a blank/fabricated number (design
// §2 honesty rule). The Mini HAS Prometheus so the panels render LIVE.
//
// The surface defaults the shared time-range atom to TODAY on mount (FinOps's
// per-surface default, build-plan §2.5) — the only surface whose default is not
// NOW. The hero's "today" number always reads /api/otel/cost-today (anchored to
// local midnight, independent of the picker); the spend-over-time bars + the
// cache-ROI follow the picker via TIME_RANGE_TO_PROM.
import { useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import type {
  OtelHealth,
  CostTodaySummary,
  CostSeriesPoint,
  CacheSavings,
  CostAtHour,
} from "@/lib/types";
import {
  timeRangeAtom,
  TIME_RANGES,
  TIME_RANGE_LABEL,
  TIME_RANGE_TO_PROM,
  refreshIntervalMs,
} from "@/lib/observe-store";
import { ChartCard } from "@/components/observe/chart-card";
import { FinopsHero } from "@/components/observe/finops-hero";
import { SpendOverTimePanel } from "@/components/observe/spend-over-time-panel";
import { SpikeDrillStrip } from "@/components/observe/spike-drill-strip";
import { hourLabel, spikeCount } from "@/components/observe/finops-panels";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** The clicked-spike focus: the hour's epoch second + its label + the fetched
 *  per-hour split (null while the re-query is in flight). */
interface SpikeFocus {
  t: number;
  label: string;
  data: CostAtHour | null;
}

export function FinopsSurface() {
  const [range, setRange] = useAtom(timeRangeAtom);

  // FinOps's per-surface default is TODAY (build-plan §2.5). Apply it ONCE on
  // mount — only if the operator hasn't already moved the shared picker — so
  // navigating in from Telemetry (NOW) lands on the right FinOps default without
  // clobbering an explicit later selection. The ref makes this a true mount-once.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current) return;
    appliedDefault.current = true;
    setRange((prev) => (prev === "NOW" ? "TODAY" : prev));
  }, [setRange]);

  const [health, setHealth] = useState<OtelHealth | null>(null);
  const [today, setToday] = useState<CostTodaySummary | null>(null);
  const [todayReachable, setTodayReachable] = useState(true);
  const [series, setSeries] = useState<CostSeriesPoint[]>([]);
  const [seriesReachable, setSeriesReachable] = useState(true);
  const [cache, setCache] = useState<CacheSavings | null>(null);

  const [spike, setSpike] = useState<SpikeFocus | null>(null);

  // Health probe (10s TTL) — drives the ChartCard ladder. Same idiom as Telemetry.
  useEffect(() => {
    let alive = true;
    async function probe() {
      try {
        const resp = await fetch("/api/health/otel");
        if (!resp.ok || !alive) return;
        setHealth((await resp.json()) as OtelHealth);
      } catch {
        /* leave health as-is → next probe corrects it */
      }
    }
    void probe();
    const id = setInterval(() => void probe(), 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // The FinOps data, refreshed on the shared cadence. The hero `today` is anchored
  // to local midnight (the dedicated route, no range param); the spend-over-time
  // bars + cache-ROI follow the picker via TIME_RANGE_TO_PROM.
  useEffect(() => {
    let alive = true;
    const promRange = TIME_RANGE_TO_PROM[range];

    async function loadToday() {
      try {
        const resp = await fetch("/api/otel/cost-today");
        if (!alive) return;
        if (resp.status === 503) return setTodayReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: CostTodaySummary };
        setToday(body.data);
        setTodayReachable(true);
      } catch {
        if (alive) setTodayReachable(false);
      }
    }

    async function loadSeries() {
      try {
        const resp = await fetch(`/api/otel/cost-series?range=${promRange}`);
        if (!alive) return;
        if (resp.status === 503) return setSeriesReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: CostSeriesPoint[] | null };
        setSeries(body.data ?? []);
        setSeriesReachable(true);
      } catch {
        if (alive) setSeriesReachable(false);
      }
    }

    async function loadCache() {
      try {
        const resp = await fetch(`/api/otel/cache-savings?range=${promRange}`);
        if (!alive) return;
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: CacheSavings | null };
        setCache(body.data ?? null);
      } catch {
        /* cache-ROI best-effort: the hero shows "—" rather than blocking. */
      }
    }

    void loadToday();
    void loadSeries();
    void loadCache();
    const id = setInterval(() => {
      void loadToday();
      void loadSeries();
      void loadCache();
    }, refreshIntervalMs(range));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [range]);

  // Spike-click drill: re-query that hour's by-ticket + by-model split (one
  // re-query with the hour window, layout spec §2 P-A).
  function onSpikeClick(epochSeconds: number) {
    const label = hourLabel(epochSeconds);
    setSpike({ t: epochSeconds, label, data: null });
    void (async () => {
      try {
        const resp = await fetch(
          `/api/otel/cost-at-hour?hour=${Math.floor(epochSeconds)}`,
        );
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: CostAtHour };
        // Only apply if this is still the focused spike (avoid a stale re-query
        // overwriting a newer click).
        setSpike((cur) =>
          cur && cur.t === epochSeconds ? { ...cur, data: body.data } : cur,
        );
      } catch {
        /* drill re-query failed → the strip shows its honest empty state. */
      }
    })();
  }

  // The hero's health gates on Prometheus reachability (the today/cache routes are
  // [prom]); layer the route-level 503 signal over the global probe.
  const promHealth = (reachable: boolean): OtelHealth | null =>
    health === null
      ? null
      : {
          ...health,
          prometheus: {
            ...health.prometheus,
            reachable: health.prometheus.reachable && reachable,
          },
        };

  const nSpikes = spikeCount(series);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-surface-0 p-5 text-fg">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">FinOps</h1>
          <p className="text-[12px] text-muted">
            How much did I spend today, and is that normal?
          </p>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={range}
          onValueChange={(v) => v && setRange(v as (typeof TIME_RANGES)[number])}
          aria-label="Time range"
        >
          {TIME_RANGES.map((r) => (
            <ToggleGroupItem key={r} value={r} className="text-[12px]">
              {TIME_RANGE_LABEL[r]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </header>

      {/* HERO — the full-width dollar+ROI band, the surface's ONE answer
          (Principle 1). Wrapped in a [prom] ChartCard so a no-Prometheus install
          shows the configure CTA, never a fabricated dollar. */}
      <ChartCard
        title="Today's spend"
        dataSource="[prom]"
        health={promHealth(todayReachable)}
        hasData={today !== null}
        bodyClassName="min-h-[120px] p-4"
      >
        <FinopsHero today={today} cache={cache} />
      </ChartCard>

      {/* P-A — spend-over-time hourly bars + spike markers. Spike bar click drills
          into that hour's by-ticket/by-model split (the strip below). */}
      <ChartCard
        title="Spend over time"
        dataSource="[prom]"
        health={promHealth(seriesReachable)}
        hasData={series.length > 0}
        bodyClassName="min-h-[260px] h-[min(40vh,320px)] p-3"
        headerExtra={
          nSpikes > 0 ? (
            <span
              className="font-mono text-[10px]"
              style={{ color: "var(--chart-4)" }}
            >
              {nSpikes} {nSpikes === 1 ? "spike" : "spikes"}
            </span>
          ) : undefined
        }
      >
        <SpendOverTimePanel points={series} onSpikeClick={onSpikeClick} />
      </ChartCard>

      {/* Spike drill strip — appears below P-A on a spike click. */}
      {spike && (
        <SpikeDrillStrip
          data={spike.data}
          hourLabel={spike.label}
          onClose={() => setSpike(null)}
        />
      )}
    </div>
  );
}
