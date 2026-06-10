import { BarChart3 } from "lucide-react";
import { phaseColor, fmtDuration, fmtClock, phaseModelLabel, fmtCost, fmtTokens } from "@/lib/formatters";
import { EmptyState } from "./ui/empty-state";
import type { BoardTicket, BoardPhaseTiming, BoardPhaseCost } from "@/board/types";

// kibo-ui/gantt is a scheduler-oriented component (day/month/quarter ranges)
// that does not cleanly express absolute-minute precision within a single ticket
// lifetime. We use computed CSS offsets against the ticket's own time span
// instead, modeled on the existing GanttChart bar-track pattern.

interface TicketGanttProps {
  ticket: BoardTicket;
  /** CTL-953: per-phase cost from BoardTicket.phaseCosts — shown as a right-side
   *  annotation on each bar row. Dim when absent (never fabricated). */
  phaseCosts?: Record<string, BoardPhaseCost> | null;
}

interface PhaseBar {
  row: BoardPhaseTiming;
  leftPct: number;
  widthPct: number;
  isRunning: boolean;
  durationLabel: string;
  startLabel: string;
  endLabel: string;
}

/** Exported for unit tests only — prefer the React component in production code. */
export function buildBars(rows: BoardPhaseTiming[], now: number): PhaseBar[] | null {
  const timed = rows.filter((r) => r.startedAt != null);
  if (!timed.length) return null;

  const starts = timed.map((r) => Date.parse(r.startedAt!));
  const TERMINAL = new Set(["done", "complete", "failed", "blocked"]);
  const ends = timed.map((r, i) => {
    if (r.completedAt) return Date.parse(r.completedAt);
    if (!TERMINAL.has(r.status)) return now;
    return starts[i];
  });

  const axisStart = Math.min(...starts);
  const axisEnd = Math.max(...ends, axisStart + 1);
  const span = axisEnd - axisStart;

  return timed.map((row, i) => {
    const s = starts[i];
    const e = ends[i];
    const isRunning = !row.completedAt && !TERMINAL.has(row.status);
    return {
      row,
      leftPct: ((s - axisStart) / span) * 100,
      widthPct: (Math.max(e - s, 0) / span) * 100,
      isRunning,
      durationLabel: row.durationMs != null ? fmtDuration(row.durationMs) : "…",
      startLabel: fmtClock(new Date(s)),
      endLabel: isRunning ? "now" : fmtClock(new Date(e)),
    };
  });
}

// ── Shared-timeline axis ─────────────────────────────────────────────────────

function GanttAxis({ bars }: { bars: PhaseBar[] }) {
  // Pick 4–5 tick marks at even human-readable intervals.
  const starts = bars.map((b) => b.row.startedAt!).map((s) => Date.parse(s));
  const axisStart = Math.min(...starts);
  // axisEnd derived from bars' computed extents via leftPct+widthPct inverse:
  // since leftPct = (s - axisStart) / span * 100 and widthPct = (e - s) / span * 100,
  // span = (e - s) / (widthPct/100). Use durationMs as a proxy.
  // Simpler: re-derive span from bars themselves.
  const TERMINAL = new Set(["done", "complete", "failed", "blocked"]);
  const now = Date.now();
  const ends = bars.map((b) => {
    if (b.row.completedAt) return Date.parse(b.row.completedAt);
    if (!TERMINAL.has(b.row.status)) return now;
    return Date.parse(b.row.startedAt!);
  });
  const axisEnd = Math.max(...ends, axisStart + 1);
  const span = axisEnd - axisStart;

  // Pick interval: 5 / 10 / 15 / 30 / 60 min
  const minutes = span / 60000;
  const interval = minutes <= 20 ? 5 * 60000
    : minutes <= 60 ? 15 * 60000
    : minutes <= 120 ? 30 * 60000
    : 60 * 60000;

  const ticks: { leftPct: number; label: string }[] = [];
  const firstTick = Math.ceil(axisStart / interval) * interval;
  for (let t = firstTick; t <= axisEnd; t += interval) {
    ticks.push({ leftPct: ((t - axisStart) / span) * 100, label: fmtClock(new Date(t)) });
  }
  if (!ticks.length) return null;

  return (
    <div
      style={{
        position: "relative",
        height: 16,
        marginLeft: 82,
        marginRight: 148,
        marginBottom: 2,
        borderBottom: "1px solid rgba(255,255,255,0.08)",
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
            fontSize: 9,
            color: "rgba(255,255,255,0.3)",
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

export function TicketGantt({ ticket, phaseCosts }: TicketGanttProps) {
  const now = Date.now();
  const bars = buildBars(ticket.phaseSummary, now);

  if (!bars) {
    return (
      <EmptyState icon={BarChart3} message="No phase timing yet" />
    );
  }

  return (
    <div
      data-ticket-gantt
      style={{
        fontFamily: "monospace",
        padding: "8px 10px",
        borderRadius: 6,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      {/* Shared-timeline axis */}
      <GanttAxis bars={bars} />

      {bars.map(({ row, leftPct, widthPct, isRunning, durationLabel, startLabel, endLabel }) => {
        const pc = phaseCosts?.[row.phase] ?? null;
        const costLabel = pc && pc.costUSD > 0 ? fmtCost(pc.costUSD) : null;
        const tokLabel = pc && pc.tokens > 0 ? fmtTokens(pc.tokens) : null;

        return (
          <div
            key={row.phase}
            style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}
          >
            {/* Phase label */}
            <div
              style={{
                width: 74,
                flexShrink: 0,
                fontSize: 10,
                color: "rgba(255,255,255,0.55)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textAlign: "right",
                paddingRight: 6,
              }}
            >
              {row.phase}
            </div>

            {/* Bar track */}
            <div
              style={{
                flex: 1,
                position: "relative",
                height: 16,
                borderRadius: 3,
                background: "rgba(255,255,255,0.05)",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: leftPct.toFixed(2) + "%",
                  width: Math.max(widthPct, 0.5).toFixed(2) + "%",
                  background: phaseColor(row.phase),
                  borderRadius: 3,
                  opacity: isRunning ? 0.95 : 0.78,
                }}
                title={`${row.phase} · ${startLabel}–${endLabel} · ${durationLabel}${costLabel ? ` · ${costLabel}` : ""}${tokLabel ? ` · ${tokLabel}` : ""}`}
              >
                {isRunning && (
                  <div
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
              </div>
            </div>

            {/* Duration */}
            <div
              style={{
                width: 48,
                flexShrink: 0,
                fontSize: 10,
                opacity: 0.4,
                textAlign: "right",
                whiteSpace: "nowrap",
              }}
            >
              {durationLabel}
            </div>

            {/* CTL-953: per-phase cost + tokens (real from phaseCosts, dim when absent) */}
            <div
              data-gantt-cost={row.phase}
              style={{
                width: 56,
                flexShrink: 0,
                fontSize: 10,
                textAlign: "right",
                whiteSpace: "nowrap",
                color: costLabel ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.18)",
              }}
            >
              {costLabel ?? "—"}
            </div>

            {/* Per-phase model (CTL-915 / DETAIL4) */}
            <div
              data-gantt-model={row.phase}
              data-plumbed={row.model != null}
              title={row.model ? `model ${row.model}` : "no per-phase model in signal"}
              style={{
                width: 96,
                flexShrink: 0,
                fontSize: 10,
                opacity: row.model ? 0.6 : 0.28,
                textAlign: "right",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {phaseModelLabel(row.model)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
