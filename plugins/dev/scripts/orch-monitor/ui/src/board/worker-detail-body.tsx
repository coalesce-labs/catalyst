// worker-detail-body.tsx — the worker detail PAGE body (CTL-914 / DETAIL3),
// dropped into the shared <Shell> <DetailBody> slot by WorkerDetailRoute. It is
// the live-tail-console framing's RESIDENT-DATA skeleton plus the REAL Loki
// `[history]` tail. Plane-A only: the resident BoardWorker, the verbatim
// phase-<phase>.json signal (BFF /api/ec-worker/<ticket>/<phase>), and the
// claude-code Loki stream keyed on the CC session UUID.
//
// What ships here (design §5, "Day-one reality"):
//   • header strip — signal-served model (AVAILABLE-NOW), bg_job_id/attempt/gen
//     dimmed NEEDS-PLUMBING, ring grey on death with ZERO layout reflow
//   • DIAGNOSTICS rail — liveness (now−lastActiveMs) + stale-bg gate (idle/90s),
//     retries/rate-limit/tool-errors/turn/revive-budget/heartbeat dimmed
//   • PHASE TIMESTAMPS — THIS run's phases only
//   • SIGNAL panel — the raw phase signal JSON + a copy button
//   • [history] Loki tail — REAL today, readable hours after the worker died
//
// The live `[● live]` tab and the Burn Strip trail in DETAIL7/DETAIL6 and
// degrade gracefully — their absence is an honest disabled tab, never a blank.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardWorker } from "./types";
import type { StreamEvent } from "@/lib/types";
import {
  deriveLiveness,
  deriveStaleBgGate,
  readPhaseSignalFields,
  resolveHeaderModel,
  readRunPhaseTimestamps,
  readWorkerScalars,
  isWorkerAlive,
  resolveElapsed,
  type PhaseSignalFields,
  type LivenessLevel,
} from "./worker-detail-data";
import {
  buildBurnTiles,
  deriveIdleRatio,
  type WorkerBurnSeries,
  type BurnTile,
} from "./worker-burn-data";
import {
  appendLiveRows,
  resolvePausedView,
  deriveFooterCounters,
  deriveTailDiagnostics,
  resolveLiveTerminalRows,
  parseStreamEvent,
  type TailDiagnostics,
} from "./live-tail-data";
import { LIVE_CYAN } from "./detail-chrome";
import { Sparkline } from "../components/sparkline";
import { fmtCost, fmtTokens } from "@/lib/formatters";

// ── tokens (mirror Shell.tsx's inline-`C` palette) ──────────────────────────
const C = {
  s1: "#111318",
  s2: "#161a21",
  s3: "#1c222b",
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  green: "#39d07a",
  yellow: "#e0b341",
  red: "#ef5d5d",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

const LIVENESS_COLOR: Record<LivenessLevel, string> = {
  green: C.green,
  yellow: C.yellow,
  red: C.red,
  unknown: C.fgDim,
};

// ── the Loki history tail row (server's WorkerHistoryRow, mirrored) ──────────
// One parsed claude-code OTEL log line. The server endpoint
// /api/ec-worker-history/<sessionId> returns these newest-first.
interface WorkerHistoryRow {
  ts: number;
  eventName: string | null;
  toolName: string | null;
  toolInput: string | null;
  durationMs: number | null;
  costUsd: number | null;
  tokens: number | null;
  model: string | null;
  success: boolean | null;
}

type HistoryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; rows: WorkerHistoryRow[] }
  | { kind: "unavailable" } // Loki not configured (503) — degrade honestly
  | { kind: "error" };

// ── data hooks ───────────────────────────────────────────────────────────────

/** Fetch the verbatim phase signal for this run from the BFF ec-worker endpoint.
 *  404 (no on-disk signal) → null, so every signal-backed row dims honestly. */
