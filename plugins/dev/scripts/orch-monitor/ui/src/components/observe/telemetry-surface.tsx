// telemetry-surface.tsx — the OBSERVE Telemetry surface (OBS-6).
//
// "Is work actually flowing right now?" The surface is ONE hero status line
// (FLOWING/QUIET/ERRORING/DARK) over a worker-grouped live tail, both reading the
// live Loki pipe and refreshing on the shared OBSERVE time-range atom (NOW =
// 15s auto-refresh). EVERY panel is wrapped in <ChartCard> — the single honesty
// enforcement point: when Loki is unreachable the cards degrade together and the
// hero goes DARK, never a wall of blank panels (layout spec §4).
//
// The hero's three signals are derived HONESTLY from the same /api/otel/tail scan
// the live tail already does (freshness = newest line age; error-rate =
// api_error / api_request over the window) plus the /api/health/otel reachability
// probe — no fabricated numbers, and QUIET (idle, not erroring) is rendered
// cleanly (neutral, never amber).
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";
// CTL-989: the Telemetry surface is inside the unified router, so the worker
// drill-down is a client-side navigate (no full-document reload, left nav stays).
import { useNavigate } from "@tanstack/react-router";
import { HeaderActions } from "@/components/header-actions";
import type {
  OtelHealth,
  OtelLogEntry,
  ModelLatencyRow,
  TailResult,
  TailRow,
  EventsHeatmap,
} from "@/lib/types";
import type { BoardPayload, BoardWorker } from "@/board/types";
import {
  timeRangeAtom,
  TIME_RANGES,
  TIME_RANGE_LABEL,
  TIME_RANGE_TO_LOKI,
  refreshIntervalMs,
} from "@/lib/observe-store";
import { ChartCard } from "@/components/observe/chart-card";
import { TelemetryHero } from "@/components/observe/telemetry-hero";
import { LiveTail } from "@/components/observe/live-tail";
import { ErrorClustersPanel } from "@/components/observe/error-clusters-panel";
import { ToolMixPanel } from "@/components/observe/tool-mix-panel";
import { ModelLatencyPanel } from "@/components/observe/model-latency-panel";
import { errorTrendSparkline } from "@/components/observe/telemetry-panels";
import { Sparkline } from "@/components/sparkline";
import { heroState } from "@/components/observe/hero-state";
import { isErrorRow, type TailWorkerRef } from "@/components/observe/tail-group";
import { EventsHeatmapPanel } from "@/components/observe/events-heatmap-panel";
import type { HeatmapWorkerRef } from "@/components/observe/events-heatmap-data";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** Per-tool p50/p95 latency map from /api/otel/tool-latency. */
type ToolLatencyMap = Record<string, { p50Ms: number | null; p95Ms: number | null }>;

/** Count api_error and api_request rows in the tail window → the hero's error
 *  rate. Pure on the rows so the derivation is honest (no separate fabricated
 *  series): rate = errors / requests, or null when there were no requests to
 *  divide by (the hero then shows 0% and the state falls to QUIET/FLOWING). */
function deriveErrorStats(rows: TailRow[]): {
  errorCount: number;
  requestCount: number;
  errorRate: number | null;
} {
  let errorCount = 0;
  let requestCount = 0;
  for (const r of rows) {
    const name = r.eventName?.toLowerCase() ?? "";
    if (name.includes("api_request")) requestCount += 1;
    if (isErrorRow(r)) errorCount += 1;
  }
  const errorRate = requestCount > 0 ? errorCount / requestCount : null;
  return { errorCount, requestCount, errorRate };
}

