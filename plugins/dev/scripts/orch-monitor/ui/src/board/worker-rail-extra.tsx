// worker-rail-extra.tsx — the worker-detail v2 consolidated rail content
// (CTL-925 / WORKER-DETAIL v2 Pass A §1A). The page used to carry TWO right rails:
// the Shell's shared <PropertiesRail> AND a body-internal 320px column stacking
// Diagnostics + PhaseTimestamps. v2 collapses to ONE rail — this component is the
// worker-only `railExtra` slot the Shell renders below its Properties divider, so
// the operator reads Properties · Diagnostics · Timeline in a single column.
//
// It is rendered INSIDE the Shell's PropertiesRail <aside> (already 280px,
// scrolling), so the groups here are flat sections (no nested card/border) — just
// a SectionHeading + the rows, divided by the same borderTop treatment the rail
// uses. This is passed via props (per-page), so the ticket detail page's rail is
// UNTOUCHED — the Shell contract is unchanged.
//
// The live-tail DIAGNOSTICS (retries/rate-limit/turn/tool-errors) are derived from
// the SAME SSE buffer the body's Now view reads — hoisted to WorkerDetailRoute via
// useWorkerDetailModel and passed down as `liveDiagnostics` so both surfaces agree
// (no second SSE connection).

import { useEffect, useMemo, useState } from "react";
import type { BoardWorker } from "./types";
import type { TailDiagnostics } from "./live-tail-data";
import {
  deriveLiveness,
  deriveStaleBgGate,
  readRunPhaseTimestamps,
  type LivenessLevel,
} from "./worker-detail-data";
import { LIVE_CYAN } from "./detail-chrome";

const C = {
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

/** A diagnostics row. `plumbed=false` dims it + appends the honest NEEDS-PLUMBING
 *  marker — NEVER a fabricated value. (Ported verbatim from the old in-body rail.) */
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

// ── Diagnostics group (the former DiagnosticsRail, de-carded for the rail) ────
function DiagnosticsGroup({
  worker,
  live,
}: {
  worker: BoardWorker | undefined;
  live: TailDiagnostics | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const lastActiveMs = worker?.lastActiveMs ?? null;
  const liveness = deriveLiveness(lastActiveMs, now);
  const gate = deriveStaleBgGate(lastActiveMs, now);
  const plumbed = live?.plumbed ?? false;

  return (
    <div data-worker-diagnostics>
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
      <DiagRow label="revive-budget" value={null} plumbed={false} />
      <DiagRow label="heartbeat" value={null} plumbed={false} />
    </div>
  );
}

// ── Timeline group (the former PhaseTimestamps, de-carded for the rail) ───────
function TimelineGroup({
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
    <div data-worker-phase-timestamps>
      <SectionHeading>Timeline</SectionHeading>
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

/**
 * The worker-only rail-extra: Diagnostics + Timeline as grouped sections, divided
 * by the same borderTop the Shell uses between rail groups. Rendered through the
 * Shell's `railExtra` prop so the ticket page's rail is untouched.
 */
export function WorkerRailExtra({
  worker,
  signal,
  liveDiagnostics,
  currentPhase,
}: {
  worker: BoardWorker | undefined;
  signal: Record<string, unknown> | null;
  liveDiagnostics: TailDiagnostics | null;
  currentPhase: string;
}) {
  return (
    <div data-worker-rail-extra style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <DiagnosticsGroup worker={worker} live={liveDiagnostics} />
      <div style={{ paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
        <TimelineGroup signal={signal} currentPhase={currentPhase} />
      </div>
    </div>
  );
}