function usePhaseSignal(
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
          setSignal(null); // 404 → no signal on disk; rows dim
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

/** Lazily fetch the Loki history tail (only when the [history] tab is opened).
 *  REAL today — a dead worker's transcript is readable hours later. */
function useHistoryTail(sessionId: string | null, enabled: boolean): {
  state: HistoryState;
  reload: () => void;
} {
  const [state, setState] = useState<HistoryState>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setState({ kind: "idle" });
      return;
    }
    let alive = true;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const res = await fetch(
          `/api/ec-worker-history/${encodeURIComponent(sessionId)}?range=24h`,
        );
        if (!alive) return;
        if (res.status === 503) {
          setState({ kind: "unavailable" });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error" });
          return;
        }
        const body = (await res.json()) as { data: WorkerHistoryRow[] };
        setState({ kind: "loaded", rows: body.data ?? [] });
      } catch {
        if (alive) setState({ kind: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { state, reload };
}

// ── the live transcript tail (CTL-918 / DETAIL7) ──────────────────────────────
// Consumes the BFF live SSE endpoint /api/ec-worker-stream/<sessionId> (BFF5,
// CTL-887) — a tail of the running agent's ~/.claude/projects/*/<sessionId>.jsonl
// transcript, framed as `event: stream-event` with a StreamEvent JSON payload
// (and an `event: open` greeting on connect). Rows accumulate in a rolling
// buffer via the PURE appendLiveRows (capped, oldest-dropped). The connection
// status drives the never-blank MVP fallback: while `error`/before the first
// row, the terminal still renders one derived row (see resolveLiveTerminalRows).
//
// PAUSE decouples view from data: the SSE keeps appending to `buffer` regardless
// of the pause flag — pause only freezes the VISIBLE slice (resolvePausedView),
// and resume replays the gap. We never tear down the EventSource on pause.
type LiveConnState = "idle" | "connecting" | "open" | "error";

interface LiveTail {
  buffer: StreamEvent[];
  conn: LiveConnState;
}

function useLiveTail(sessionId: string | null, enabled: boolean): LiveTail {
  const [buffer, setBuffer] = useState<StreamEvent[]>([]);
  const [conn, setConn] = useState<LiveConnState>("idle");

  useEffect(() => {
    // Reset the buffer whenever the session changes or the tab closes so a
    // different run's transcript never bleeds into this one.
    setBuffer([]);
    if (!enabled || !sessionId) {
      setConn("idle");
      return;
    }
    setConn("connecting");
    const es = new EventSource(
      `/api/ec-worker-stream/${encodeURIComponent(sessionId)}`,
    );
    // The server greets with `event: open` once the transcript path resolves.
    es.addEventListener("open", () => setConn("open"));
    // Each growth poll emits zero or more `event: stream-event` frames.
    es.addEventListener("stream-event", (ev: MessageEvent<string>) => {
      const row = parseStreamEvent(ev.data);
      if (row) setBuffer((prev) => appendLiveRows(prev, [row]));
    });
    // EventSource auto-reconnects on transient errors; we surface the error
    // state so the MVP fallback row renders, then it recovers silently.
    es.onerror = () => setConn("error");
    return () => es.close();
  }, [sessionId, enabled]);

  return { buffer, conn };
}

/** Fetch the worker Burn Strip's REAL Prometheus sparklines for this run's CC
 *  session UUID (CTL-917). REAL today — no new plumbing, the same OTEL pipeline
 *  the board cost strip reads. A 503 (Prometheus not configured) or a null id
 *  yields `null` series, and the strip falls back to the resident BoardWorker
 *  scalars — never a blank chart. Polls while the worker is alive so the
 *  sparkline grows; stops once it dies (the series freezes at its final shape). */
function useBurnSeries(
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
          setSeries(null); // 503 / 4xx → resident-scalar fallback
        }
      } catch {
        if (!stop) setSeries(null);
      }
    };
    void load();
    // Refresh every 30s while alive (matches the Prometheus fetcher cache TTL).
    const timer = alive ? setInterval(() => void load(), 30_000) : null;
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, alive]);

  return series;
}

// ── small presentational atoms ───────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        font: `10px ${C.mono}`,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: C.fgMuted,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

/** A diagnostics row. `plumbed=false` dims it and appends the honest
 *  NEEDS-PLUMBING marker — NEVER a fabricated value (e.g. a fake `2/3`). */
function DiagRow({
  label,
  value,
  plumbed = true,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  plumbed?: boolean;
  accent?: string;
}) {
  return (
    <div
      data-diag-row={label}
      data-plumbed={plumbed}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        padding: "3px 0",
        fontSize: 12,
      }}
    >
      <span style={{ color: C.fgMuted }}>{label}</span>
      <span
        style={{
          font: `11px ${C.mono}`,
          color: plumbed ? (accent ?? C.fg) : C.fgDim,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {plumbed ? value : <span title="needs plumbing">— ↯</span>}
      </span>
    </div>
  );
}

