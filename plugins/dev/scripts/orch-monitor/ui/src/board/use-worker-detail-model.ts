// use-worker-detail-model.ts — the hoisted worker-detail v2 data model
// (CTL-925 / WORKER-DETAIL v2 Pass A §1A). v2 consolidates the page to ONE rail:
// the Diagnostics + Timeline groups move OUT of the body into the Shell's
// `railExtra` slot (rendered by WorkerDetailRoute, the PARENT of the body). But
// the live-tail-derived diagnostics (retries/rate-limit/turn/tool-errors) and the
// live StreamEvent buffer are needed by BOTH the rail (Diagnostics) AND the body
// (the Now view). To avoid a second SSE/signal/burn fetch, this hook owns the
// whole live model ONCE in WorkerDetailRoute and feeds both surfaces.
//
// It hoists: the phase signal (usePhaseSignal), the burn series (useBurnSeries),
// the live transcript buffer + connection state (useLiveTail), the derived
// liveDiagnostics, and the /api/health/otel snapshot (the ChartCard honesty
// ladder). All are pure React data hooks — no DOM, the same transports the v1
// body used (no new endpoints).

import { useEffect, useMemo, useState } from "react";
import type { BoardWorker } from "./types";
import type { StreamEvent, OtelHealth } from "@/lib/types";
import {
  readPhaseSignalFields,
  readWorkerScalars,
  isWorkerAlive,
  type PhaseSignalFields,
} from "./worker-detail-data";
import type { WorkerBurnSeries } from "./worker-burn-data";
import {
  appendLiveRows,
  deriveTailDiagnostics,
  parseStreamEvent,
  type TailDiagnostics,
} from "./live-tail-data";

export type LiveConnState = "idle" | "connecting" | "open" | "error";

// ── phase signal (verbatim, from /api/ec-worker/<ticket>/<phase>) ────────────
/** Fetch the verbatim phase signal. 404 (no on-disk signal) → null, so every
 *  signal-backed row dims honestly. */
export function usePhaseSignal(
  ticket: string | undefined,
  phase: string | undefined,
): { signal: Record<string, unknown> | null; loaded: boolean } {
  const [signal, setSignal] = useState<Record<string, unknown> | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!ticket || !phase) {
      setSignal(null);
      setLoaded(true);
      return;
    }
    let alive = true;
    setLoaded(false);
    void (async () => {
      try {
        const res = await fetch(
          `/api/ec-worker/${encodeURIComponent(ticket)}/${encodeURIComponent(phase)}`,
        );
        if (!alive) return;
        if (res.ok) {
          setSignal((await res.json()) as Record<string, unknown>);
        } else {
          setSignal(null);
        }
      } catch {
        if (alive) setSignal(null);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ticket, phase]);

  return { signal, loaded };
}

// ── live transcript tail (SSE /api/ec-worker-stream/<sessionId>) ─────────────
/** The live StreamEvent buffer + connection state. The SSE keeps appending; the
 *  buffer is the rolling tail (capped, oldest dropped). */
export function useLiveTail(
  sessionId: string | null,
  enabled: boolean,
): { buffer: StreamEvent[]; conn: LiveConnState } {
  const [buffer, setBuffer] = useState<StreamEvent[]>([]);
  const [conn, setConn] = useState<LiveConnState>("idle");

  useEffect(() => {
    setBuffer([]);
    if (!enabled || !sessionId) {
      setConn("idle");
      return;
    }
    setConn("connecting");
    const es = new EventSource(
      `/api/ec-worker-stream/${encodeURIComponent(sessionId)}`,
    );
    es.addEventListener("open", () => setConn("open"));
    es.addEventListener("stream-event", (ev: MessageEvent<string>) => {
      const row = parseStreamEvent(ev.data);
      if (row) setBuffer((prev) => appendLiveRows(prev, [row]));
    });
    es.onerror = () => setConn("error");
    return () => es.close();
  }, [sessionId, enabled]);

  return { buffer, conn };
}

// ── burn series (Prometheus /api/otel/burn/<sessionId>) ──────────────────────
/** The worker's REAL Prometheus cost/tokens/active sparklines for this run's CC
 *  session UUID. 503 / null id → null series (the chart degrades via ChartCard). */
export function useBurnSeries(
  sessionId: string | null,
  alive: boolean,
): WorkerBurnSeries | null {
  const [series, setSeries] = useState<WorkerBurnSeries | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSeries(null);
      return;
    }
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/otel/burn/${encodeURIComponent(sessionId)}?range=1h`,
        );
        if (stop) return;
        if (res.ok) {
          const body = (await res.json()) as { data: WorkerBurnSeries };
          setSeries(body.data ?? null);
        } else {
          setSeries(null);
        }
      } catch {
        if (!stop) setSeries(null);
      }
    };
    void load();
    const timer = alive ? setInterval(() => void load(), 30_000) : null;
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, alive]);

  return series;
}

// ── OTEL health (/api/health/otel) — the ChartCard honesty ladder ────────────
/** Fetch the OTEL health snapshot for the ChartCard honesty ladder. null until it
 *  loads (the card treats null as optimistic-live so first paint doesn't flash a
 *  degraded state). The detail route uses the board transport (not use-monitor),
 *  so it fetches its own copy here. */
export function useOtelHealth(): OtelHealth | null {
  const [health, setHealth] = useState<OtelHealth | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/health/otel");
        if (!alive) return;
        if (res.ok) setHealth((await res.json()) as OtelHealth);
      } catch {
        /* leave null → optimistic-live first paint */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return health;
}

// ── the consolidated model ───────────────────────────────────────────────────
export interface WorkerDetailModel {
  signal: Record<string, unknown> | null;
  fields: PhaseSignalFields | null;
  sessionId: string | null;
  alive: boolean;
  burnSeries: WorkerBurnSeries | null;
  liveBuffer: StreamEvent[];
  liveConn: LiveConnState;
  liveDiagnostics: TailDiagnostics | null;
  health: OtelHealth | null;
}

/**
 * The single worker-detail model, called ONCE in WorkerDetailRoute and fed to both
 * the Shell `railExtra` (Diagnostics) and the WorkerDetailBody (Now view + chart).
 * The live tail is subscribed once here; `liveDiagnostics` is null until the first
 * row arrives (so the rail stays honestly dimmed, never a fabricated 0/—).
 */
export function useWorkerDetailModel(worker: BoardWorker | undefined): WorkerDetailModel {
  const ticket = worker?.ticket;
  const phase = worker?.phase;
  const { signal } = usePhaseSignal(ticket, phase);
  const fields = useMemo(() => (signal ? readPhaseSignalFields(signal) : null), [signal]);
  const scalars = readWorkerScalars(worker);
  const alive = isWorkerAlive(worker);
  const sessionId = scalars.sessionId;

  const burnSeries = useBurnSeries(sessionId, alive);
  // The live tail stays subscribed while the page is open (the Now view + the rail
  // both read it); pause is a view concern in the Now panel, not a teardown.
  const { buffer: liveBuffer, conn: liveConn } = useLiveTail(sessionId, true);
  const health = useOtelHealth();

  const liveDiagnostics = useMemo<TailDiagnostics | null>(
    () => (liveBuffer.length > 0 ? deriveTailDiagnostics(liveBuffer) : null),
    [liveBuffer],
  );

  return {
    signal,
    fields,
    sessionId,
    alive,
    burnSeries,
    liveBuffer,
    liveConn,
    liveDiagnostics,
    health,
  };
}
