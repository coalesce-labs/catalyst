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
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";
import { HeaderActions } from "@/components/header-actions";
import type {
  OtelHealth,
  CostTodaySummary,
  CostSeriesPoint,
  CacheSavings,
  CostAtHour,
  CostMap,
  TokenSplit,
  CostValidationRow,
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
import { ExpensiveTicketsTable } from "@/components/observe/expensive-tickets-table";
import { CostBreakdownBars } from "@/components/observe/cost-breakdown-bars";
import { TokenDonutPanel } from "@/components/observe/token-donut-panel";
import { FinopsFooter } from "@/components/observe/finops-footer";
import { hourLabel, spikeCount } from "@/components/observe/finops-panels";
import {
  rankCostMap,
  hasTokenData,
  type CostDimension,
} from "@/components/observe/finops-breakdowns";
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

  // OBS-11 breakdown panels — each reads an EXISTING /api/otel/* route. The
  // `*Reachable` flags carry the route-level 503 over the global probe so a panel
  // degrades to STALE (not a fabricated empty) when Prometheus drops mid-flight.
  const [cost, setCost] = useState<CostMap>(null);
  const [costReachable, setCostReachable] = useState(true);
  const [byStage, setByStage] = useState<CostMap>(null);
  const [byStageReachable, setByStageReachable] = useState(true);
  const [byDim, setByDim] = useState<CostMap>(null);
  const [byDimReachable, setByDimReachable] = useState(true);
  const [costDim, setCostDim] = useState<CostDimension>("model");
  const [tokens, setTokens] = useState<TokenSplit | null>(null);
  const [tokensReachable, setTokensReachable] = useState(true);
  const [validation, setValidation] = useState<CostValidationRow[] | null>(null);

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

    // OBS-11 P-C (expensive tickets) + footer A4 (concentration) both ride this.
    async function loadCost() {
      try {
        const resp = await fetch(`/api/otel/cost?range=${promRange}`);
        if (!alive) return;
        if (resp.status === 503) return setCostReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: CostMap };
        setCost(body.data ?? null);
        setCostReachable(true);
      } catch {
        if (alive) setCostReachable(false);
      }
    }

    // OBS-11 P-B (cost by pipeline stage) — the OBS-9-routed costByTaskType.
    async function loadByStage() {
      try {
        const resp = await fetch(`/api/otel/cost-by-stage?range=${promRange}`);
        if (!alive) return;
        if (resp.status === 503) return setByStageReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: CostMap };
        setByStage(body.data ?? null);
        setByStageReachable(true);
      } catch {
        if (alive) setByStageReachable(false);
      }
    }

    // OBS-11 P-E (token type split) — the 4 buckets + cache hit rate.
    async function loadTokens() {
      try {
        const resp = await fetch(`/api/otel/tokens?range=${promRange}`);
        if (!alive) return;
        if (resp.status === 503) return setTokensReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: TokenSplit };
        setTokens(body.data);
        setTokensReachable(true);
      } catch {
        if (alive) setTokensReachable(false);
      }
    }

    // OBS-11 footer A8 — signal-vs-OTEL drift. Best-effort (footer shows "—").
    async function loadValidation() {
      try {
        const resp = await fetch(`/api/otel/cost-validation?range=${promRange}`);
        if (!alive) return;
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: CostValidationRow[] | null };
        setValidation(body.data ?? null);
      } catch {
        /* A8 best-effort: the footer shows "—" rather than blocking. */
      }
    }

    void loadToday();
    void loadSeries();
    void loadCache();
    void loadCost();
    void loadByStage();
    void loadTokens();
    void loadValidation();
    const id = setInterval(() => {
      void loadToday();
      void loadSeries();
      void loadCache();
      void loadCost();
      void loadByStage();
      void loadTokens();
      void loadValidation();
    }, refreshIntervalMs(range));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [range]);

  // P-D by-model/agent — separate effect so the model⇄agent toggle re-queries
  // without re-running the whole panel set. Reads /api/otel/cost-by-dim?dim=…
  useEffect(() => {
    let alive = true;
    const promRange = TIME_RANGE_TO_PROM[range];
    async function loadByDim() {
      try {
        const resp = await fetch(
          `/api/otel/cost-by-dim?dim=${costDim}&range=${promRange}`,
        );
        if (!alive) return;
        if (resp.status === 503) return setByDimReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: CostMap };
        setByDim(body.data ?? null);
        setByDimReachable(true);
      } catch {
        if (alive) setByDimReachable(false);
      }
    }
    void loadByDim();
    const id = setInterval(() => void loadByDim(), refreshIntervalMs(range));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [range, costDim]);

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

  // hasData gates for the OBS-11 breakdown ChartCards — true only when the
  // zero-filtered map / token split carries a real row (else the card shows the
  // honest empty state, never a fabricated bar).
  const costHasData = useMemo(() => rankCostMap(cost).length > 0, [cost]);
  const byStageHasData = useMemo(() => rankCostMap(byStage).length > 0, [byStage]);
  const byDimHasData = useMemo(() => rankCostMap(byDim).length > 0, [byDim]);
  const tokensHasData = useMemo(
    () => hasTokenData(tokens?.tokens ?? null),
    [tokens],
  );

  return (
    <div className="cat-overlay-scroll flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-surface-1 p-5 text-fg">
      {/* CTL-1018: surface header folded into the SINGLE breadcrumb row (OBSERVE
          › FinOps). Subtitle + time-range control move up. One header per surface. */}
      <HeaderActions>
        <span className="hidden text-[12px] text-muted-foreground lg:inline">
          How much did I spend today, and is that normal?
        </span>
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
      </HeaderActions>

      {/* HERO — the full-width dollar+ROI band, the surface's ONE answer
          (Principle 1). Wrapped in a [prom] ChartCard so a no-Prometheus install
          shows the configure CTA, never a fabricated dollar. */}
      <ChartCard
        title="Today's spend"
        dataSource="[prom]"
        health={promHealth(todayReachable)}
        hasData={today !== null}
        className="shrink-0"
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
        className="shrink-0"
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

      {/* Spike drill strip — appears below P-A on a spike click. Wrapped in a
          shrink-0 box so it keeps its natural height as a direct child of the
          scroll column (the column scrolls; the strip never collapses). */}
      {spike && (
        <div className="shrink-0">
          <SpikeDrillStrip
            data={spike.data}
            hourLabel={spike.label}
            onClose={() => setSpike(null)}
          />
        </div>
      )}

      {/* OBS-11 BREAKDOWN GRID — two columns below the hero+P-A (layout spec §2).
          Left = trend/where-it-went bars (by-stage, by-model/agent); right = the
          default table (P-C) + the proportional token donut (P-E). */}
      <div className="grid shrink-0 grid-cols-1 gap-4 lg:grid-cols-2">
        {/* P-C — expensive tickets table (the default view, Principle 10). */}
        <ChartCard
          title="Expensive tickets"
          dataSource="[prom]"
          health={promHealth(costReachable)}
          hasData={costHasData}
          bodyClassName="min-h-[300px] h-[340px] p-0"
        >
          <ExpensiveTicketsTable data={cost} />
        </ChartCard>

        {/* P-E — token type split (the ONE sanctioned donut, Principle 9 carve-out). */}
        <ChartCard
          title="Token type split"
          dataSource="[prom]"
          health={promHealth(tokensReachable)}
          hasData={tokensHasData}
          bodyClassName="min-h-[200px] h-[340px] p-4"
        >
          <TokenDonutPanel
            tokens={tokens?.tokens ?? null}
            cacheHitRate={tokens?.cacheHitRate ?? null}
          />
        </ChartCard>

        {/* P-B — cost by pipeline stage (ranked bar, NOT a 12-slice pie). */}
        <ChartCard
          title="Cost by pipeline stage"
          dataSource="[prom]"
          health={promHealth(byStageReachable)}
          hasData={byStageHasData}
          bodyClassName="min-h-[220px] h-[280px] p-2"
        >
          <CostBreakdownBars data={byStage} labelHeader="stage" />
        </ChartCard>

        {/* P-D — cost by model / agent (ranked bar + model⇄agent toggle). */}
        <ChartCard
          title="Cost by model / agent"
          dataSource="[prom]"
          health={promHealth(byDimReachable)}
          hasData={byDimHasData}
          bodyClassName="min-h-[220px] h-[280px] p-2"
          headerExtra={
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={costDim}
              onValueChange={(v) => v && setCostDim(v as CostDimension)}
              aria-label="Group cost by"
            >
              <ToggleGroupItem value="model" className="h-6 px-2 text-[10px]">
                model
              </ToggleGroupItem>
              <ToggleGroupItem value="agent" className="h-6 px-2 text-[10px]">
                agent
              </ToggleGroupItem>
            </ToggleGroup>
          }
        >
          <CostBreakdownBars
            data={byDim}
            labelHeader={costDim === "model" ? "model" : "agent"}
          />
        </ChartCard>
      </div>

      {/* FOOTER strip — A4 concentration · A8 drift · locked $/story-point.
          Wrapped in a shrink-0 box so it keeps its natural height as a direct
          child of the scroll column. */}
      <div className="shrink-0">
        <FinopsFooter cost={cost} validation={validation} />
      </div>
    </div>
  );
}