function fmtIdle(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

// CTL-915 (DETAIL4): the header elapsed reads at second precision — `14m02s`,
// `1h02m`, `48s` — so the exact wall-clock from startedAt is visible to the
// second (the runtimeMs floor only updates coarsely). null → em-dash, never 0s.
function fmtElapsed(ms: number | null): string {
  if (ms == null) return "—";
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// ── header strip ─────────────────────────────────────────────────────────────
function HeaderStrip({
  worker,
  signal,
  alive,
}: {
  worker: BoardWorker | undefined;
  signal: PhaseSignalFields | null;
  alive: boolean;
}) {
  const model = resolveHeaderModel(signal, worker);
  const status = signal?.status ?? worker?.status ?? "—";
  // A 1s clock so the wall-clock elapsed stays live while the page is open. It
  // freezes naturally on death because resolveElapsed is driven by startedAt and
  // the worker stops advancing — but we keep ticking so a still-alive worker's
  // elapsed reads to the second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // CTL-915 (DETAIL4): exact wall-clock elapsed from BoardWorker.startedAt (BFF6),
  // falling back to the coarser runtimeMs floor only when startedAt is absent.
  const elapsed = resolveElapsed(worker?.startedAt, worker?.runtimeMs, now);
  // Ring colour: cyan iff alive, frozen grey on death — the SAME DOM either way
  // (no conditional unmount) so death causes zero layout reflow.
  const ringColor = alive ? LIVE_CYAN : C.fgDim;
  return (
    <div
      data-worker-header
      data-alive={alive}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        background: C.s1,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
      }}
    >
      <span
        data-worker-ring={alive ? "live" : "frozen"}
        style={{
          width: 11,
          height: 11,
          borderRadius: "50%",
          border: `2px solid ${ringColor}`,
          flex: "0 0 auto",
        }}
      />
      <span style={{ font: `11px ${C.mono}`, color: C.fgMuted }}>{worker?.phase ?? "phase —"}</span>
      <span data-worker-status style={{ font: `12px ${C.mono}`, color: C.fg, fontWeight: 600 }}>
        {status}
      </span>
      <span style={{ flex: 1 }} />
      {/* model: AVAILABLE-NOW via the signal, dims until the signal lands */}
      <span data-worker-model data-plumbed={model != null} style={{ font: `11px ${C.mono}`, color: model != null ? C.fg : C.fgDim }}>
        model {model ?? "—"}
      </span>
      {/* bg_job_id / attempt / gen: NEEDS-PLUMBING (in the signal, surfaced via the
          BFF ec-worker endpoint — dimmed when the signal hasn't supplied them) */}
      <span data-worker-bgjob data-plumbed={signal?.bgJobId != null} style={{ font: `11px ${C.mono}`, color: signal?.bgJobId != null ? C.fg : C.fgDim }}>
        bg_job_id {signal?.bgJobId ?? "— ↯"}
      </span>
      <span data-worker-attempt data-plumbed={signal?.attempt != null} style={{ font: `11px ${C.mono}`, color: signal?.attempt != null ? C.fg : C.fgDim }}>
        attempt {signal?.attempt ?? "— ↯"}
      </span>
      <span data-worker-gen data-plumbed={signal?.generation != null} style={{ font: `11px ${C.mono}`, color: signal?.generation != null ? C.fg : C.fgDim }}>
        gen {signal?.generation ?? "— ↯"}
      </span>
      {/* elapsed: exact wall-clock from startedAt (BFF6); falls back to the
          runtimeMs floor only when startedAt is absent. `wall-clock` is the
          plumbed/precise reading; `runtime-floor` is dimmer (coarse fallback);
          `none` dims to an em-dash, never a fabricated 0s. */}
      <span
        data-worker-elapsed
        data-elapsed-source={elapsed.source}
        data-plumbed={elapsed.source === "wall-clock"}
        title={
          elapsed.source === "wall-clock"
            ? "exact wall-clock elapsed (from startedAt)"
            : elapsed.source === "runtime-floor"
              ? "runtimeMs floor — startedAt not yet on the worker"
              : "no elapsed source"
        }
        style={{ font: `11px ${C.mono}`, color: elapsed.source === "wall-clock" ? C.fg : C.fgDim }}
      >
        elapsed {fmtElapsed(elapsed.ms)}
      </span>
    </div>
  );
}

