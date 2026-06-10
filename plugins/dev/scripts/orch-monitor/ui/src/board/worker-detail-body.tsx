// worker-detail-body.tsx — the worker detail PAGE body, v2 (CTL-925 /
// WORKER-DETAIL v2 Pass A). The v1 body carried TWO right rails (the Shell's
// shared Properties rail PLUS an internal 320px Diagnostics/Timeline column) and a
// garbled raw-screen pane. v2:
//
//   • SINGLE COLUMN — the internal two-column grid is gone; Diagnostics + Timeline
//     moved into the ONE Shell rail (via railExtra in WorkerDetailRoute). The body
//     is now a full-width flex column (minWidth:0 so mono text ellipsizes).
//   • NOW VIEW — the corrupted LiveScreenPane (/api/ec-worker-screen strips ALL
//     ANSI → 1-char-wide garble) is dropped. The primary live surface is the
//     structured NowPanel, built from the typed transcript stream (StreamEvent):
//     a readable "Now" headline + a rolling action feed + radix Tabs (Now/History).
//   • COST/TOKENS CHART — the cramped Burn-Strip sparklines are replaced by a real
//     dual-axis cost+tokens-over-time chart (WorkerBurnChart) reusing the OBSERVE
//     chart-kit, with the COST/TOKENS/ACTIVE scalar numbers kept below it.
//   • TICKET LINK + PHASE BADGE in the header (§2/§4).
//
// The live model (signal / burn / live tail / diagnostics / otel health) is hoisted
// to WorkerDetailRoute via useWorkerDetailModel and passed in as `model`, so the
// Shell rail's Diagnostics and this body's Now view read the SAME SSE buffer (one
// connection). The raw SIGNAL panel stays last as the always-available escape hatch.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { BoardWorker } from "./types";
import type { DetailSearch } from "./route-search";
import {
  resolveHeaderModel,
  resolveElapsed,
  type PhaseSignalFields,
} from "./worker-detail-data";
import { deriveIdleRatio, type WorkerBurnSeries } from "./worker-burn-data";
import { LIVE_CYAN } from "./detail-chrome";
import { NowPanel } from "./now-panel";
import { WorkerBurnChart } from "./worker-burn-chart";
import type { WorkerDetailModel } from "./use-worker-detail-model";

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

// ── phase-type badge palette (NOT status colors — stage-family hues, §2) ─────
// Color-coded by stage family using the chart-token hues so the badge answers
// "what KIND of work is this" at a glance. research/plan, implement, verify/review,
// monitor-* each get a distinct hue; unknown phases fall back to a neutral chip.
const PHASE_FAMILY: Record<string, string> = {
  triage: "var(--chart-5, #b07ad0)",
  research: "var(--chart-2, #4ea1ff)",
  plan: "var(--chart-2, #4ea1ff)",
  implement: "var(--chart-1, #5be0ff)",
  remediate: "var(--chart-1, #5be0ff)",
  verify: "var(--chart-3, #e0b341)",
  review: "var(--chart-3, #e0b341)",
  "monitor-merge": "var(--chart-4, #39d07a)",
  "monitor-deploy": "var(--chart-4, #39d07a)",
  teardown: "var(--chart-6, #8b93a1)",
};

function phaseHue(phase: string | undefined): string {
  if (!phase) return C.fgDim;
  return PHASE_FAMILY[phase] ?? "var(--chart-6, #8b93a1)";
}

// ── the Loki history tail row (mirrors the server's WorkerHistoryRow) ─────────
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
  | { kind: "unavailable" }
  | { kind: "error" };

/** Lazily fetch the Loki history tail (only when the [history] tab is mounted). */
function useHistoryTail(sessionId: string | null): {
  state: HistoryState;
  reload: () => void;
} {
  const [state, setState] = useState<HistoryState>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!sessionId) {
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
  }, [sessionId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { state, reload };
}

// ── small presentational atoms ───────────────────────────────────────────────
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

