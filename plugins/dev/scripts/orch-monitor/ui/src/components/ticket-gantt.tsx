import { BarChart3 } from "lucide-react";
import { phaseColor, fmtDuration, fmtClock, phaseModelLabel } from "@/lib/formatters";
import { EmptyState } from "./ui/empty-state";
import type { BoardTicket, BoardPhaseTiming } from "@/board/types";

// kibo-ui/gantt is a scheduler-oriented component (day/month/quarter ranges)
// that does not cleanly express absolute-minute precision within a single ticket
// lifetime. We use computed CSS offsets against the ticket's own time span
// instead, modeled on the existing GanttChart bar-track pattern.

interface TicketGanttProps {
  ticket: BoardTicket;
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

function buildBars(rows: BoardPhaseTiming[], now: number): PhaseBar[] | null {
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

export function TicketGantt({ ticket }: TicketGanttProps) {
  const now = Date.now();
  const bars = buildBars(ticket.phaseSummary, now);

  if (!bars) {
    return (
      <EmptyState icon={BarChart3} message="No phase timing yet" />
    );
  }

  return (
    <div style={{ fontFamily: "monospace" }}>
      {bars.map(({ row, leftPct, widthPct, isRunning, durationLabel, startLabel, endLabel }) => (
        <div
          key={row.phase}
          style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}
        >
          <div
            style={{
              width: 80,
              flexShrink: 0,
              fontSize: 11,
              opacity: 0.75,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.phase}
          </div>

          {/* Bar track */}
          <div
            style={{
              flex: 1,
              position: "relative",
              height: 14,
              borderRadius: 3,
              background: "rgba(255,255,255,0.06)",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: leftPct.toFixed(2) + "%",
                width: Math.max(widthPct, 1).toFixed(2) + "%",
                background: phaseColor(row.phase),
                borderRadius: 3,
                opacity: isRunning ? 0.9 : 0.75,
              }}
              title={`${row.phase} · ${startLabel}–${endLabel} · ${durationLabel}`}
            >
              {isRunning && (
                /* running-phase pulse marker */
                <div
                  style={{
                    position: "absolute",
                    inset: "0 0 0 auto",
                    width: 3,
                    background: "rgba(255,255,255,0.4)",
                    borderRadius: "0 3px 3px 0",
                    animation: "gantt-pulse 1.4s ease-in-out infinite",
                  }}
                />
              )}
            </div>
          </div>

          <div
            style={{
              width: 60,
              flexShrink: 0,
              fontSize: 10,
              opacity: 0.45,
              textAlign: "right",
              whiteSpace: "nowrap",
            }}
          >
            {durationLabel}
          </div>

          {/* Per-phase model (CTL-915 / DETAIL4): the SAME phaseModelLabel the
              lifecycle spine renders, off this row's BoardPhaseTiming.model
              (BFF6). Dimmer when the phase signal carried none — never the
              ticket-level model. */}
          <div
            data-gantt-model={row.phase}
            data-plumbed={row.model != null}
            title={row.model ? `model ${row.model}` : "no per-phase model in signal"}
            style={{
              width: 96,
              flexShrink: 0,
              fontSize: 10,
              opacity: row.model ? 0.6 : 0.35,
              textAlign: "right",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {phaseModelLabel(row.model)}
          </div>
        </div>
      ))}
    </div>
  );
}