// ── DIAGNOSTICS rail (the reason this is a direct route) ─────────────────────
function DiagnosticsRail({
  worker,
  live,
}: {
  worker: BoardWorker | undefined;
  /** CTL-918 (DETAIL7): retries/rate-limit/turn/tool-error counts derived from
   *  the live tail's received rows. null (no live rows yet) keeps those rows
   *  dimmed exactly as DETAIL3 left them — never a fabricated count. */
  live: TailDiagnostics | null;
}) {
  // A ticking clock so liveness/idle stay fresh while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const lastActiveMs = worker?.lastActiveMs ?? null;
  const liveness = deriveLiveness(lastActiveMs, now);
  const gate = deriveStaleBgGate(lastActiveMs, now);
  // The live rows light up the tail-derived rows; absent the stream they stay
  // dimmed (plumbed:false) exactly as before — the DETAIL3 honest dim.
  const plumbed = live?.plumbed ?? false;

  return (
    <div data-worker-diagnostics style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
      <SectionHeading>Diagnostics</SectionHeading>
      <DiagRow
        label="liveness"
        plumbed={liveness.level !== "unknown"}
        accent={LIVENESS_COLOR[liveness.level]}
        value={
          <>
            <span
              style={{ width: 8, height: 8, borderRadius: "50%", background: LIVENESS_COLOR[liveness.level], display: "inline-block" }}
            />
            {fmtIdle(liveness.idleMs)} idle
          </>
        }
      />
      <DiagRow
        label="stale-bg gate"
        accent={gate.tripped ? C.red : C.green}
        value={`${fmtIdle(gate.idleMs)} / ${Math.round(gate.thresholdMs / 1000)}s ${gate.idleMs == null ? "" : gate.tripped ? "TRIPPED" : "ok"}`}
        plumbed={gate.idleMs != null}
      />
      {/* CTL-918 (DETAIL7): these light up from the SAME live rows the tail shows
          (previously dimmed NEEDS-PLUMBING in DETAIL3). They stay dimmed until
          the live stream delivers a row — never a fabricated 2/3. */}
      <DiagRow
        label="retries"
        plumbed={plumbed}
        accent={live && live.retries > 0 ? C.yellow : undefined}
        value={live?.retries ?? null}
      />
      <DiagRow
        label="rate-limit"
        plumbed={plumbed}
        accent={live && live.rateLimit > 0 ? C.red : undefined}
        value={live?.rateLimit ?? null}
      />
      <DiagRow
        label="tool-errors"
        plumbed={plumbed}
        accent={live && live.toolErrors > 0 ? C.red : undefined}
        value={live?.toolErrors ?? null}
      />
      <DiagRow label="turn" plumbed={plumbed} value={live?.turn ?? null} />
      {/* revive-budget + heartbeat remain NEEDS-PLUMBING (daemon markers /
          catalyst sess_ id — not the transcript tail). NEVER fabricated. */}
      <DiagRow label="revive-budget" value={null} plumbed={false} />
      <DiagRow label="heartbeat" value={null} plumbed={false} />
    </div>
  );
}

