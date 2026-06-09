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

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BoardWorker } from "./types";
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
import { LIVE_CYAN } from "./detail-chrome";

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
function DiagnosticsRail({ worker }: { worker: BoardWorker | undefined }) {
  // A ticking clock so liveness/idle stay fresh while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const lastActiveMs = worker?.lastActiveMs ?? null;
  const liveness = deriveLiveness(lastActiveMs, now);
  const gate = deriveStaleBgGate(lastActiveMs, now);

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
      {/* NEEDS-PLUMBING — derived from the tail / catalyst sess_ id once wired.
          NEVER a fabricated 2/3. */}
      <DiagRow label="retries" value={null} plumbed={false} />
      <DiagRow label="rate-limit" value={null} plumbed={false} />
      <DiagRow label="tool-errors" value={null} plumbed={false} />
      <DiagRow label="turn" value={null} plumbed={false} />
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

function ActivityTail({ sessionId }: { sessionId: string | null }) {
  // Tabs: [● live] trails in DETAIL7 (disabled here), [history] is REAL today.
  // Default to history so a dead worker's page is never empty.
  const [tab, setTab] = useState<"live" | "history">("history");
  const { state, reload } = useHistoryTail(sessionId, tab === "history");

  return (
    <div data-worker-activity style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <SectionHeading>Activity Tail</SectionHeading>
        <span style={{ flex: 1 }} />
        {/* [● live] is the DETAIL7 dependency — rendered disabled with a soon tag,
            never a dead live action. */}
        <button
          type="button"
          disabled
          data-tail-tab="live"
          title="live tail lands in DETAIL7"
          style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: C.fgDim, cursor: "default", font: `10px ${C.mono}`, padding: "2px 8px" }}
        >
          ● live · soon ◌
        </button>
        <button
          type="button"
          data-tail-tab="history"
          onClick={() => setTab("history")}
          style={{ background: tab === "history" ? C.s3 : "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: tab === "history" ? C.fg : C.fgMuted, cursor: "pointer", font: `10px ${C.mono}`, padding: "2px 8px" }}
        >
          history
        </button>
      </div>

      {sessionId == null ? (
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

  return (
    <div data-worker-detail-body data-id={id} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HeaderStrip worker={worker} signal={fields} alive={alive} />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,320px)", gap: 12, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <ActivityTail sessionId={scalars.sessionId} />
          <SignalPanel signal={signal} label={phase ? `phase-${phase}.json` : ""} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <DiagnosticsRail worker={worker} />
          <PhaseTimestamps signal={signal} currentPhase={phase ?? "—"} />
        </div>
      </div>
    </div>
  );
}
