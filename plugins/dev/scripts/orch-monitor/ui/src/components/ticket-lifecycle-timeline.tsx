// ticket-lifecycle-timeline.tsx — the CONSOLIDATED lifecycle timeline
// (DETAIL2-v2 §4). v1 rendered TWO things from the SAME phaseSummary data: the
// <TicketGantt> bar track AND a separate <SpineRow>×N table. That duplication is
// exactly what the operator asked to collapse. This is ONE timeline: a bar track
// PLUS visible columns on each phase row —
//
//   [● phase] [status] | [bar track ────] | start | stop | duration | tokens | model | cost | links
//
// Geometry (leftPct/widthPct/isRunning) and columns (status/duration/timestamps/
// model/cost/tokens) come from the SAME pure join — resolveTimelineRows(ticket)
// in board/ticket-page-model.ts — so they can never drift. The GanttAxis ticks
// are lifted up as a sibling header row (one span computation, not two).
//
// Every NEEDS-PLUMBING cell stays honest: a phase with no startedAt renders its
// columns with an EMPTY bar groove (no fabricated bar); tokens absent → "↯";
// cost/run absent → the dimmed <Needs> marker; artifact link only when present.

import { useMemo } from "react";
import {
  resolveTimelineRows,
  type TimelineRow,
} from "@/board/ticket-page-model";
import type { BoardTicket } from "@/board/types";
import { phaseColor, fmtDuration, fmtClock, phaseModelLabel, fmtCost, fmtTokens } from "@/lib/formatters";
import { EmptyState } from "./ui/empty-state";
import { ListTree } from "lucide-react";