// ── PHASE TIMESTAMPS — this run's phases only ────────────────────────────────
function PhaseTimestamps({
  signal,
  currentPhase,
}: {
  signal: Record<string, unknown> | null;
  currentPhase: string;
}) {
  const rows = useMemo(
    () => readRunPhaseTimestamps(signal, currentPhase),
    [signal, currentPhase],
  );
  return (
    <div data-worker-phase-timestamps style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
      <SectionHeading>Phase Timestamps</SectionHeading>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {rows.map((r) => (
          <div
            key={r.phase}
            data-phase-ts={r.phase}
            data-current={r.current}
            title={r.startedAt ?? undefined}
            style={{
              font: `11px ${C.mono}`,
              padding: "2px 7px",
              borderRadius: 5,
              background: C.s3,
              color: r.current ? C.fg : C.fgMuted,
              border: r.current ? `1px solid ${LIVE_CYAN}55` : `1px solid ${C.border}`,
            }}
          >
            {r.phase}
            {r.startedAt && <span style={{ color: C.fgDim }}> · {r.startedAt.slice(11, 16)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SIGNAL panel — raw JSON + copy ───────────────────────────────────────────
function SignalPanel({ signal, label }: { signal: Record<string, unknown> | null; label: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => (signal ? JSON.stringify(signal, null, 2) : null), [signal]);

  const copy = useCallback(() => {
    if (!json) return;
    void navigator.clipboard?.writeText(json).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* clipboard denied — leave button label unchanged, never crash */
      },
    );
  }, [json]);

  return (
    <div data-worker-signal style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          data-signal-toggle
          style={{ background: "transparent", border: "none", color: C.fgMuted, cursor: "pointer", font: `10px ${C.mono}`, letterSpacing: "0.08em", textTransform: "uppercase", padding: 0 }}
        >
          {open ? "▾" : "▸"} signal {label}
        </button>
        <button
          type="button"
          onClick={copy}
          disabled={json == null}
          data-signal-copy
          style={{ background: C.s3, border: `1px solid ${C.border}`, borderRadius: 5, color: json == null ? C.fgDim : C.fgMuted, cursor: json == null ? "default" : "pointer", font: `10px ${C.mono}`, padding: "2px 8px" }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {open && (
        <pre
          data-signal-json
          style={{ marginTop: 8, maxHeight: 280, overflow: "auto", background: C.s3, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, font: `11px ${C.mono}`, color: json == null ? C.fgDim : C.fg }}
        >
          {json ?? "— no signal on disk for this run"}
        </pre>
      )}
    </div>
  );
}

// ── ACTIVITY TAIL — [● live] (trails in DETAIL7) + [history] (REAL Loki) ──────
function HistoryRow({ row }: { row: WorkerHistoryRow }) {
  const ok = row.success;
  const dot = ok === false ? C.red : ok === true ? C.green : C.fgMuted;
  return (
    <div
      data-history-row
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0", font: `11px ${C.mono}` }}
    >
      <span style={{ color: C.fgDim, flex: "0 0 auto" }}>{fmtTs(row.ts)}</span>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flex: "0 0 auto" }} />
      <span style={{ color: C.fg, flex: "0 0 auto" }}>{row.toolName ?? row.eventName ?? "event"}</span>
      {row.toolInput && (
        <span style={{ color: C.fgMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.toolInput.slice(0, 80)}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {row.durationMs != null && <span style={{ color: C.fgDim }}>{(row.durationMs / 1000).toFixed(1)}s</span>}
    </div>
  );
}

// ── live stream row (the harvested StreamEventRow, re-skinned to inline-C) ────
// One StreamEvent row, the live source's counterpart to HistoryRow. Mirrors the
// drawer's StreamEventRow (worker-detail-drawer.tsx:76) row-by-row — tool_start,
// text, reasoning (◌ thinking…), turn, retry, rate_limit — so live + history
// read identically (design §5.2 "one StreamEventRow renderer, two sources").
function LiveStreamRow({ event }: { event: StreamEvent }) {
  const base = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "2px 0",
    font: `11px ${C.mono}`,
  } as const;
  const dot = (color: string) => (
    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flex: "0 0 auto" }} />
  );
  const tsCell = (
    <span style={{ color: C.fgDim, flex: "0 0 auto" }}>{fmtTs(event.ts)}</span>
  );
  switch (event.type) {
    case "tool_start":
      return (
        <div data-live-row="tool_start" style={base}>
          {tsCell}
          {dot("#4ea1ff")}
          <span style={{ color: "#4ea1ff", flex: "0 0 auto" }}>{event.tool ?? "tool"}</span>
          {event.toolInput && (
            <span style={{ color: C.fgMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {event.toolInput.slice(0, 80)}
            </span>
          )}
        </div>
      );
    case "text":
      return (
        <div data-live-row="text" style={base}>
          {tsCell}
          {dot(C.green)}
          <span style={{ color: C.fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {event.text?.slice(0, 100) ?? "…"}
          </span>
        </div>
      );
    case "reasoning":
      return (
        <div data-live-row="reasoning" style={base}>
          {tsCell}
          <span style={{ color: C.fgMuted, flex: "0 0 auto" }}>◌</span>
          <span style={{ color: C.fgMuted, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {event.text?.slice(0, 100) ?? "thinking…"}
          </span>
        </div>
      );
    case "turn":
      return (
        <div data-live-row="turn" style={base}>
          {tsCell}
          {dot(LIVE_CYAN)}
          <span style={{ color: C.fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {event.turnTools && event.turnTools.length > 0
              ? event.turnTools.join(", ")
              : event.text
                ? event.text.slice(0, 100)
                : "new turn"}
          </span>
        </div>
      );
    case "retry":
      return (
        <div data-live-row="retry" style={base}>
          {tsCell}
          {dot(C.yellow)}
          <span style={{ color: C.yellow }}>
            retry {event.retryInfo?.attempt}/{event.retryInfo?.maxRetries}
          </span>
        </div>
      );
    case "rate_limit":
      return (
        <div data-live-row="rate_limit" style={base}>
          {tsCell}
          {dot(C.red)}
          <span style={{ color: C.red }}>rate limited</span>
        </div>
      );
    case "result":
      return (
        <div data-live-row="result" style={base}>
          {tsCell}
          {dot(C.green)}
          <span style={{ color: C.green, fontWeight: 600 }}>complete</span>
        </div>
      );
    default:
      return null;
  }
}

function ActivityTail({
  sessionId,
  alive,
  onDiagnostics,
}: {
  sessionId: string | null;
  alive: boolean;
  /** Lift the diagnostics derived from the live rows up to the DiagnosticsRail
   *  so its retries/rate-limit/turn/tool-error rows light up from the SAME rows. */
  onDiagnostics: (d: TailDiagnostics) => void;
}) {
  // Tabs: [● live] is REAL now (CTL-918, off the BFF SSE), [history] is the Loki
  // tail (CTL-914). Default to live for a running worker, history otherwise so a
  // dead worker's page is never empty.
  const [tab, setTab] = useState<"live" | "history">(alive ? "live" : "history");
  const [paused, setPaused] = useState(false);
  // Buffer length captured at pause-time so the view freezes there while the SSE
  // keeps buffering behind it (pause decouples view from data).
  const frozenLenRef = useRef(0);

  const { state, reload } = useHistoryTail(sessionId, tab === "history");
  // The SSE stays subscribed only while the [live] tab is open; pause does NOT
  // tear it down (data keeps flowing under the frozen view).
  const live = useLiveTail(sessionId, tab === "live");

  const visible = resolvePausedView(live.buffer, paused, frozenLenRef.current);
  const footer = useMemo(() => deriveFooterCounters(live.buffer), [live.buffer]);

  // Lift the live DIAGNOSTICS up to the rail whenever the live buffer changes.
  const diagnostics = useMemo(() => deriveTailDiagnostics(live.buffer), [live.buffer]);
  useEffect(() => {
    onDiagnostics(diagnostics);
  }, [diagnostics, onDiagnostics]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (!p) frozenLenRef.current = live.buffer.length; // freeze the view here
      return !p;
    });
  }, [live.buffer.length]);

  // The never-blank rule: while the live buffer is empty (stream momentarily
  // unavailable / not yet flowing) we still render one derived row so the
  // terminal is never blank (design §5.2 graceful MVP).
  const terminal = resolveLiveTerminalRows(
    visible.rows,
    // current tool from the latest live tool_start (or null) → the MVP row tool.
    latestTool(live.buffer),
    null, // BoardWorker.lastActiveMs is on the rail, not this scalar slice
    Date.now(),
  );

  const tabBtn = (id: "live" | "history", label: React.ReactNode) => (
    <button
      type="button"
      data-tail-tab={id}
      aria-pressed={tab === id}
      onClick={() => setTab(id)}
      style={{
        background: tab === id ? C.s3 : "transparent",
        border: `1px solid ${C.border}`,
        borderRadius: 5,
        color: tab === id ? C.fg : C.fgMuted,
        cursor: "pointer",
        font: `10px ${C.mono}`,
        padding: "2px 8px",
      }}
    >
      {label}
    </button>
  );

  return (
    <div data-worker-activity style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <SectionHeading>Activity Tail</SectionHeading>
        <span style={{ flex: 1 }} />
        {tabBtn("live", <span>● live</span>)}
        {tabBtn("history", "history")}
        {/* pause: freezes the VIEW, not the data (only meaningful on the live tab) */}
        {tab === "live" && (
          <button
            type="button"
            data-tail-pause
            aria-pressed={paused}
            onClick={togglePause}
            title={paused ? "resume — replays the buffered gap" : "pause — freezes the view; the stream keeps buffering"}
            style={{ background: paused ? C.s3 : "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: paused ? LIVE_CYAN : C.fgMuted, cursor: "pointer", font: `10px ${C.mono}`, padding: "2px 8px" }}
          >
            {paused ? "▶ resume" : "⏸ pause"}
          </button>
        )}
      </div>

      {tab === "live" ? (
        sessionId == null ? (
          <div data-live-empty style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
            no session id — live tail unavailable for this run
          </div>
        ) : (
          <>
            <div data-live-rows style={{ maxHeight: 320, overflow: "auto" }}>
              {terminal.source === "empty" ? (
                <div data-live-placeholder style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
                  {live.conn === "connecting" ? "connecting to the live stream…" : "stream momentarily unavailable"}
                </div>
              ) : (
                terminal.rows.map((r, i) => <LiveStreamRow key={`${r.ts}-${i}`} event={r} />)
              )}
            </div>
            {/* footer counters — derived CLIENT-SIDE from the received rows */}
            <div data-live-footer style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, font: `10px ${C.mono}`, color: C.fgMuted }}>
              <span data-footer-events>{footer.events} events</span>
              <span style={{ color: C.fgDim }}>·</span>
              <span data-footer-tools>{footer.tools} tools</span>
              <span style={{ color: C.fgDim }}>·</span>
              <span data-footer-retries>{footer.retries} retr{footer.retries === 1 ? "y" : "ies"}</span>
              <span style={{ color: C.fgDim }}>·</span>
              <span data-footer-stream>stream {fmtBytes(footer.streamBytes)}</span>
              {paused && (
                <>
                  <span style={{ flex: 1 }} />
                  <span data-footer-buffered style={{ color: LIVE_CYAN }}>
                    ⏸ {visible.bufferedWhilePaused} buffered
                  </span>
                </>
              )}
            </div>
          </>
        )
      ) : sessionId == null ? (
        <div data-history-empty style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
          no session id — history unavailable for this run
        </div>
      ) : state.kind === "loading" ? (
        <div style={{ font: `11px ${C.mono}`, color: C.fgMuted, padding: "8px 0" }}>loading history…</div>
      ) : state.kind === "unavailable" ? (
        <div data-history-unavailable style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
          Loki not configured — live diagnostics still available above
        </div>
      ) : state.kind === "error" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
          <span style={{ font: `11px ${C.mono}`, color: C.red }}>history query failed</span>
          <button type="button" onClick={reload} style={{ background: C.s3, border: `1px solid ${C.border}`, borderRadius: 5, color: C.fgMuted, cursor: "pointer", font: `10px ${C.mono}`, padding: "2px 8px" }}>
            retry
          </button>
        </div>
      ) : state.kind === "loaded" && state.rows.length === 0 ? (
        <div data-history-none style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
          no log lines in the last 24h
        </div>
      ) : state.kind === "loaded" ? (
        <div data-history-rows style={{ maxHeight: 320, overflow: "auto" }}>
          {state.rows.map((r, i) => (
            <HistoryRow key={`${r.ts}-${i}`} row={r} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The latest tool name from a live buffer (the current tool the agent is on) —
 *  feeds the never-blank MVP fallback row. */
function latestTool(rows: StreamEvent[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type === "tool_start" && rows[i].tool) return rows[i].tool ?? null;
  }
  return null;
}

/** Compact byte size for the stream-size footer cell (1.2MB / 412k / 87B). */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ── BURN STRIP (REAL Prometheus sparklines, CC-UUID join) + idle-ratio ───────
function formatTileValue(tile: BurnTile): string {
  if (tile.value == null) return "—";
  switch (tile.label) {
    case "COST":
      return fmtCost(tile.value);
    case "TOKENS":
      return fmtTokens(tile.value);
    case "ACTIVE":
      return fmtIdle(tile.value * 1000); // active seconds → the idle formatter
    default:
      return String(tile.value);
  }
}

function BurnTileCell({ tile }: { tile: BurnTile }) {
  const live = tile.source === "sparkline";
  return (
    <div
      data-burn-tile={tile.label}
      data-source={tile.source}
      style={{
        flex: "1 1 0",
        minWidth: 120,
        background: C.s3,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span style={{ font: `9px ${C.mono}`, letterSpacing: "0.08em", color: C.fgMuted }}>
        {tile.label}
      </span>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span
          data-burn-value
          style={{ font: `13px ${C.mono}`, color: tile.value != null ? C.fg : C.fgDim, fontWeight: 600 }}
        >
          {formatTileValue(tile)}
        </span>
        {live && tile.points.length > 0 ? (
          <Sparkline points={tile.points} color={LIVE_CYAN} ariaLabel={`${tile.label} sparkline`} />
        ) : tile.source === "scalar-fallback" ? (
          <span data-burn-hint style={{ font: `9px ${C.mono}`, color: C.fgDim }}>
            ({tile.hint ?? "live soon"})
          </span>
        ) : (
          <span data-burn-needs style={{ font: `9px ${C.mono}`, color: C.fgDim }} title="git-sourced, not telemetry">
            — ↯
          </span>
        )}
      </div>
    </div>
  );
}

function IdleRatioBar({
  activeSeconds,
  runtimeMs,
}: {
  activeSeconds: WorkerBurnSeries["activeSeconds"] | null;
  runtimeMs: number | null;
}) {
  const ratio = deriveIdleRatio(activeSeconds, runtimeMs);
  const SEGMENTS = 10;
  const filled = ratio.fraction == null ? 0 : Math.round(ratio.fraction * SEGMENTS);
  const pct = ratio.fraction == null ? null : Math.round(ratio.fraction * 100);
  return (
    <div
      data-idle-ratio
      data-fraction={ratio.fraction ?? "none"}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 2px" }}
    >
      <span style={{ font: `10px ${C.mono}`, color: C.fgMuted, flex: "0 0 auto" }}>idle-ratio</span>
      <span style={{ display: "inline-flex", gap: 2, flex: "0 0 auto" }}>
        {Array.from({ length: SEGMENTS }).map((_, i) => (
          <span
            key={i}
            style={{
              width: 7,
              height: 11,
              borderRadius: 1,
              // active fraction filled (cyan), the rest muted — a shrinking
              // filled span reads as the stuck-tell.
              background: ratio.fraction == null ? C.s3 : i < filled ? LIVE_CYAN : C.s3,
              border: `1px solid ${C.border}`,
            }}
          />
        ))}
      </span>
      <span style={{ font: `10px ${C.mono}`, color: pct != null ? C.fg : C.fgDim, flex: "0 0 auto" }}>
        {pct != null
          ? `active ${fmtIdle((ratio.activeSeconds ?? 0) * 1000)} / wall ${fmtIdle((ratio.wallSeconds ?? 0) * 1000)} · ${pct}%`
          : "— ↯ (needs active series + runtime)"}
      </span>
    </div>
  );
}

function BurnStrip({
  series,
  worker,
}: {
  series: WorkerBurnSeries | null;
  worker: BoardWorker | undefined;
}) {
  const tiles = useMemo(() => buildBurnTiles(series, worker), [series, worker]);
  return (
    <div
      data-worker-burn-strip
      style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}
    >
      <SectionHeading>Burn Strip · Prometheus (session_id)</SectionHeading>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
        {tiles.map((t) => (
          <BurnTileCell key={t.label} tile={t} />
        ))}
      </div>
      <IdleRatioBar activeSeconds={series?.activeSeconds ?? null} runtimeMs={worker?.runtimeMs ?? null} />
    </div>
  );
}

// ── the page body ─────────────────────────────────────────────────────────────
export function WorkerDetailBody({
  id,
  worker,
}: {
  id: string;
  worker: BoardWorker | undefined;
}) {
  const ticket = worker?.ticket;
  const phase = worker?.phase;
  const { signal } = usePhaseSignal(ticket, phase);
  const fields = useMemo(() => (signal ? readPhaseSignalFields(signal) : null), [signal]);
  const scalars = readWorkerScalars(worker);
  const alive = isWorkerAlive(worker);
  const burnSeries = useBurnSeries(scalars.sessionId, alive);
  // CTL-918 (DETAIL7): the live-tail DIAGNOSTICS are derived in ActivityTail (it
  // owns the SSE buffer) and lifted up here so the DiagnosticsRail's
  // retries/rate-limit/turn/tool-error rows light up from the SAME received rows.
  const [liveDiagnostics, setLiveDiagnostics] = useState<TailDiagnostics | null>(null);

  return (
    <div data-worker-detail-body data-id={id} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HeaderStrip worker={worker} signal={fields} alive={alive} />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,320px)", gap: 12, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <BurnStrip series={burnSeries} worker={worker} />
          <ActivityTail sessionId={scalars.sessionId} alive={alive} onDiagnostics={setLiveDiagnostics} />
          <SignalPanel signal={signal} label={phase ? `phase-${phase}.json` : ""} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <DiagnosticsRail worker={worker} live={liveDiagnostics} />
          <PhaseTimestamps signal={signal} currentPhase={phase ?? "—"} />
        </div>
      </div>
    </div>
  );
}