function fmtIdle(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// CTL-915: the header elapsed reads at second precision. null → em-dash, never 0s.
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

// ── header strip (ring · phase badge · status · ticket link · meta row) ──────
function HeaderStrip({
  worker,
  signal,
  alive,
  search,
}: {
  worker: BoardWorker | undefined;
  signal: PhaseSignalFields | null;
  alive: boolean;
  search: DetailSearch;
}) {
  const model = resolveHeaderModel(signal, worker);
  const status = signal?.status ?? worker?.status ?? "—";
  const ticket = worker?.ticket ?? null;
  const phase = worker?.phase;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = resolveElapsed(worker?.startedAt, worker?.runtimeMs, now);
  const ringColor = alive ? LIVE_CYAN : C.fgDim;
  const hue = phaseHue(phase);

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
        style={{ width: 11, height: 11, borderRadius: "50%", border: `2px solid ${ringColor}`, flex: "0 0 auto" }}
      />
      {/* phase-type badge — the "what KIND of work is this" anchor (stage-family hue) */}
      <span
        data-worker-phase-badge={phase ?? "none"}
        style={{
          font: `11px ${C.mono}`,
          fontWeight: 600,
          color: C.fg,
          padding: "2px 9px",
          borderRadius: 5,
          background: `color-mix(in srgb, ${hue} 18%, transparent)`,
          border: `1px solid color-mix(in srgb, ${hue} 50%, transparent)`,
          flex: "0 0 auto",
        }}
      >
        {phase ?? "phase —"}
      </span>
      <span data-worker-status style={{ font: `12px ${C.mono}`, color: C.fg, fontWeight: 600 }}>
        {status}
      </span>
      {/* ticket link — routes to /ticket/<ticket>, carrying the current search */}
      {ticket ? (
        <Link
          data-worker-ticket-link={ticket}
          to="/ticket/$id"
          params={{ id: ticket }}
          search={search}
          style={{ font: `11px ${C.mono}`, color: "#4ea1ff", textDecoration: "none", flex: "0 0 auto" }}
        >
          {ticket} ↗
        </Link>
      ) : (
        <span data-worker-ticket-link="none" style={{ font: `11px ${C.mono}`, color: C.fgDim }}>—</span>
      )}
      <span style={{ flex: 1 }} />
      <span data-worker-model data-plumbed={model != null} style={{ font: `11px ${C.mono}`, color: model != null ? C.fg : C.fgDim }}>
        model {model ?? "—"}
      </span>
      <span data-worker-bgjob data-plumbed={signal?.bgJobId != null} style={{ font: `11px ${C.mono}`, color: signal?.bgJobId != null ? C.fg : C.fgDim }}>
        bg_job_id {signal?.bgJobId ?? "— ↯"}
      </span>
      <span data-worker-attempt data-plumbed={signal?.attempt != null} style={{ font: `11px ${C.mono}`, color: signal?.attempt != null ? C.fg : C.fgDim }}>
        attempt {signal?.attempt ?? "— ↯"}
      </span>
      <span data-worker-gen data-plumbed={signal?.generation != null} style={{ font: `11px ${C.mono}`, color: signal?.generation != null ? C.fg : C.fgDim }}>
        gen {signal?.generation ?? "— ↯"}
      </span>
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

// ── SIGNAL panel — raw JSON + copy (always-available escape hatch) ───────────
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
      () => {},
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

// ── history tail body (the [history] tab content — REAL Loki) ─────────────────
function HistoryRow({ row }: { row: WorkerHistoryRow }) {
  const ok = row.success;
  const dot = ok === false ? C.red : ok === true ? C.green : C.fgMuted;
  return (
    <div data-history-row style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0", font: `11px ${C.mono}` }}>
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

function HistoryTailBody({ sessionId }: { sessionId: string | null }) {
  const { state, reload } = useHistoryTail(sessionId);
  if (sessionId == null) {
    return (
      <div data-history-empty style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
        no session id — history unavailable for this run
      </div>
    );
  }
  if (state.kind === "loading" || state.kind === "idle") {
    return <div style={{ font: `11px ${C.mono}`, color: C.fgMuted, padding: "8px 0" }}>loading history…</div>;
  }
  if (state.kind === "unavailable") {
    return (
      <div data-history-unavailable style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
        Loki not configured — live activity still available above
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
        <span style={{ font: `11px ${C.mono}`, color: C.red }}>history query failed</span>
        <button type="button" onClick={reload} style={{ background: C.s3, border: `1px solid ${C.border}`, borderRadius: 5, color: C.fgMuted, cursor: "pointer", font: `10px ${C.mono}`, padding: "2px 8px" }}>
          retry
        </button>
      </div>
    );
  }
  if (state.rows.length === 0) {
    return (
      <div data-history-none style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
        no log lines in the last 24h
      </div>
    );
  }
  return (
    <div data-history-rows style={{ maxHeight: 320, overflow: "auto" }}>
      {state.rows.map((r, i) => (
        <HistoryRow key={`${r.ts}-${i}`} row={r} />
      ))}
    </div>
  );
}

// ── idle-ratio summary (the at-a-glance stuck-tell, kept beneath the chart) ──
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
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8 }}
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

// ── the page body (single column, v2) ─────────────────────────────────────────
export function WorkerDetailBody({
  id,
  worker,
  model,
  search,
}: {
  id: string;
  worker: BoardWorker | undefined;
  /** The hoisted live model (shared with the Shell rail's Diagnostics group). */
  model: WorkerDetailModel;
  /** The route search params — carried into the ticket Link so the pager context
   *  is preserved on the cross-navigation. */
  search: DetailSearch;
}) {
  const phase = worker?.phase;

  return (
    <div data-worker-detail-body data-id={id} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <HeaderStrip worker={worker} signal={model.fields} alive={model.alive} search={search} />

      {/* NOW PANEL — the structured live view (replaces the garbled raw screen). */}
      <NowPanel
        sessionId={model.sessionId}
        alive={model.alive}
        lastActiveMs={worker?.lastActiveMs ?? null}
        buffer={model.liveBuffer}
        conn={model.liveConn}
        history={<HistoryTailBody sessionId={model.sessionId} />}
      />

      {/* COST + TOKENS over-time chart (ChartCard honesty ladder) + scalar strip. */}
      <WorkerBurnChart series={model.burnSeries} worker={worker} health={model.health} />

      {/* idle-ratio summary — the at-a-glance stuck-tell (Pass-B adds the timeline). */}
      <IdleRatioBar activeSeconds={model.burnSeries?.activeSeconds ?? null} runtimeMs={worker?.runtimeMs ?? null} />

      {/* raw SIGNAL — the always-available ground-truth escape hatch, last. */}
      <SignalPanel signal={model.signal} label={phase ? `phase-${phase}.json` : ""} />
    </div>
  );
}
