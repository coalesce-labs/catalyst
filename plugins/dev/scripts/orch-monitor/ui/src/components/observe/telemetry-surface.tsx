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
import { useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import type { OtelHealth, TailResult, TailRow } from "@/lib/types";
import type { BoardPayload } from "@/board/types";
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
import { heroState } from "@/components/observe/hero-state";
import { isErrorRow, type TailWorkerRef } from "@/components/observe/tail-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

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
  const [range, setRange] = useAtom(timeRangeAtom);

  const [health, setHealth] = useState<OtelHealth | null>(null);
  const [tail, setTail] = useState<TailResult | null>(null);
  const [tailReachable, setTailReachable] = useState<boolean>(true);
  const [lastGoodMs, setLastGoodMs] = useState<number | null>(null);
  const [workers, setWorkers] = useState<TailWorkerRef[]>([]);

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

  const rows = tail?.rows ?? [];
  const { errorCount, errorRate } = useMemo(() => deriveErrorStats(rows), [rows]);

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
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-surface-0 p-5 text-fg">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Telemetry</h1>
          <p className="text-[12px] text-muted">
            Is work actually flowing right now?
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

      {/* HERO — full-width, top, the surface's ONE answer (Principle 1). */}
      <TelemetryHero
        state={state}
        freshnessMs={tail?.freshnessMs ?? null}
        errorCount={errorCount}
        errorRate={errorRate}
        lastGoodMs={lastGoodMs}
      />

      {/* P1 LIVE TAIL — grouped by worker, internally scrolled so the hero stays
          the first paint on small screens (~40vh cap, layout spec §5 #4). The
          ChartCard owns the unconfigured/unreachable/empty honesty states; the
          tail only renders the LIVE rows. */}
      <ChartCard
        title="Live tail — grouped by worker"
        dataSource="[loki]"
        health={health}
        hasData={rows.length > 0}
        bodyClassName="min-h-[320px] h-[min(52vh,520px)] p-3"
      >
        <LiveTail
          rows={rows}
          workers={workers}
          onOpenWorker={(workerName) => {
            // Drill (one click): worker → its history page (/worker/$id). A full-
            // document navigation hits the server's SPA fallback (the same path
            // the board's openDetail uses — router.tsx:48). The worker page then
            // resolves the CC session + its /api/ec-worker-history tail itself.
            window.location.assign(`/worker/${encodeURIComponent(workerName)}`);
          }}
        />
      </ChartCard>
    </div>
  );
}
