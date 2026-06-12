// utilization-surface.tsx — the OBSERVE Utilization surface (OBS-16).
//
// "Am I getting value from the slots I'm paying for?" The surface leads with ONE
// hero number (slot occupancy %, from the AUTOTUNED maxParallel) and ONE loud named
// diagnostic — the STARVED/JAMMED pathology badge, the two HISTORICAL failure modes
// the surface exists to make impossible to miss (design §3.2). Below the badge, a
// flex-1 grid of ChartCards: the idle-between-phases list [board], the 429/overload
// sparkline [loki], the active-time ratio [prom], and two OBS-15-gated panels
// (occupancy timeline + quota burn) rendered as honest dashed LOCKED cards.
//
// LAYOUT (mirrors telemetry-surface.tsx, the proven non-collapsing structure): the
// hero + the pathology badge are full-width shrink-0 siblings ABOVE a
// `grid min-h-0 flex-1` wrapper, so they always render before any scroll and the
// ChartCards keep their fixed min-h footprint instead of collapsing to ~2px (the
// known hero-collapse bug — do NOT place ChartCards as direct children of the
// scroll column).
//
// HONESTY: the hero/badge/idle-list are board-backed → ALWAYS live (never gate on
// OTEL health). P_err [loki] and P_active [prom] degrade independently via the
// ChartCard ladder. The two deferred panels render the dashed "needs event-log
// reader · OBS-15" locked state — never blank, never fabricated.
import { useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { HeaderActions } from "@/components/header-actions";
import type { OtelHealth, OtelLogEntry } from "@/lib/types";
import type { BoardPayload, BoardConfig, BoardTicket } from "@/board/types";
import {
  timeRangeAtom,
  TIME_RANGES,
  TIME_RANGE_LABEL,
  refreshIntervalMs,
} from "@/lib/observe-store";
import { ChartCard } from "@/components/observe/chart-card";
import { UtilizationHero } from "@/components/observe/utilization-hero";
import { StarvedJammedBadge } from "@/components/observe/starved-jammed-badge";
import {
  pathology,
  occupancyPct,
  idleBetweenPhases,
  rateLimitErrors,
  rankCountMap,
  type IdleTicketInput,
  type CountRow,
} from "@/components/observe/utilization-kit";
import { errorTrendSparkline, barPercent } from "@/components/observe/telemetry-panels";
import { Sparkline } from "@/components/sparkline";
import { fmtRelativeDuration } from "@/lib/formatters";
import { typeSymbol } from "@/board/type-icon";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** The active-time payload from /api/otel/active-time (mirrors otel-queries
 *  ActiveTimeRatio). */
interface ActiveTimePayload {
  activeSecondsPerSecond: number;
}

/** A zero-capacity board config stand-in for first paint (before /api/board lands)
 *  — renders an honest 0% / SATURATED-free-of-0 rather than NaN. */
const EMPTY_CONFIG: BoardConfig = {
  maxParallel: 0,
  inFlight: 0,
  freeSlots: 0,
  active: 0,
  working: 0,
  stuck: 0,
  dead: 0,
};

export function UtilizationSurface() {
  const [range, setRange] = useAtom(timeRangeAtom);

  const [health, setHealth] = useState<OtelHealth | null>(null);
  const [config, setConfig] = useState<BoardConfig>(EMPTY_CONFIG);
  const [queueLen, setQueueLen] = useState<number>(0);
  const [tickets, setTickets] = useState<BoardTicket[]>([]);

  // P_err [loki] — the 429/overload api_error set (filtered client-side).
  const [errors, setErrors] = useState<OtelLogEntry[]>([]);
  const [errorsReachable, setErrorsReachable] = useState<boolean>(true);

  // P_active [prom] — the active-time ratio.
  const [activeTime, setActiveTime] = useState<ActiveTimePayload | null>(null);
  const [activeReachable, setActiveReachable] = useState<boolean>(true);

  // CTL-1040: throughput by work type [loki].
  const [throughputByType, setThroughputByType] = useState<Record<string, number> | null>(null);
  const [throughputByTypeReachable, setThroughputByTypeReachable] = useState<boolean>(true);

  // Health probe (10s TTL) — drives the ChartCard ladder for the [loki]/[prom]
  // panels. The board-backed hero/badge/idle-list never read it.
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

  // Board + OTEL panels, refreshed on the shared time-range cadence (NOW = 15s).
  useEffect(() => {
    let alive = true;
    // The aggregate OTEL panels read a ≥1h window even on the tight NOW (a 15m
    // window is too thin for a stable 429 trend / active-time rate — same pin
    // telemetry uses for its aggregate panels).
    const otelRange = range === "NOW" ? "1h" : "24h";

    async function loadBoard() {
      try {
        const resp = await fetch("/api/board");
        if (!resp.ok || !alive) return;
        const board = (await resp.json()) as BoardPayload;
        // The AUTOTUNED capacity — read straight off config, never a static file.
        setConfig(board.config);
        setQueueLen(board.queue.length);
        setTickets(board.tickets);
      } catch {
        /* board unavailable → keep the last-good config (hero degrades to it) */
      }
    }

    async function loadErrors() {
      try {
        const resp = await fetch(`/api/otel/errors?range=${otelRange}`);
        if (!alive) return;
        if (resp.status === 503) return setErrorsReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: OtelLogEntry[] | null };
        setErrors(body.data ?? []);
        setErrorsReachable(true);
      } catch {
        if (alive) setErrorsReachable(false);
      }
    }

    async function loadActiveTime() {
      try {
        const resp = await fetch(`/api/otel/active-time?range=${otelRange}`);
        if (!alive) return;
        if (resp.status === 503) return setActiveReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: ActiveTimePayload | null };
        setActiveTime(body.data ?? null);
        setActiveReachable(true);
      } catch {
        if (alive) setActiveReachable(false);
      }
    }

    // CTL-1040: throughput grouped by work type [loki].
    async function loadThroughputByType() {
      try {
        const resp = await fetch(`/api/otel/throughput-by-work-type?range=${otelRange}`);
        if (!alive) return;
        if (resp.status === 503) return setThroughputByTypeReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: Record<string, number> | null };
        setThroughputByType(body.data ?? null);
        setThroughputByTypeReachable(true);
      } catch {
        if (alive) setThroughputByTypeReachable(false);
      }
    }

    void loadBoard();
    void loadErrors();
    void loadActiveTime();
    void loadThroughputByType();
    const id = setInterval(() => {
      void loadBoard();
      void loadErrors();
      void loadActiveTime();
      void loadThroughputByType();
    }, refreshIntervalMs(range));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [range]);

  // ── derivations (all PURE, from the live autotuned config) ──────────────────
  const occPct = occupancyPct(config.inFlight, config.maxParallel);
  const path = pathology(config.freeSlots, queueLen);

  const idleRows = useMemo(() => {
    const inputs: IdleTicketInput[] = tickets.map((t) => ({
      id: t.id,
      phase: t.phase,
      workerStatus: t.workerStatus,
      activeState: t.activeState,
      currentPhaseSince: t.currentPhaseSince,
    }));
    return idleBetweenPhases(inputs);
  }, [tickets]);

  // P_err: filter the api_error set to the 429/overload class + its header trend.
  const rlErrors = useMemo(() => rateLimitErrors(errors), [errors]);
  const rlTrend = useMemo(() => errorTrendSparkline(rlErrors), [rlErrors]);

  // P_active: the computing fraction. The active-seconds-per-second is "slots' worth
  // of wall-clock busy"; divide by the busy-slot capacity (inFlight) to get the
  // genuine compute %. With inFlight=0 there are NO busy slots → an honest "0%
  // computing — no busy slots", never a fabricated number.
  const activeRate = activeTime?.activeSecondsPerSecond ?? 0;
  const hasBusySlots = config.inFlight > 0;
  const computingPct = hasBusySlots
    ? Math.max(0, Math.min(100, Math.round((activeRate / config.inFlight) * 100)))
    : 0;

  // CTL-1040: ranked throughput rows for the type panel.
  const throughputRows = useMemo<CountRow[]>(
    () => rankCountMap(throughputByType),
    [throughputByType],
  );

  // Per-panel health for the [loki]/[prom] cards (layer the per-route reachability
  // over the global probe — same idiom telemetry uses).
  const lokiHealth = (reachable: boolean): OtelHealth | null =>
    health === null
      ? null
      : { ...health, loki: { ...health.loki, reachable: health.loki.reachable && reachable } };
  const promHealth = (reachable: boolean): OtelHealth | null =>
    health === null
      ? null
      : {
          ...health,
          prometheus: { ...health.prometheus, reachable: health.prometheus.reachable && reachable },
        };

  return (
    <div className="cat-overlay-scroll flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-surface-1 p-5 text-fg">
      {/* CTL-1018: surface header folded into the SINGLE breadcrumb row (OBSERVE
          › Utilization). Subtitle + time-range control move up. One per surface. */}
      <HeaderActions>
        <span className="hidden text-[12px] text-muted-foreground lg:inline">
          Am I getting value from the slots I&apos;m paying for?
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

      {/* HERO — full-width, the ONE answer (occupancy %), before any scroll. */}
      <UtilizationHero
        occupancyPct={occPct}
        inFlight={config.inFlight}
        maxParallel={config.maxParallel}
        queueLen={queueLen}
        idleCount={idleRows.length}
      />

      {/* PATHOLOGY BADGE — full-width, directly under the hero, LOUD. The marquee
          diagnostic (STARVED/JAMMED). Board-backed → always live. */}
      <StarvedJammedBadge
        pathology={path}
        freeSlots={config.freeSlots}
        maxParallel={config.maxParallel}
        queueLen={queueLen}
        onAction={(target) => {
          // Cross-surface drill: STARVED → eligible set, JAMMED → FleetOps reconcile.
          // FleetOps ships its own surface later; until then a full-document nav to
          // the dashboard's health view is the closest existing destination.
          if (target === "eligible") {
            window.location.assign("/?surface=queue");
          } else {
            window.location.assign("/?surface=fleetops");
          }
        }}
      />

      {/* GRID — the flex-1 wrapper (NOT shrink-0 cards in the scroll column) so the
          ChartCards keep their fixed min-h footprint. 8px gap (Principle 7). */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-2">
        {/* P3 IDLE-BETWEEN-PHASES list [board] — the CTL-928 lane. Live = EMPTY
            (no workers) → the ChartCard renders the honest "no data in range" zero
            (CORRECT, not a bug). Board-backed → never gates on OTEL health. */}
        <ChartCard
          title="Idle between phases"
          dataSource="[board]"
          health={health}
          hasData={idleRows.length > 0}
          bodyClassName="min-h-[180px] h-[min(28vh,220px)] p-2"
        >
          <div className="flex h-full flex-col overflow-y-auto">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-border/40 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted/70">
              <span>Ticket</span>
              <span>Last phase</span>
              <span className="text-right">Idle for</span>
            </div>
            {idleRows.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => window.location.assign(`/worker/${encodeURIComponent(r.id)}`)}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 border-b border-border/20 py-1 text-left text-[12px] tabular-nums hover:bg-surface-2"
              >
                <span className="truncate font-mono">{r.id}</span>
                <span className="text-muted">{r.phase}</span>
                <span className="text-right text-muted">
                  {fmtRelativeDuration(r.idleForMs) ?? "—"}
                </span>
              </button>
            ))}
          </div>
        </ChartCard>

        {/* P_err 429/OVERLOAD rate [loki] — a header sparkline (60×32, no axes) +
            a one-line count. The api_error set is filtered to the rate-limit class
            client-side. Live → [] (no 429s in range → the healthy zero). */}
        <ChartCard
          title="429 / overload rate"
          dataSource="[loki]"
          health={lokiHealth(errorsReachable)}
          hasData={rlErrors.length > 0}
          bodyClassName="min-h-[180px] h-[min(28vh,220px)] p-3"
          headerExtra={
            rlTrend.length > 0 ? (
              <Sparkline
                points={rlTrend}
                width={60}
                height={32}
                color="var(--chart-4)"
                ariaLabel="429 / overload trend"
              />
            ) : undefined
          }
        >
          <div className="flex h-full flex-col items-center justify-center gap-1">
            <span className="font-mono text-3xl font-bold text-red">
              {rlErrors.length}
            </span>
            <span className="text-[12px] text-muted">
              rate-limit / overload {rlErrors.length === 1 ? "error" : "errors"} in range
            </span>
          </div>
        </ChartCard>

        {/* P_active ACTIVE-TIME ratio [prom] — a two-segment split bar (computing vs
            waiting) + the raw rate. Honest-low when idle: with inFlight=0 there are
            no busy slots → "0% computing — no busy slots". Gates on Prometheus
            reachability via the [prom] ladder. */}
        <ChartCard
          title="Active-time ratio"
          dataSource="[prom]"
          health={promHealth(activeReachable)}
          hasData
          bodyClassName="min-h-[180px] h-[min(28vh,220px)] p-3"
        >
          <div className="flex h-full flex-col justify-center gap-3">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-2xl font-bold text-fg">{computingPct}%</span>
              <span className="text-[12px] text-muted">computing</span>
            </div>
            {/* Two-segment split: computing (chart-2) vs waiting (chart-3). */}
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full"
                style={{ width: `${computingPct}%`, backgroundColor: "var(--chart-2)" }}
              />
              <div
                className="h-full flex-1"
                style={{ backgroundColor: "var(--chart-3)" }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted tabular-nums">
              <span>
                {hasBusySlots
                  ? `${config.inFlight} busy ${config.inFlight === 1 ? "slot" : "slots"}`
                  : "no busy slots"}
              </span>
              <span>active-time rate {activeRate.toFixed(3)} s/s</span>
            </div>
          </div>
        </ChartCard>

        {/* P_quota QUOTA BURN gauges [events] — LOCKED (OBS-15). Will be 5h / 7d /
            per-model semi-arc gauges from the latest account.ratelimit.sampled
            event (object-shaped {utilization,resets_at}; opus key may be ABSENT →
            render "opus: n/a"). Until the OBS-15 event-log reader: a dashed locked
            card, no fetch, no fake numbers. */}
        <ChartCard
          title="Quota burn"
          dataSource="[events]"
          health={health}
          locked={{ reason: "needs event-log reader", ticket: "OBS-15" }}
          bodyClassName="min-h-[180px] h-[min(28vh,220px)] p-3"
        />

        {/* CTL-1040: throughput by work type [loki] — completed tickets per type.
            Ranked count bars colored by the TYPE palette. Degrades via the ChartCard
            ladder when Loki is unconfigured. */}
        <ChartCard
          title="Throughput by work type"
          dataSource="[loki]"
          health={lokiHealth(throughputByTypeReachable)}
          hasData={throughputRows.length > 0}
          bodyClassName="min-h-[180px] h-[min(28vh,220px)] p-2"
          headerExtra={
            <span className="font-mono text-[10px] text-muted/60">since 2026-06-11</span>
          }
        >
          {(() => {
            const maxCount = throughputRows[0]?.count ?? 0;
            return (
              <div className="flex h-full flex-col gap-1">
                <div className="flex items-center justify-between px-3 text-[10px] text-muted/70">
                  <span>type · completed</span>
                  <span>ranked ↓</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-surface-2">
                  {throughputRows.map((row) => (
                    <div
                      key={row.label}
                      className="flex w-full items-center gap-3 border-b border-border/40 px-3 py-1.5 last:border-b-0"
                    >
                      <span className="w-24 shrink-0 truncate font-mono text-[11px] text-fg">
                        {row.label}
                      </span>
                      <span className="relative h-2.5 flex-1 overflow-hidden rounded-sm bg-surface-3">
                        <span
                          className="absolute inset-y-0 left-0 rounded-sm"
                          style={{
                            width: `${barPercent(row.count, maxCount)}%`,
                            backgroundColor: typeSymbol(row.label).color,
                          }}
                        />
                      </span>
                      <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg">
                        {row.count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </ChartCard>

        {/* P_occupancy OCCUPANCY TIMELINE [events] — LOCKED (OBS-15), full-width
            (bottom). Will be a stepped area of phase.scheduler.parallelism-sampled
            (bg_count vs maxParallel_current) + autotune-gauge against the SAMPLED
            autotune capacity line (never a static config read). Until OBS-15: a
            full-width dashed locked card with the dimmed stepped-area skeleton. */}
        <ChartCard
          title="Occupancy timeline"
          dataSource="[events]"
          health={health}
          locked={{ reason: "needs event-log reader", ticket: "OBS-15" }}
          className="lg:col-span-2"
          bodyClassName="min-h-[180px] h-[min(24vh,200px)] p-3"
        />
      </div>
    </div>
  );
}
