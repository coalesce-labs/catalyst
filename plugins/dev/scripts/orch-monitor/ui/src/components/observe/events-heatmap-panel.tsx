// events-heatmap-panel.tsx — the TELEMETRY P5 panel body (OBS-8): events/min
// heatmap, workers × time. Rows = board worker sessions, columns = 15m buckets,
// each cell's opacity encodes how many claude-code lines that session emitted in
// that window — the SAME 5-level ramp over var(--chart-1) as calendar-heatmap.tsx
// (Principle 8: opacity over ONE token, never a hardcoded color).
//
// This is a thin SKIN over the pure buildHeatmapModel — every numeric/ordering
// decision lives in events-heatmap-data.ts. We render our own grid (rather than
// reuse <CalendarHeatmap> directly) for one reason: a `running` worker that has
// gone silent in its most-recent bucket is the early-STALL signal (design §3.1),
// and that needs a per-ROW status accent the bare CalendarHeatmap doesn't carry.
// The opacity ramp itself is imported from calendar-heatmap.tsx so the two
// heatmaps stay byte-identical on the color math (single source of truth).

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import {
  HEATMAP_OPACITY_RAMP,
  heatmapBucket,
} from "./calendar-heatmap";
import {
  buildHeatmapModel,
  bucketLabel,
  type HeatmapWorkerRef,
} from "./events-heatmap-data";
import type { EventsHeatmap } from "@/lib/types";

export interface EventsHeatmapPanelProps {
  payload: EventsHeatmap | null;
  workers: HeatmapWorkerRef[];
  /** Cell click → drill the P1 tail to that worker/session at that 15m window.
   *  `bucketStart` is epoch seconds (the column key). */
  onCellClick?: (sessionId: string, bucketStart: number) => void;
  /** A running-but-silent row → cross-link the FleetOps stuck list (design §3.1).
   *  Optional: wired when cheap, otherwise the row still renders its stall accent. */
  onStallClick?: (sessionId: string) => void;
}

export function EventsHeatmapPanel({
  payload,
  workers,
  onCellClick,
  onStallClick,
}: EventsHeatmapPanelProps) {
  const model = useMemo(
    () => buildHeatmapModel(payload, workers),
    [payload, workers],
  );

  // Column-axis labels are derived once (chronological — buckets are sorted asc).
  const colLabels = useMemo(
    () => model.buckets.map((b) => bucketLabel(b)),
    [model.buckets],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex items-center justify-between px-1 text-[10px] text-muted/70">
        <span>worker · events / 15m</span>
        <span>
          {colLabels.length > 0
            ? `${colLabels[0]} → ${colLabels[colLabels.length - 1]}`
            : "—"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-surface-2 p-2">
        <div className="flex flex-col gap-1">
          {model.rows.map((row) => (
            <div
              key={row.sessionId ?? row.label}
              className={cn(
                "flex items-center gap-2 rounded-sm py-0.5",
                // The early-stall accent: a running worker that's gone dark.
                row.silentWhileRunning && "bg-red/10 ring-1 ring-red/40",
              )}
            >
              {/* Row label + (when stalled) the cross-link affordance. */}
              <button
                type="button"
                onClick={
                  row.silentWhileRunning && row.sessionId && onStallClick
                    ? () => onStallClick(row.sessionId!)
                    : undefined
                }
                className={cn(
                  "flex w-28 shrink-0 items-center gap-1 truncate text-left font-mono text-[10px]",
                  row.silentWhileRunning ? "text-red" : "text-muted",
                  row.silentWhileRunning && onStallClick && "hover:underline",
                )}
                title={
                  row.silentWhileRunning
                    ? `${row.label} — running but silent (possible stall)`
                    : row.label
                }
              >
                {row.silentWhileRunning && (
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                )}
                <span className="truncate">{row.label}</span>
              </button>

              {/* The 15m cell strip. Opacity = the shared 5-level ramp over the
                  one chart token; a 0 cell is near-transparent silence. */}
              <div
                className="grid flex-1 gap-1"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(model.buckets.length, 1)}, minmax(6px, 1fr))`,
                }}
              >
                {model.buckets.map((bucketStart, i) => {
                  const v = row.counts[i] ?? 0;
                  const level = heatmapBucket(v, model.max);
                  // The newest column on a stalled running worker is the dark cell
                  // that triggered the flag — outline it so the silence is legible.
                  const isStallCell =
                    row.silentWhileRunning && i === model.buckets.length - 1;
                  return (
                    <button
                      key={bucketStart}
                      type="button"
                      onClick={
                        row.sessionId && onCellClick
                          ? () => onCellClick(row.sessionId!, bucketStart)
                          : undefined
                      }
                      title={`${row.label} · ${bucketLabel(bucketStart)}: ${v} events`}
                      className={cn(
                        "aspect-square min-h-[10px] rounded-[2px]",
                        isStallCell && "ring-1 ring-red/60",
                      )}
                      style={{
                        backgroundColor: "var(--chart-1)",
                        opacity: HEATMAP_OPACITY_RAMP[level],
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