// ── tokens (mirror ticket-detail-page.tsx's inline-`C` palette; cyan reserved) ──
const C = {
  s1: "#111318",
  s2: "#171a21",
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  cyan: "#5be0ff", // the reserved live signal — current phase / active node only
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** One artifact returned by /api/ticket-artifacts/<id> (mirrors the page's shape). */
export interface TimelineArtifact {
  kind: "research" | "plan" | string;
  path: string;
  peek: string | null;
}

/** A NEEDS-PLUMBING cell marker — dimmed "↯" + label. Never an invented value. */
function Needs({ label }: { label: string }) {
  return (
    <span
      data-needs-plumbing={label}
      title={`${label} — NEEDS-PLUMBING`}
      style={{ color: C.fgDim, font: `10px ${C.mono}` }}
    >
      ↯ {label}
    </span>
  );
}

// ── Shared-timeline axis (lifted from ticket-gantt.tsx GanttAxis) ─────────────
// Derives 4–5 tick marks from the same start/end span the bars use. Reads the
// resolved TimelineRows (which already carry startedAt/completedAt/status) so the
// span is computed ONCE here, never re-derived alongside the bars.
function TimelineAxis({ rows, now }: { rows: TimelineRow[]; now: number }) {
  const ticks = useMemo(() => {
    const started = rows
      .filter((r) => r.startedAt != null)
      .map((r) => Date.parse(r.startedAt!));
    if (started.length === 0) return [];
    const axisStart = Math.min(...started);
    const TERMINAL = new Set(["done", "complete", "failed", "blocked"]);
    const ends = rows
      .filter((r) => r.startedAt != null)
      .map((r) => {
        if (r.completedAt) return Date.parse(r.completedAt);
        if (!TERMINAL.has(r.status)) return now;
        return Date.parse(r.startedAt!);
      });
    const axisEnd = Math.max(...ends, axisStart + 1);
    const span = axisEnd - axisStart;
    // Pick the smallest "nice" interval that keeps the tick count to ~6 — so a
    // multi-DAY lifecycle (phases spread across days) doesn't render dozens of
    // crammed, overlapping HH:MM labels. The ladder runs minutes → hours → days.
    const MIN = 60000;
    const NICE = [5 * MIN, 15 * MIN, 30 * MIN, 60 * MIN, 2 * 60 * MIN, 4 * 60 * MIN, 6 * 60 * MIN, 12 * 60 * MIN, 24 * 60 * MIN, 2 * 24 * 60 * MIN, 7 * 24 * 60 * MIN];
    const TARGET_TICKS = 6;
    const interval =
      NICE.find((iv) => span / iv <= TARGET_TICKS) ?? NICE[NICE.length - 1];
    // Multi-day spans need a date prefix so "08:34" on day 1 vs day 2 isn't ambiguous.
    const multiDay = span > 24 * 60 * MIN;
    const fmtTick = (d: Date) =>
      multiDay ? `${d.getMonth() + 1}/${d.getDate()} ${fmtClock(d)}` : fmtClock(d);
    const out: { leftPct: number; label: string }[] = [];
    const firstTick = Math.ceil(axisStart / interval) * interval;
    for (let t = firstTick; t <= axisEnd; t += interval) {
      out.push({ leftPct: ((t - axisStart) / span) * 100, label: fmtTick(new Date(t)) });
    }
    return out;
  }, [rows, now]);

  if (ticks.length === 0) return null;

  return (
    <div
      data-timeline-axis
      style={{
        position: "relative",
        height: 14,
        // align the tick band over the bar track: phase(110)+gap(12)+status(86)+gap(12)
        marginLeft: 220,
        marginRight: 8,
        marginBottom: 4,
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      {ticks.map((tick, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            top: 0,
            left: tick.leftPct.toFixed(2) + "%",
            transform: "translateX(-50%)",
            font: `9px ${C.mono}`,
            color: C.fgDim,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {tick.label}
        </div>
      ))}
    </div>
  );
}

// ── one timeline row: bar track + columns ─────────────────────────────────────
function TimelineRowView({
  row,
  registerNode,
  artifactsByKind,
  renderActiveTail,
}: {
  row: TimelineRow;
  registerNode: (phase: string, el: HTMLDivElement | null) => void;
  artifactsByKind: Record<string, TimelineArtifact[]>;
  /** The active-node live tail node, rendered beneath the active row (null otherwise). */
  renderActiveTail: React.ReactNode;
}) {
  const color = phaseColor(row.phase);
  const started = row.startedAt ? fmtClock(new Date(Date.parse(row.startedAt))) : "—";
  const stopped = row.completedAt
    ? fmtClock(new Date(Date.parse(row.completedAt)))
    : row.isActive || row.isRunning
      ? "now"
      : "—";
  const phaseArtifactKind = row.phase === "research" ? "research" : row.phase === "plan" ? "plan" : null;
  const phaseArtifacts = phaseArtifactKind ? (artifactsByKind[phaseArtifactKind] ?? []) : [];
  const hasBar = row.leftPct != null && row.widthPct != null;

  return (
    <div
      ref={(el) => registerNode(row.phase, el)}
      data-spine-row={row.phase}
      {...(row.isActive ? { "data-spine-active": "true" } : {})}
      style={{ marginBottom: 4 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "6px 8px",
          borderRadius: 5,
          background: row.isActive ? C.cyan + "12" : C.s1,
          border: `1px solid ${row.isActive ? C.cyan + "55" : C.border}`,
          font: `11px ${C.mono}`,
        }}
      >
        {/* phase chip + active dot */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: 110, flexShrink: 0 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: row.isActive ? C.cyan : color,
              flex: "0 0 auto",
            }}
          />
          <span style={{ color: C.fg }}>{row.label}</span>
        </span>

        {/* status */}
        <span style={{ width: 86, flexShrink: 0, color: C.fgMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.status}
        </span>

        {/* bar track — colored bar at leftPct/widthPct; empty groove when no start */}
        <span style={{ flex: 1, minWidth: 60, position: "relative", height: 14, borderRadius: 3, background: C.s2 }}>
          {hasBar && (
            <span
              data-timeline-bar={row.phase}
              title={`${row.phase} · ${started}–${stopped}${row.durationMs != null ? ` · ${fmtDuration(row.durationMs)}` : ""}`}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: row.leftPct!.toFixed(2) + "%",
                width: Math.max(row.widthPct!, 0.5).toFixed(2) + "%",
                background: color,
                borderRadius: 3,
                opacity: row.isRunning ? 0.95 : 0.78,
              }}
            >
              {row.isRunning && (
                <span
                  style={{
                    position: "absolute",
                    inset: "0 0 0 auto",
                    width: 3,
                    background: "rgba(255,255,255,0.45)",
                    borderRadius: "0 3px 3px 0",
                    animation: "gantt-pulse 1.4s ease-in-out infinite",
                  }}
                />
              )}
            </span>
          )}
        </span>

        {/* start */}
        <span style={{ width: 56, flexShrink: 0, color: C.fgDim, textAlign: "right" }}>{started}</span>
        {/* stop */}
        <span style={{ width: 56, flexShrink: 0, color: C.fgDim, textAlign: "right" }}>{stopped}</span>
        {/* duration */}
        <span style={{ width: 60, flexShrink: 0, color: C.fgMuted, textAlign: "right" }}>
          {row.durationMs != null ? fmtDuration(row.durationMs) : "…"}
        </span>
        {/* tokens — its own column (the operator named tokens specifically) */}
        <span
          data-timeline-tokens={row.phase}
          title={row.tokens != null ? `${fmtTokens(row.tokens)} tokens` : "no per-phase tokens"}
          style={{ width: 60, flexShrink: 0, color: row.tokens != null ? C.fgMuted : C.fgDim, textAlign: "right" }}
        >
          {row.tokens != null ? fmtTokens(row.tokens) : "↯"}
        </span>
        {/* model */}
        <span data-spine-model={row.phase} style={{ width: 72, flexShrink: 0, color: row.model ? C.fgMuted : C.fgDim, textAlign: "right" }}>
          {phaseModelLabel(row.model)}
        </span>
        {/* cost */}
        <span style={{ width: 64, flexShrink: 0, textAlign: "right" }}>
          {row.costSparkline === "plumbed" && row.costUSD != null ? (
            <span data-spine-cost={row.phase} data-gantt-cost={row.phase} style={{ color: C.fgMuted, font: `10px ${C.mono}` }}>
              {fmtCost(row.costUSD)}
            </span>
          ) : (
            <Needs label="cost" />
          )}
        </span>

        {/* links: artifact (real when present) + run (pending) */}
        <span style={{ display: "inline-flex", gap: 8, flexShrink: 0, alignItems: "center", minWidth: 0 }}>
          {phaseArtifacts.length > 0 ? (
            <span data-spine-artifact={row.phase} style={{ display: "inline-flex", gap: 4 }}>
              {phaseArtifacts.map((a) => (
                <a
                  key={a.path}
                  href={`/api/artifact-raw?path=${encodeURIComponent(a.path)}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={a.peek ? a.peek.slice(0, 200) : a.path}
                  style={{ color: "#4ea1ff", font: `10px ${C.mono}`, textDecoration: "none" }}
                >
                  📄 {a.kind}
                </a>
              ))}
            </span>
          ) : row.artifact === "pending" && phaseArtifactKind ? (
            <Needs label="artifact" />
          ) : null}
          {row.runLink === "pending" && <Needs label="run" />}
        </span>
      </div>
      {/* the active node's live tail (now: <tool> · turn N · ctx% + 3-line tail) */}
      {row.isActive && renderActiveTail}
    </div>
  );
}

// ── the consolidated timeline ─────────────────────────────────────────────────
export function LifecycleTimeline({
  ticket,
  registerNode,
  artifactsByKind,
  renderActiveTail,
}: {
  ticket: BoardTicket;
  registerNode: (phase: string, el: HTMLDivElement | null) => void;
  artifactsByKind: Record<string, TimelineArtifact[]>;
  /** The active-node live tail node (rendered beneath the active row). The page
   *  owns the SSE hook + the ActiveNodeTailView; the timeline just slots it in. */
  renderActiveTail: React.ReactNode;
}) {
  const now = Date.now();
  const rows = useMemo(() => resolveTimelineRows(ticket, now), [ticket, now]);

  return (
    <section data-ticket-timeline style={{ marginBottom: 16 }}>
      {rows.length === 0 ? (
        <EmptyState icon={ListTree} message="No phases yet" />
      ) : (
        <>
          <TimelineAxis rows={rows} now={now} />
          <div>
            {rows.map((row) => (
              <TimelineRowView
                key={row.phase}
                row={row}
                registerNode={registerNode}
                artifactsByKind={artifactsByKind}
                renderActiveTail={row.isActive ? renderActiveTail : null}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