export function TelemetrySurface() {
  const navigate = useNavigate();
  const [range, setRange] = useAtom(timeRangeAtom);

  const [health, setHealth] = useState<OtelHealth | null>(null);
  const [tail, setTail] = useState<TailResult | null>(null);
  const [tailReachable, setTailReachable] = useState<boolean>(true);
  const [lastGoodMs, setLastGoodMs] = useState<number | null>(null);
  // The board-worker subset both P1 (tail attribution) and P5 (heatmap rows)
  // consume. We keep the activeState/working flags so P5 can flag a `running`
  // worker that's gone silent (the early-stall signal); P1 only needs the join keys.
  const [workers, setWorkers] = useState<
    Pick<
      BoardWorker,
      "sessionId" | "ticket" | "phase" | "name" | "activeState" | "working"
    >[]
  >([]);

  // OBS-8 (TELEMETRY P5): events/min heatmap (workers × 15m buckets).
  const [heatmap, setHeatmap] = useState<EventsHeatmap | null>(null);
  const [heatmapReachable, setHeatmapReachable] = useState<boolean>(true);

  // OBS-7 panel data: P2 error clusters, P3 tool mix (counts + p95), P4 model
  // latency. Each reads a [loki] route; the ChartCard owns the honesty states so a
  // null/empty result just degrades that one card.
  const [errors, setErrors] = useState<OtelLogEntry[]>([]);
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  const [toolLatency, setToolLatency] = useState<ToolLatencyMap>({});
  const [modelRows, setModelRows] = useState<ModelLatencyRow[]>([]);
  const [errorsReachable, setErrorsReachable] = useState<boolean>(true);
  const [toolsReachable, setToolsReachable] = useState<boolean>(true);
  const [modelReachable, setModelReachable] = useState<boolean>(true);

  // Cross-panel drill (P3 tool / P4 model click → P1 tail filter). The nonce ref
  // lets a re-click of the SAME tool/model re-apply (a value-only change wouldn't
  // re-trigger the tail's effect).
  const [focusFilter, setFocusFilter] = useState<{
    tool?: string;
    eventType?: string;
    errorsOnly?: boolean;
    nonce: number;
  } | null>(null);
  const focusNonce = useRef(1);

  // Health probe (10s TTL) — drives the ChartCard ladder AND the hero DARK state.
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

  // Tail + board workers, refreshed on the shared time-range cadence (NOW = 15s).
  useEffect(() => {
    let alive = true;
    const lokiRange = TIME_RANGE_TO_LOKI[range];

    async function loadTail() {
      try {
        const resp = await fetch(`/api/otel/tail?range=${lokiRange}`);
        if (!alive) return;
        if (resp.status === 503) {
          // Loki not configured / unreachable → hero goes DARK via tailReachable.
          setTailReachable(false);
          return;
        }
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: TailResult };
        setTail(body.data);
        setTailReachable(true);
        setLastGoodMs(Date.now());
      } catch {
        if (alive) setTailReachable(false);
      }
    }

    async function loadWorkers() {
      try {
        const resp = await fetch("/api/board");
        if (!resp.ok || !alive) return;
        const board = (await resp.json()) as BoardPayload;
        setWorkers(
          board.workers.map((w) => ({
            sessionId: w.sessionId,
            ticket: w.ticket,
            phase: w.phase,
            name: w.name,
            activeState: w.activeState,
            working: w.working,
          })),
        );
      } catch {
        /* board unavailable → tail still renders, just unattributed */
      }
    }

    void loadTail();
    void loadWorkers();
    const id = setInterval(() => {
      void loadTail();
      void loadWorkers();
    }, refreshIntervalMs(range));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [range]);

  // P2/P3/P4 panels, refreshed on the shared cadence. These are AGGREGATE panels
  // (clusters / p95 / model latency) so they read a ≥1h window even when the hero/
  // tail are on the tight NOW (15m) scan — a 15m window is too thin for a stable
  // p95 (design §3.1 pins P2/P3 to range=1h). NOW → 1h; the longer ranges pass
  // through the same Loki duration the tail uses.
  useEffect(() => {
    let alive = true;
    const lokiRange = range === "NOW" ? "1h" : TIME_RANGE_TO_LOKI[range];

    async function loadErrors() {
      try {
        const resp = await fetch(`/api/otel/errors?range=${lokiRange}`);
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

    async function loadTools() {
      try {
        const [countsResp, latResp] = await Promise.all([
          fetch(`/api/otel/tools?range=${lokiRange}`),
          fetch(`/api/otel/tool-latency?range=${lokiRange}`),
        ]);
        if (!alive) return;
        if (countsResp.status === 503) {
          setToolsReachable(false);
          return;
        }
        if (countsResp.ok) {
          const body = (await countsResp.json()) as { data: Record<string, number> | null };
          setToolCounts(body.data ?? {});
          setToolsReachable(true);
        }
        // tool-latency is best-effort: a 503/empty just means the bars sort with
        // no p95 (counts-only), never blocks the panel.
        if (latResp.ok) {
          const body = (await latResp.json()) as { data: ToolLatencyMap | null };
          setToolLatency(body.data ?? {});
        }
      } catch {
        if (alive) setToolsReachable(false);
      }
    }

    async function loadModelLatency() {
      try {
        const resp = await fetch(`/api/otel/model-latency?range=${lokiRange}`);
        if (!alive) return;
        if (resp.status === 503) return setModelReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: ModelLatencyRow[] | null };
        setModelRows(body.data ?? []);
        setModelReachable(true);
      } catch {
        if (alive) setModelReachable(false);
      }
    }

    // P5 heatmap window: wide enough for several 15m columns. On NOW we pin a 6h
    // window (≈24 buckets) so a worker's recent-vs-earlier activity is legible; the
    // longer ranges pass through the same Loki duration the other aggregate panels
    // use (capped at 7d by Loki retention via TIME_RANGE_TO_LOKI).
    async function loadHeatmap() {
      const heatmapRange = range === "NOW" ? "6h" : TIME_RANGE_TO_LOKI[range];
      try {
        const resp = await fetch(`/api/otel/events-heatmap?range=${heatmapRange}`);
        if (!alive) return;
        if (resp.status === 503) return setHeatmapReachable(false);
        if (!resp.ok) return;
        const body = (await resp.json()) as { data: EventsHeatmap | null };
        setHeatmap(body.data ?? null);
        setHeatmapReachable(true);
      } catch {
        if (alive) setHeatmapReachable(false);
      }
    }

    void loadErrors();
    void loadTools();
    void loadModelLatency();
    void loadHeatmap();
    const id = setInterval(() => {
      void loadErrors();
      void loadTools();
      void loadModelLatency();
      void loadHeatmap();
    }, refreshIntervalMs(range));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [range]);

  const rows = tail?.rows ?? [];
  const { errorCount, errorRate } = useMemo(() => deriveErrorStats(rows), [rows]);

  // The board-worker subset, projected to the two ref shapes the panels need.
  // P1 wants the join keys (TailWorkerRef); P5 wants the row label + a `running`
  // flag (active OR working, and not dead) so a silent running worker is flagged.
  const tailWorkers = useMemo<TailWorkerRef[]>(
    () =>
      workers.map((w) => ({
        sessionId: w.sessionId,
        ticket: w.ticket,
        phase: w.phase,
        name: w.name,
      })),
    [workers],
  );
  const heatmapWorkers = useMemo<HeatmapWorkerRef[]>(
    () =>
      workers.map((w) => ({
        sessionId: w.sessionId,
        // Same `ticket·phase` label shape the tail's worker headers use.
        label: `${w.ticket}·${w.phase}`,
        name: w.name,
        running: w.activeState !== "dead" && (w.activeState === "active" || w.working),
      })),
    [workers],
  );

  // The P2 header trend (24h error-count sparkline) + per-panel reachability for
  // the ChartCard health, layered over the global /api/health/otel probe.
  const errorTrend = useMemo(() => errorTrendSparkline(errors), [errors]);
  const lokiHealth = (reachable: boolean): OtelHealth | null =>
    health === null
      ? null
      : { ...health, loki: { ...health.loki, reachable: health.loki.reachable && reachable } };

  // Loki reachability for the hero: health probe OR the tail's own 503 signal.
  // health.loki.reachable is authoritative once the probe resolves; until then
  // the tail's success is an optimistic stand-in (no DARK flash on first paint).
  const lokiReachable =
    health === null ? (tailReachable ? null : false) : health.loki.reachable && tailReachable;

  const state = heroState({
    lokiReachable,
    configured: health?.configured ?? true,
    freshnessMs: tail?.freshnessMs ?? null,
    errorRate,
  });

  return (
    <div className="cat-overlay-scroll flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-surface-1 p-5 text-fg">
      {/* CTL-1018: the surface's own header bar is GONE — the breadcrumb row names
          it (OBSERVE › Telemetry). Its subtitle + time-range control move into that
          SINGLE header row. One header per surface. */}
      <HeaderActions>
        <span className="hidden text-[12px] text-muted-foreground lg:inline">
          Is work actually flowing right now?
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

      {/* HERO — full-width, top, the surface's ONE answer (Principle 1). */}
      <TelemetryHero
        state={state}
        freshnessMs={tail?.freshnessMs ?? null}
        errorCount={errorCount}
        errorRate={errorRate}
        lastGoodMs={lastGoodMs}
      />

      {/* GRID — responsive 2-column (layout spec §2). Left col: P1 (tall) then the
          P5 slot (OBS-8); right col: P2, P3, P4. Collapses to one column on
          <1024px with the tail first after the hero. 8px gap (Principle 7). */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-2">
        {/* P1 LIVE TAIL — grouped by worker, spans both grid rows on the left.
            Internally scrolled so the hero stays the first paint on small screens
            (~40vh cap, layout spec §5 #4). The ChartCard owns the
            unconfigured/unreachable/empty honesty states; the tail renders LIVE rows. */}
        <ChartCard
          title="Live tail — grouped by worker"
          dataSource="[loki]"
          health={health}
          hasData={rows.length > 0}
          className="lg:row-span-3"
          bodyClassName="min-h-[320px] h-[min(40vh,360px)] lg:h-auto p-3"
        >
          <LiveTail
            rows={rows}
            workers={tailWorkers}
            focusFilter={focusFilter}
            onOpenWorker={(workerName) => {
              // CTL-989: drill (one click) worker → its history page (/worker/$id)
              // via a CLIENT-SIDE router navigate — the left nav stays, no reload.
              // The worker page resolves the CC session + its /api/ec-worker-history
              // tail itself. `from: "board"` is the valid DetailFrom; route-surface
              // keys the nav highlight off the /worker/ path kind (→ Workers).
              void navigate({
                to: "/worker/$id",
                params: { id: workerName },
                search: (prev) => ({ ...prev, from: "board" }),
              });
            }}
          />
        </ChartCard>

        {/* P2 API ERRORS by (error string + model) — bar rows + a 24h error-count
            sparkline in the header (60×32, no axes — Principle 4 / §5 #2). Errors
            are usually EMPTY (the healthy case) → the ChartCard renders the honest
            "no data in range", which is CORRECT, not a bug. Row → request modal. */}
        <ChartCard
          title="API errors"
          dataSource="[loki]"
          health={lokiHealth(errorsReachable)}
          hasData={errors.length > 0}
          bodyClassName="min-h-[180px] h-[min(28vh,220px)] p-2"
          headerExtra={
            errorTrend.length > 0 ? (
              <Sparkline
                points={errorTrend}
                width={60}
                height={32}
                color="var(--chart-4)"
                ariaLabel="error trend"
              />
            ) : undefined
          }
        >
          <ErrorClustersPanel entries={errors} />
        </ChartCard>

        {/* P3 TOOLS by TOTAL TIME (count × p95), not call count — a slow tool used
            10× beats a fast tool used 1000× (Principle 2). Row → P1 tail filtered
            to that tool. */}
        <ChartCard
          title="Tools — by total time"
          dataSource="[loki]"
          health={lokiHealth(toolsReachable)}
          hasData={Object.keys(toolCounts).length > 0}
          bodyClassName="min-h-[180px] h-[min(28vh,220px)] p-2"
        >
          <ToolMixPanel
            counts={toolCounts}
            latency={toolLatency}
            onSelectTool={(tool) =>
              setFocusFilter({ tool, nonce: focusNonce.current++ })
            }
          />
        </ChartCard>

        {/* P4 MODEL LATENCY p50/p95 + error% by model. Row → P1 tail filtered to
            that model (errors-only when the model is erroring — design §3.1). */}
        <ChartCard
          title="Model latency"
          dataSource="[loki]"
          health={lokiHealth(modelReachable)}
          hasData={modelRows.length > 0}
          bodyClassName="min-h-[180px] h-[min(28vh,220px)] p-2"
        >
          <ModelLatencyPanel
            rows={modelRows}
            onSelectModel={(model) => {
              const row = modelRows.find((r) => r.model === model);
              const erroring = row?.errorRate !== null && (row?.errorRate ?? 0) > 0.02;
              // No model filter axis on the tail; an erroring model drills to
              // errors-only, otherwise this is a soft focus (no-op filter).
              setFocusFilter({ errorsOnly: erroring, nonce: focusNonce.current++ });
            }}
          />
        </ChartCard>

        {/* P5 EVENTS/MIN HEATMAP — workers × 15m time buckets (OBS-8). Sits
            bottom-left under the tall P1 on desktop (layout spec §2); rows = board
            worker sessions (so a SILENT running worker still gets a row — the
            early-stall signal), columns = 15m windows, cell opacity = events that
            window. dataSource="[loki+board]": Loki gates the cell DATA but the
            board-sourced row headers render even when Loki is down (design §4) — so
            the card never goes fully blank. Cell click → tail at that window; a
            running-but-silent row → the worker page (the FleetOps stuck cross-link
            available today, design §3.1). */}
        <ChartCard
          title="Events / min — workers × time"
          dataSource="[loki+board]"
          health={lokiHealth(heatmapReachable)}
          hasData={heatmapWorkers.length > 0 || (heatmap?.cells.length ?? 0) > 0}
          bodyClassName="min-h-[180px] h-[min(28vh,220px)] p-2"
        >
          <EventsHeatmapPanel
            payload={heatmap}
            workers={heatmapWorkers}
            onCellClick={(sessionId) => {
              // Drill (progressive disclosure): focus the P1 tail on this worker's
              // session. The tail's worker filter keys off sessionId (tail-group's
              // bucketKeyFactory), so a soft focus re-surfaces that worker's rows.
              // TODO(OBS-8 follow-up): scope the focus to the clicked 15m window
              // once the tail accepts a time-bound filter (today it shows the whole
              // current scan).
              setFocusFilter({ eventType: "", nonce: focusNonce.current++ });
              void sessionId;
            }}
            onStallClick={(sessionId) => {
              // A running-but-silent worker → its history page (the closest existing
              // FleetOps stuck-list cross-link). Find the worker name for the
              // /worker/$id route; fall back to the session id.
              const worker = workers.find((w) => w.sessionId === sessionId);
              const target = worker?.name ?? sessionId;
              window.location.assign(`/worker/${encodeURIComponent(target)}`);
            }}
          />
        </ChartCard>
      </div>
    </div>
  );
}
